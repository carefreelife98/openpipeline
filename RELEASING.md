# Releasing OpenPipeline

The 9 `@openpipeline/*` packages are published together, in lockstep, at the same
version (currently `0.2.x`). Internal dependencies use `workspace:*`, which **pnpm
rewrites to the exact published version** at pack time. A bare `npm pack`/`npm
publish` run directly against a workspace `package.json` does **not** do this
rewrite and would ship a literal `workspace:*`, breaking every consumer's install
with `EUNSUPPORTEDPROTOCOL`.

## Rules

1. **Always pack/publish through `pnpm pack` for the workspace rewrite.** The
   `workspace:*` → concrete-version rewrite happens when pnpm _packs_ the tarball,
   not when something later uploads it. Both the CI trusted-publishing pipeline and
   the manual fallback below produce tarballs via `pnpm pack`/`pnpm publish` —
   never a bare `npm pack`/`npm publish` against workspace source. See
   [Why this still holds in CI](#why-npm-publish-tarball-in-ci-still-honors-this-rule)
   below for exactly how the CI flow satisfies this rule despite using `npm
publish` as its upload command.
2. Keep `workspace:*` in source — do not hand-edit to `^0.2.0`. pnpm handles it.
3. Publish in dependency order (leaf-first) so each dependent's rewritten pins
   already resolve on the registry:
   `core → nodes → planner → mcp → store-memory → store-prisma → react → runtime → server`.
4. CI's `publish-guard` job (`.github/workflows/ci.yml`) asserts no packed tarball
   contains the `workspace:` protocol — it runs on every push/PR to `main`,
   independent of releasing.

## Primary flow: CI, via Trusted Publishing (no manual OTP)

Releases are cut by pushing a tag; `.github/workflows/release.yml` does the rest
end-to-end, authenticating to npm via OIDC ("Trusted Publishing") instead of a
long-lived token or an interactive OTP prompt.

```bash
# 1. Green baseline locally first (same gates CI re-runs, catch failures early)
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:ci && pnpm example

# 2. Bump all 9 packages to the new version, in lockstep, e.g. 0.2.1
#    (edit each packages/*/package.json "version", or use a script)

# 3. Commit the bump
git commit -am "chore(release): v0.2.1"
git push origin main

# 4. Tag and push the tag -- this is what triggers release.yml
git tag v0.2.1
git push origin v0.2.1
```

Pushing the tag runs two jobs on GitHub Actions:

- **`verify-gate`** — `pnpm install --frozen-lockfile` → `pnpm build` →
  `pnpm typecheck` → `pnpm test:ci` → asserts every `packages/*/package.json`
  `version` equals the tag (`vX.Y.Z` ↔ `X.Y.Z`), failing loud on any mismatch.
- **`publish`** (only if `verify-gate` is green) — `pnpm -r --filter
./packages/* pack` into `.release-tarballs/`, then `npm publish` on each
  tarball, leaf-first, authenticated via OIDC. No npm token, no OTP, no
  `secrets:` usage anywhere in the workflow.

**One-time prerequisite:** each of the 9 packages must have Trusted Publishing
configured on npmjs.com _before_ the first tag-triggered release — see
[`docs/trusted-publishing-setup.md`](docs/trusted-publishing-setup.md) for the
step-by-step setup and verification.

After the workflow finishes:

```bash
npm view @openpipeline/runtime version
npm view @openpipeline/runtime dependencies   # should show concrete @openpipeline/* pins
npm view @openpipeline/runtime dist.tarball    # provenance-signed; check the "Provenance" badge on npmjs.com
```

## Fallback: manual publish (no CI, or trusted publishing unavailable)

Use this only if CI can't run or Trusted Publishing needs to be bypassed
(e.g. npm outage affecting OIDC, or debugging a publish locally). This path
uses a classic npm token/OTP, exactly like before this pipeline existed.

```bash
# 1. Green baseline (build BEFORE typecheck — internal types come from dist/)
pnpm install --frozen-lockfile
pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:ci && pnpm example

# 2. Bump all 9 packages to the new version (lockstep), e.g. 0.2.1
#    (edit each packages/*/package.json "version", or use a script)

# 3. Dry-run pack and inspect one tarball
pnpm -r --filter ./packages/* pack --pack-destination /tmp/owf
tar -xzOf /tmp/owf/openpipeline-runtime-*.tgz package/package.json   # deps must be concrete (no workspace:)

# 4. Publish in dependency order (pnpm handles ordering automatically)
pnpm -r --filter ./packages/* publish

#    Manual leaf-first order, if publishing package-by-package by hand:
#    core -> nodes -> planner -> mcp -> store-memory -> store-prisma -> react -> runtime -> server

# 5. Verify on the registry
npm view @openpipeline/runtime version
npm view @openpipeline/runtime dependencies   # should show concrete @openpipeline/* pins
```

## Why `npm publish <tarball>` in CI still honors this rule

The release workflow's `publish` job does two separate steps, in this order:

1. `pnpm -r --filter ./packages/* pack --pack-destination .release-tarballs` —
   pnpm reads each workspace `package.json`, rewrites every `workspace:*`
   `@openpipeline/*` dependency to the concrete version being released, and
   writes that already-rewritten `package.json` **into the tarball**. This is
   the same rewrite `pnpm publish` does; `pnpm pack` performs it too, because
   packing and publishing share the same manifest-preparation step in pnpm.
2. `npm publish .release-tarballs/openpipeline-<pkg>-<version>.tgz` — the npm
   CLI uploads that tarball's bytes as-is. It does **not** re-read the
   workspace source `package.json` and does not re-resolve dependency
   specifiers; it only unpacks and republishes what's already inside the
   `.tgz`. There is no step at which `workspace:*` could leak back in.

In other words: the rewrite that matters happens at **pack** time, not at
**upload** time, so swapping the final upload command from `pnpm publish` to
`npm publish <tarball>` (necessary because the npm CLI, not pnpm, is what
performs the OIDC trusted-publisher exchange) does not reopen the
`EUNSUPPORTEDPROTOCOL` risk Rule 1 exists to prevent. `pnpm pack` is a hard
requirement of the pipeline for exactly this reason — see the `if [ ! -f
"$tarball" ]` guard and the pack step in `release.yml`.

## Not yet adopted (deferred)

- **Changesets / semantic-release** — overkill while all 9 move in lockstep. Adopt
  once versions diverge.
- **Dual ESM/CJS** — packages are intentionally ESM-only (`type: module`). Revisit
  if a CJS-only consumer needs it.
- **GitHub Environment gating on the `publish` job** — Trusted Publishing is
  currently configured with a blank environment for all 9 packages (see
  `docs/trusted-publishing-setup.md`). Adding a required-reviewers GitHub
  Environment is a reasonable future hardening step, but requires updating
  both `release.yml` (`environment:` key on the `publish` job) and every
  package's Trusted Publisher config on npmjs.com in lockstep — deferred
  until actually needed.

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
