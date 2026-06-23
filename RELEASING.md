# Releasing OpenPipeline

The 8 `@openpipeline/*` packages are published together, in lockstep, at the same
version (currently `0.1.x`). Internal dependencies use `workspace:*`, which **pnpm
rewrites to the exact published version** at pack/publish time. Plain `npm publish`
does **not** do this rewrite and would ship a literal `workspace:*`, breaking every
consumer's install with `EUNSUPPORTEDPROTOCOL`.

## Rules

1. **Always publish with pnpm. Never `npm publish`.**
2. Keep `workspace:*` in source — do not hand-edit to `^0.1.0`. pnpm handles it.
3. Publish in dependency order (leaf-first) so each dependent's rewritten pins
   already resolve on the registry. `pnpm -r --filter ./packages/* publish` does
   this automatically.
4. CI's `publish-guard` job asserts no packed tarball contains the `workspace:`
   protocol — it must be green before publishing.

## Procedure

```bash
# 1. Green baseline (build BEFORE typecheck — internal types come from dist/)
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:ci && pnpm example

# 2. Bump all 8 packages to the new version (lockstep), e.g. 0.1.1
#    (edit each packages/*/package.json "version", or use a script)

# 3. Dry-run pack and inspect one tarball
pnpm -r --filter ./packages/* pack --pack-destination /tmp/owf
tar -xzOf /tmp/owf/openpipeline-runtime-*.tgz package/package.json   # deps must be concrete (no workspace:)

# 4. Publish in dependency order
pnpm -r --filter ./packages/* publish

#    Manual fallback (leaf-first):
#    core -> nodes -> runtime -> mcp -> store-memory -> store-prisma -> react -> server

# 5. Verify on the registry
npm view @openpipeline/runtime version
npm view @openpipeline/runtime dependencies   # should show concrete @openpipeline/* pins
```

## First publish

Nothing is on npm yet, so the **first** publish must respect the leaf-first order
or dependents will 404 on their `@openpipeline/*` deps. `pnpm -r publish` handles
ordering; if publishing by hand, follow the order above.

## Not yet adopted (deferred)

- **Changesets / semantic-release** — overkill while all 8 move in lockstep. Adopt
  once versions diverge.
- **Dual ESM/CJS** — packages are intentionally ESM-only (`type: module`). Revisit
  if a CJS-only consumer needs it.

## Prisma 7 migration (deferred to store-prisma v1.0)

`@openpipeline/store-prisma` is pinned to **Prisma 6** (peer `@prisma/client: ">=5 <7"`).
Prisma 7 is a **breaking** change for this package and is deliberately deferred —
a single shipped `schema.prisma` cannot serve both majors, because each of these
is single-valued and mutually exclusive across the boundary:

1. **Generator** — `prisma-client-js` (v6) → `prisma-client` (v7, ESM/no-engine).
2. **Datasource `url`** — required in-schema (v6) → removed, lives in
   `prisma.config.ts` + `dotenv` (v7).
3. **Driver adapter** — optional (v6) → mandatory `new PrismaClient({ adapter: new PrismaPg(...) })` (v7).

When v7 is adopted (a `store-prisma` **v1.0**, peer `>=7`), the migration must:

- Swap the generator block (`prisma-client`, `runtime`/`moduleFormat`), strip
  `url` from the datasource, add `packages/store-prisma/prisma.config.ts`.
- Add `@prisma/adapter-pg` + `pg` + `dotenv`; update `examples/prisma` to the
  adapter-wired `PrismaClient` construction.
- **Re-verify the atomic raw-SQL cost update** (`$executeRawUnsafe` in
  `updateRunCostAtomic`) against a **real Postgres** through `@prisma/adapter-pg`
  — the v7 adapter binds JS ints differently than the v6 Rust engine, so the
  `(cost->...)::int + $N` path is NOT proven safe until tested live. This is a
  hard gate for the v1.0 PR, not assumed.
- Confirm the structural `PrismaClientLike` (`src/prisma-types.ts`) still matches
  the v7-generated client's delegate signatures.
