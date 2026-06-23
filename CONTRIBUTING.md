# Contributing to OpenPipeline

Thanks for your interest in OpenPipeline. This is a small, focused engine — a
clean, framework-agnostic core with adapters around it. Contributions that keep
that boundary sharp are very welcome.

## Prerequisites

- **Node ≥ 22.12** (the `engines` floor; Node 20 is EOL). Use the version in
  [`.nvmrc`](./.nvmrc) if present, or any 22.12+/24 LTS.
- **pnpm 10** (`corepack enable` picks up the pinned version).

```bash
pnpm install
pnpm build        # build first — internal @openpipeline/* types come from dist/
pnpm typecheck    # ⚠️ must run AFTER build (see "Build order" below)
pnpm test
```

See the [README Quickstart](./README.md#quickstart) to run the engine end to end.

## Build order (the one trap to know)

Internal packages depend on each other through their **built** types
(`dist/*.d.ts`), so the order is fixed:

```
pnpm build  →  pnpm typecheck  →  pnpm test
```

Running `typecheck` on a clean checkout before `build` fails with
`TS2307 Cannot find module '@openpipeline/core'`. CI enforces this order; do the
same locally.

## Workflow

1. **Branch** off `main`. Name it `<type>/<scope>/<short-desc>`, e.g.
   `feat/nodes/retry-policy`, `fix/server/sse-flush`, `chore/deps/bump-zod`.
2. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(scope): …`, `fix(scope): …`, `chore: …`, `test: …`, `refactor: …`,
   `docs: …`, `build: …`. Keep the subject imperative and < 72 chars.
3. A **pre-commit hook** (husky + lint-staged) runs ESLint + Prettier on staged
   files. Don't bypass it with `--no-verify` — if it complains, fix the cause.
4. **Open a PR** against `main`. Fill in the template. CI must be green.

## Quality bar (what CI checks)

| Command                         | Gate                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                     | ESLint 9, **strictTypeChecked** — type-aware, zero violations. No `eslint-disable`/`as any` to dodge; fix the root cause. |
| `pnpm format:check`             | Prettier — formatting is owned by Prettier, not ESLint.                                                                   |
| `pnpm build` / `pnpm typecheck` | 8/8 packages.                                                                                                             |
| `pnpm test:ci`                  | Vitest + per-package coverage thresholds (a regression floor — don't lower it to pass).                                   |
| example smokes                  | `quickstart`/`mcp`/`prisma`/`server` run to `SUCCESS`; `playground` builds.                                               |

Run them all locally before pushing:

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:ci
```

## Architecture rules (please respect)

- **The kernel depends only on `@langchain/*` + `zod`.** `core`/`nodes`/`runtime`
  must not import NestJS, Prisma, or any proprietary library. Framework coupling
  lives in the adapter packages (`store-prisma`, `server`, `react`).
- **No multi-tenancy in core.** `companyId`/`scope`/permissions belong in the
  host adapter; `userId` is an opaque, FK-less audit string.
- **ESM-only, `"type": "module"`** across every package.
- **Tests** live in each package's `test/` dir (sibling of `src/`), never inside
  `src/` (they must not ship in `dist/`). Import source via `../src/<file>.js`.

## Adding a node

Author nodes with `defineNode({ key, nodeType, inputSchema, outputSchema, handler })`
(see [README Concepts](./README.md#concepts)). That's the public plugin API —
prefer it over reaching into kernel internals.

## Releasing

Maintainers: see [RELEASING.md](./RELEASING.md).
