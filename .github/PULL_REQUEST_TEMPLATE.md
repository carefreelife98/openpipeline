<!-- Title: Conventional Commit style, e.g. "feat(nodes): retry policy" -->

## What & why

<!-- One or two sentences: what this changes and the motivation. -->

## Type

- [ ] feat
- [ ] fix
- [ ] refactor
- [ ] test
- [ ] docs
- [ ] chore / build

## Scope

<!-- Which package(s) / area: core, nodes, runtime, mcp, store-*, server, react, examples, ci, docs -->

## Checklist

- [ ] `pnpm build && pnpm typecheck` — 8/8 (build before typecheck)
- [ ] `pnpm lint && pnpm format:check` — clean
- [ ] `pnpm test:ci` — passing, coverage thresholds met
- [ ] Example smokes still green if touched (`quickstart`/`mcp`/`prisma`/`server`; `playground` builds)
- [ ] Kernel purity preserved — `core`/`nodes`/`runtime` still depend only on `@langchain/*` + `zod`
- [ ] No `eslint-disable` / `as any` / silent catch added to dodge a check
- [ ] Docs updated if behavior or the public API changed

## Notes for the reviewer

<!-- Anything to call out: a deliberate trade-off, a follow-up registered, a risky area. -->
