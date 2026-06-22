# Releasing OpenWorkflow

The 8 `@openworkflow/*` packages are published together, in lockstep, at the same
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
# 1. Green baseline
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm example

# 2. Bump all 8 packages to the new version (lockstep), e.g. 0.1.1
#    (edit each packages/*/package.json "version", or use a script)

# 3. Dry-run pack and inspect one tarball
pnpm -r --filter ./packages/* pack --pack-destination /tmp/owf
tar -xzOf /tmp/owf/openworkflow-runtime-*.tgz package/package.json   # deps must be concrete (no workspace:)

# 4. Publish in dependency order
pnpm -r --filter ./packages/* publish

#    Manual fallback (leaf-first):
#    core -> nodes -> runtime -> mcp -> store-memory -> store-prisma -> react -> server

# 5. Verify on the registry
npm view @openworkflow/runtime version
npm view @openworkflow/runtime dependencies   # should show concrete @openworkflow/* pins
```

## First publish

Nothing is on npm yet, so the **first** publish must respect the leaf-first order
or dependents will 404 on their `@openworkflow/*` deps. `pnpm -r publish` handles
ordering; if publishing by hand, follow the order above.

## Not yet adopted (deferred)

- **Changesets / semantic-release** — overkill while all 8 move in lockstep. Adopt
  once versions diverge.
- **Dual ESM/CJS** — packages are intentionally ESM-only (`type: module`). Revisit
  if a CJS-only consumer needs it.
