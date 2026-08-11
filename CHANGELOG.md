# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
All 9 `@openpipeline/*` packages (`core`, `nodes`, `planner`, `runtime`, `mcp`,
`store-memory`, `store-prisma`, `react`, `server`) are versioned in
**lockstep** — one version number for the whole set, published together (see
[RELEASING.md](./RELEASING.md)).

## [0.6.1] - 2026-08-11 - 0.6.1

### Fixed (all packages)

- **CJS hosts on Node ≥22.12 can now `require()` the packages.** Every
  package's `exports` map declared only the `import` condition, so a
  CommonJS `require('@openpipeline/…')` failed at exports resolution with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` — before Node's `require(esm)` support
  (which loads ESM-only code from CJS just fine, absent top-level `await`)
  ever got a chance to run. Each conditional exports entry now adds a
  `default` condition pointing at the same ESM file, letting CJS resolution
  succeed and `require(esm)` take over from there. Discovered embedding the
  packages into a CommonJS NestJS host; the packages remain ESM-only — no
  CJS build is shipped, so `require()` still needs Node ≥22.12 and no
  top-level await (both already true of these packages).

## [0.6.0] - 2026-08-11 - 0.6.0

Pipeline-level ownership attribution and first-class support for Prisma 7
hosts. Both changes are additive; no behavior changes for callers that omit
the new field.

### Added (`@openpipeline/core`, `@openpipeline/store-memory`, `@openpipeline/store-prisma`)

- **`PipelineDraft.userId` / `PipelineRow.userId`** — an optional opaque audit
  string identifying who owns/created a pipeline, the pipeline-level mirror of
  the `RunCreate.userId` / `PipelineRun.userId` pair that has existed since
  0.1.0. Semantics are identical: no FK, no tenancy meaning, the engine never
  reads it — stores persist it and surface it on `load()`, so a host can
  enforce ownership without a second query (its own schema MAY back the column
  with a real foreign key; the stores don't care). Attribution is **sticky on
  update**: a `save()` whose draft leaves `userId` `undefined` keeps the
  persisted value instead of clobbering it; only an explicitly supplied value
  (including `''`) overwrites. Both reference stores implement this
  identically; the shipped `schema.prisma` gains the matching nullable
  `pipeline.user_id` column plus an index (additive migration for existing
  deployments).

### Changed (`@openpipeline/store-prisma`)

- **Prisma 7 hosts are now supported — peer range widened from
  `@prisma/client ">=5 <7"` to `">=5 <8"`.** The adapter never imports
  `@prisma/client`; it depends only on the structural `PrismaClientLike`
  interface, which a v7-generated client satisfies. The shipped
  `schema.prisma` remains in the Prisma 6 form (the two majors' schema
  formats are mutually exclusive — see RELEASING.md § "Prisma 7"): a v7 host
  copies the models/enums into its own schema (model names verbatim — the
  delegate property names derive from them; extra host columns such as real
  FKs are invisible to the store) and passes its own generated client.
  Caveat for v7 hosts to verify in their integration tests: the atomic
  raw-SQL cost update (`updateRunCostAtomic`) now runs through a mandatory
  driver adapter (e.g. `@prisma/adapter-pg`), whose parameter binding differs
  from the v6 Rust engine; the `(cost->...)::int + $N` path should be
  exercised against a real Postgres before production use.

## [0.5.1] - 2026-07-31 - 0.5.1

A quality-hardening batch over the 0.5.0 planner port: 7 deferred findings
from that release's final review, each judged worth fixing on its own merits
(dedupe/leak/routing correctness, one bound API-shaped design decision, one
typed error, one opt-in store option) rather than shipped speculatively.

### Added (`@openpipeline/planner`)

- **`PlannerExhaustedError`** (`extends Error`, `name: 'PlannerExhaustedError'`,
  `readonly attempts: number`, `readonly lastIssues?: GraphValidationIssue[]`,
  exported from `@openpipeline/planner`) — `PipelinePlanner.plan()` throws
  this, instead of a bare `Error`, when the `design -> validate -> correct`
  loop exhausts every attempt without EVER producing a single `PlannerDraft`
  (every attempt failed `PlannerDraftSchema.parse`). The message now also
  names the attempt count (`planning finished with no draft produced after
<N> attempt(s).` — the old message, `planning finished with no draft
produced.`, had no attempt count and a different trailing period
  placement, so a consumer matching the old text breaks). Classify this
  programmatically via `instanceof PlannerExhaustedError` — never by matching
  the message text, which is not a stable contract. A caller catching
  `Error` still catches this; a caller wanting the attempt count or the
  accumulated schema-failure issues no longer has to parse the message for
  them. The OTHER exhaustion shape — a draft exists but never validates
  cleanly — is unchanged: `plan()` still resolves normally for that case,
  with `PlannerResult.unresolvedValidationErrors` set, never a throw
  (`PipelineNotFoundError` precedent style — see the 0.4.0 entry below).

### Changed (`@openpipeline/planner`)

- **`select` node: `catalogLoader.load()` failure now degrades to
  static-spec planning with a warning (DESIGN DECISION).** A rejecting
  `load()` was previously unguarded and took the whole `plan()` call down
  with it. It is now fail-soft: the raw error is preserved via `logger.warn`
  (never silently dropped), a `plannerWarning` naming the failure is
  appended (`[select] MCP catalog unavailable: <msg>; proceeding to design
with static specs only.`), and the run proceeds using only the static
  `NodeSpec` catalog — the `select` LLM is never even invoked, since there is
  no catalog to choose from. No distinction is drawn between a transport
  failure and a defect inside a caller-supplied loader; both degrade
  identically. `PipelineAbortedError` is the one exception — a
  caller-requested cancellation, not a catalog failure — and keeps
  propagating unchanged. Rationale: MCP tool selection is an optional
  enhancement over the always-available static-spec design path, matching
  every other fail-soft boundary this package already has (a `select`
  resolution failure, a malformed structured-output response, a rejecting
  cleanup) — a catalog outage should degrade the plan, not abort it.
  **A failed `load()` is not cached** — `runtime.mcpCatalogBox.loaded` is
  only assigned after a successful `load()` resolves — so this modifies the
  existing "catalog loaded at most once per `plan()` call" guarantee
  (`packages/planner/README.md`): that guarantee now holds on the success
  path only. A later `select` re-entry after a failed load (e.g. a
  validation error naming an unresolved `mcp:` key routing back from
  `correct`) calls `catalogLoader.load()` again and pays the full transport
  cost a second time.
- **`select` node: duplicate `selectedKeys` from the model are deduped before
  resolving.** A response repeating the same `mcp:<provider>:<tool>` key
  previously cost one `mcpNodeResolver.resolveSpec` round trip PER repeat,
  and, on a resolve failure, one duplicate `plannerWarning` per repeat within
  the same attempt. Deduped once, immediately after the catalog-membership
  filter.
- **`select` node: `checkAbort` is now also checked before the same-input
  retry and before each key's `resolveSpec` call inside the resolve loop**
  (previously only at the node's own entry). An abort landing inside either
  loop is now caught at the next iteration/retry boundary instead of only at
  the next node's entry, several steps later.
- **`correct` node: a `designError` round now routes to `'design'`
  unconditionally**, without first checking whether `state.validationIssues`/
  `state.draft` reference an unresolved `mcp:` key. On a `designError` round
  (this round's `design` call failed to parse — `validate` never even ran),
  those two fields are stale leftovers from an EARLIER round (`design.node.ts`'s
  catch branch only appends to `validationIssues` and never touches `draft`),
  so checking them was both wasted work and could wrongly route back to
  `'select'` over a schema-shape defect that re-selecting a tool cannot fix.

### Fixed

- **`@openpipeline/mcp`**: `createEnvCatalogLoader`'s `load()` no longer
  leaks already-opened `MultiServerMCPClient` connections when a LATER
  server's step (e.g. `getRawSchemas`) rejects mid-load. Previously the
  `cleanup()` closure was only ever returned on a fully successful `load()`,
  so a partial failure after some clients were already created left them
  open with nothing left to ever call `.close()` on them. `load()` now closes
  every client opened so far (best-effort, logged via `logger.warn`, never
  masking the original error) before rethrowing.
- **`@openpipeline/react`**: `BuilderState.loadDraft(draft, opts?: { dirty?:
boolean })` — a new, optional, back-compat second argument (default
  `dirty: false`, matching the prior unconditional behavior exactly). A
  loaded draft always landed `dirty: false` regardless of caller context,
  which pushed at least one downstream consumer (a scheduler replaying a
  not-yet-persisted draft) to bypass the store's own action and call
  `store.setState({ dirty: true })` directly. `opts.dirty: true` now covers
  that case through the documented action instead.

## [0.5.0] - 2026-07-29

### Added (`@openpipeline/planner`)

- **New package.** Natural-language pipeline planner: an LLM-driven,
  **5-node LangGraph loop** (`intent -> select -> design -> validate ->
correct`) that turns an instruction plus a `NodeSpec` catalog into a valid
  `@openpipeline/core` `PipelineDraft` — short-id-based LLM output remapped
  to stable UUIDs across correction rounds (survives a reused short id
  turning into the same persisted id), **deterministic auto-fill** for
  generic-unknown-output MCP specs (wires an unmapped required slot to its
  single predecessor when the shape is unambiguous — never a silent guess
  when it isn't), and a simple layered advisory layout (no `dagre`
  dependency). Two paths through the same compiled graph:
  - **No-MCP (static specs only), the default.** Omitting
    `catalogLoader`/`mcpNodeResolver` runs the original 3-super-step
    `design -> validate -> correct` loop against the `NodeSpec`s passed to
    the constructor — `intent`/`select` aren't even added to the compiled
    graph on this path.
  - **MCP tool selection (`intent -> select`), opt-in.** Passing
    `catalogLoader` and `mcpNodeResolver` together (both are required — the
    constructor throws if only one is supplied) enables a catalog-gated
    `intent -> select` path ahead of `design`: `intent` decides whether the
    instruction needs an MCP tool at all (`needsMcp: false` skips `select`'s
    catalog load and LLM call entirely), `select` picks
    `mcp:<provider>:<tool>` keys from the loaded catalog and resolves each
    one independently, and a correction-loop validation error naming an
    unresolved `mcp:` key routes back to `select` instead of `design` so the
    model gets another chance. A `select` re-entry within the same `plan()`
    call always merges with (never replaces) an earlier round's resolved
    specs, keyed by spec key. The loaded catalog's `cleanup()` runs exactly
    once per `plan()` call, on every exit path (success, failure, or abort).
  - **Fail-soft everywhere, never a silent drop.** A malformed structured
    output from `intent`/`select`/`design` degrades (one same-input retry for
    `select`; straight to `correct`, skipping `validate`, for `design`)
    instead of rejecting `plan()` outright; a `select` resolution failure
    drops only that one key, never the others. Every degradation is recorded
    in `plannerWarnings` (D7 — appended across the whole run, never
    overwritten), and the loop only surfaces an error when it exhausts every
    attempt with no draft ever produced at all — an exhausted-but-drafted run
    still resolves normally, with `unresolvedValidationErrors` set instead of
    a throw.
- **`examples/planner-quickstart`** demonstrates the full
  instruction -> `plan()` -> `engine.save()` -> `engine.run()` flow end to
  end, deterministically and with zero API keys (a bundled minimal fake
  structured-output model); the root and `packages/planner` READMEs link to
  it and cover the real-LLM/MCP-path setup.

### Development (no package behavior change)

- **Test files now type-checked too.** `pnpm typecheck` now also type-checks
  every package's `test/**` sources, via a new `tsconfig.test.json` in each
  of the 9 packages (wired into each package's own `typecheck` script,
  `exclude: []` to undo `tsconfig.base.json`'s test-file exclusion).
  Previously only `pnpm lint`'s type-aware ESLint program ever touched test
  files, and in an environment where that program's `@types/node` resolution
  is degraded it could silently fall back to non-type-aware linting and
  report zero problems for a test file that genuinely doesn't type-check.
  `@types/node` was added to root `devDependencies` so this gate is real
  everywhere, not just where `pnpm lint`'s program happens to resolve
  correctly.

## [0.4.0] - 2026-07-28

### Added (`@openpipeline/core`)

- **`PipelineNotFoundError`** (`extends Error`, `name: 'PipelineNotFoundError'`,
  message `Pipeline not found: <id>`, carries `readonly pipelineId: string`) —
  lets consumers distinguish "pipeline does not exist" from infrastructure
  failures (DB outage, connection error, etc.). Previously both surfaced as a
  plain `Error`, so a downstream consumer classifying `engine.load`'s
  rejection as a 404 by presence-of-error-alone would misclassify a DB outage
  the same way.

### Changed

- **`@openpipeline/store-memory`**: `MemoryStore.load` now throws
  `PipelineNotFoundError` (was a plain `Error`) for an unknown `pipelineId`.
  The message is unchanged (`Pipeline not found: <id>`); only the thrown
  type is more specific — a caller catching `Error` still catches this.
- **`@openpipeline/store-prisma`**: `PrismaPipelineStore.load` throws the same
  typed `PipelineNotFoundError` for an unknown `pipelineId`. No other throw
  site in either store was converted — `store-prisma`'s cross-pipeline
  node-id ownership guard (`assertNodeIdsBelongToPipeline`) is a distinct
  failure mode (constraint violation, not "pipeline does not exist") and is
  unchanged. `PrismaPipelineStore.save()` on a nonexistent `id` (the
  update path, `tx.pipeline.update`) is also unchanged: it still surfaces
  Prisma's own native `P2025` ("record not found") error, not
  `PipelineNotFoundError` — deliberately not converted, since
  `PrismaClientLike` (`prisma-types.ts`) is a hand-written structural
  interface with no dependency on the generated client's error classes, and
  duck-typing a Prisma error code off an untyped `unknown` catch value is
  exactly the kind of guess this package's structural-typing approach is
  meant to avoid.
- **`@openpipeline/runtime`**: no code change — `PipelineEngine.load` and
  `PipelineEngine.run` already propagate whatever `store.load` throws
  unwrapped, so `PipelineNotFoundError` reaches callers with its type intact.
  Documented behavior (verified, not assumed): `run()` calls
  `store.load(pipelineId)` **before** `store.createRun(...)` and before
  `execute()` is invoked, so a `PipelineNotFoundError` here rejects the
  `run()` call itself (the `Promise<RunHandle>` `run()` returns) — **not**
  the `done` promise on the resolved handle, and no run row is ever created
  for it. This is a different surface than a mid-run node failure (which a
  run row already exists for, and which `execute()`'s catch block classifies
  as a generic `FAILED` status instead of rejecting).
- **`@openpipeline/server`** (behavior change — previously `500`/`400`, see
  per-route notes below):
  - `GET /pipeline/:id` now returns **404** `{ error: "Pipeline not found: <id>" }`
    for a `PipelineNotFoundError` from `engine.load` (was a generic `500` via
    the top-level catch-all).
  - `POST /pipeline/run` now returns **404** for a `PipelineNotFoundError`
    from `engine.run` (was a generic `500`). It also now validates
    `pipelineId` the same way `POST /pipeline/run/stream` already did —
    **400** `{ error: "pipelineId is required and must be a non-empty string" }`
    for a missing/non-string `pipelineId`, checked before the engine is
    touched. This is a fix, not new-in-this-PR behavior drift: the
    `PipelineNotFoundError` wiring above would otherwise have turned a
    missing body field into a misleading 404 `Pipeline not found: undefined`
    instead of a 400.
  - `POST /pipeline/run/stream` now returns **404** (headers unsent, before
    any SSE frame) for a `PipelineNotFoundError` from `startRun` (was a
    generic `400` — see the 0.2.0 entry for why this route already validates
    before `res.writeHead`, #8). Any other `startRun` failure (validation,
    MCP catalog, infra) keeps the pre-existing `400`.
  - Any error that is **not** a `PipelineNotFoundError` (e.g. a DB
    connection failure) is unaffected by this change and keeps its prior
    status code (`500` for `GET /pipeline/:id` and `POST /pipeline/run`,
    `400` for `POST /pipeline/run/stream`) — infrastructure failures are
    never misclassified as 404.

## [0.3.0] - 2026-07-27

Dynamic MCP OAuth support in `@openpipeline/mcp`, plus release-infrastructure
changes (npm Trusted Publishing). Purely additive — no breaking changes; all
other packages are version-bumped in lockstep with no code changes.

### Added (`@openpipeline/mcp`)

- **`OAuthStateStore` seam + `InMemoryOAuthStateStore`** — a minimal key-value
  persistence interface for OAuth client info, tokens, PKCE verifiers, and
  discovery metadata. Host apps plug a DB-backed implementation; the bundled
  in-memory store is the reference.
- **`StoreBackedOAuthProvider` (+ `StoreBackedOAuthProviderOptions`)** — a
  store-backed `OAuthClientProvider` base class driving the MCP SDK's
  `auth()` flow (dynamic client registration, token persistence, PKCE).
  Store keys escape identity segments, so composite identities cannot
  collide (`a:b`+`c` vs `a`+`b:c`).
- **`createClient` accepts an `OAuthClientProvider`** as its auth argument —
  a string access token keeps working unchanged.
- **`CatalogPolicy.resolveAuthProvider` hook** — lets a host resolve a
  per-server/per-user `OAuthClientProvider` at catalog-load time; loader
  precedence is `resolveAuthProvider` → `resolveToken` → `server.accessToken`.
- **`authType: 'oauth_dynamic'`** on `McpServerConfig` for servers whose
  credentials come from a dynamic OAuth flow.

### Release infrastructure (no package behavior change)

- Releases are now published from CI via **npm Trusted Publishing (OIDC)** on
  `v*` tag push (`.github/workflows/release.yml`) — no tokens, no manual OTP.
  Manual `pnpm publish` remains documented as a fallback in `RELEASING.md`.

## [0.2.0] - 2026-07-27

Backport of the Mate-X production defect audit (26 findings) plus a graph
compile-time validation layer and a batch of kernel-hardening fixes found
during this release's own whole-branch review. No new public packages; no
dependency-surface changes outside the existing `@langchain/*` + `zod` (core
kernel) / `+@langchain/mcp-adapters` + `@modelcontextprotocol/sdk` (mcp)
boundary.

### Breaking Changes

- **`PipelineStore.completeRun(runId, result)` now returns `Promise<boolean>`**
  (was `Promise<void>`). `true` means this call performed the terminal
  RUNNING→SUCCESS/FAILED/ABORTED transition; `false` means the run was
  already terminal (first-terminal-wins) and the call was a no-op. Both
  bundled stores (`MemoryStore`, `PrismaPipelineStore`) implement the new
  contract; a custom `PipelineStore` implementation must be updated to return
  the boolean and to guard the transition itself (e.g. `UPDATE ... WHERE
status = 'RUNNING'` for a SQL-backed store).
- **`PipelineCompiler.compile(graph)` → `compile(graph, ctx)`.** The
  `setResolveContext(ctx)` method and the compiler's shared mutable
  `resolveContext` field are removed. `ctx: NodeResolveContext` is now a
  required-shape (defaults to `{}`), per-call second argument, eliminating a
  cross-run context-leak hazard on the long-lived `PipelineCompiler`
  instance. `PipelineEngine` already calls the new form internally; direct
  `PipelineCompiler` consumers must pass `ctx` as the second argument instead
  of calling `setResolveContext` beforehand.
- **`PipelineEngine.abort(runId)` now returns `boolean`** (was `void`).
  `true` if an in-flight run was found and abort was signaled; `false` for an
  unknown or already-finished `runId`. A new `isInFlight(runId): boolean`
  accessor was added alongside it.
- **`GET /pipeline/runs/:runId/stream` no longer starts a run.** It is now
  attach-only: it streams an _already in-flight_ run's SSE events, and 404s
  (headers unsent) for any `runId` that isn't currently running. **`POST
/pipeline/run/stream` is the new route that starts a run and streams it**
  — use it where the old `GET .../stream?pipelineId=...` was used to kick
  off a run. `POST /pipeline/run/:runId/abort` also 404s now for an unknown
  or already-finished run (previously a blanket `200`).

### Added

- `RunOptions.onEvent?: PipelineEventListener` on `PipelineEngine.run(...)` —
  registers the listener synchronously _before_ execution starts, closing a
  subscribe-gap window where the run's very first event(s) could be missed
  by a caller that subscribed via the separate `onEvent()` method after
  `run()` returned. Prefer this over calling `onEvent()` afterward.
- Compile-time graph validation (`validateGraph`, exported from
  `@openpipeline/nodes`): cycle detection, unreachable/orphan-node detection,
  node-type mismatches, missing required input slots, and dead state-path
  references are now caught at `compile()` time with a structured
  `PipelineCompileError` (same shape as the existing `TOPOLOGY_NO_ENTRY`/
  `IF_MISSING_BRANCH` errors) instead of surfacing later as an opaque
  LangGraph runtime failure.
- `PipelineEngineOptions.costCapUsd?: number` — per-run USD spend cap,
  checked at node boundaries; a run that crosses it fails with
  `error.kind: 'COST_CAP'`. See the README's "Engine options" table for the
  post-node-boundary limitation (the crossing node has already billed by the
  time the cap trips — this is a hard architectural boundary, not a bug).
- `PipelineEngineOptions.recursionLimit?: number` (default `100`) — max
  LangGraph super-steps per run; exceeding it now surfaces as a FAILED run
  with `error.code: 'RECURSION_LIMIT'` instead of an opaque
  `GraphRecursionError`.
- `PipelineEngineOptions.runTimeoutMs`: passing `0` now genuinely disables
  the wall-clock timeout (no timer armed at all) instead of firing
  immediately via `0 ?? 600_000` nullish-coalescing.
- `safeJson` (exported from `@openpipeline/core`) — used at both the
  per-node step-finish boundary and the run-level terminal write. Converts
  functions/symbols/bigints to explicit sentinel strings, breaks circular
  references path-locally (a shared, non-circular DAG reference is no longer
  misreported as circular), and gives `Date`/`Error`/`Map`/`Set` explicit,
  lossless-where-possible representations instead of silently collapsing to
  `{}`.
- MCP transport error classification + one bounded retry
  (`isRetryableMcpTransportError`/`parseMcpErrorCode`, internal to
  `@openpipeline/mcp`): a retryable MCP transport error (`-32000`/`-32001`)
  is retried exactly once before surfacing.
- MCP tool output validated against its declared output schema; a mismatch
  now throws a clear `MCP_OUTPUT_SCHEMA_MISMATCH` error instead of returning
  a value that silently violates the tool's own contract.
- MCP `$ref` circularity is now surfaced as an explicit `hadCircularRef`
  signal + `logger.warn`, alongside the existing (unchanged) lossy
  truncation to `{ type: 'object' }`.
- `NODE_FAILED` / `NODE_ABORTED` pipeline events are now emitted (with the
  failing `nodeId`, one event per attributable node — including under an
  `AggregateError` fan-out from a multi-node simultaneous failure) before
  `RUN_COMPLETE`, so a live SSE subscriber no longer sees a node stuck at
  `NODE_START` forever when it fails.

### Fixed

- **`@openpipeline/store-prisma`**: `serializeByRun`'s internal per-run
  promise chain no longer produces an unhandled promise rejection when the
  last queued write for a run rejects (was capable of crashing the host
  process under Node's default `--unhandled-rejections=throw`).
- **`@openpipeline/store-prisma`**: `updatePipeline`'s `updatedAt` is now
  computed monotonically (`max(now, previous + 1ms)`) instead of relying on
  Postgres's millisecond-resolution `@updatedAt` auto-timestamp, so two
  updates in the same wall-clock millisecond no longer collide on the
  compiler's `pipelineId:updatedAt` cache key and serve a stale compiled
  graph. `MemoryStore.save` got the same fix (`@openpipeline/store-memory`).
- **`@openpipeline/store-prisma`**: a client-supplied node id that belongs
  to a _different_ pipeline is now rejected with a clear ownership error at
  `save()` time, instead of falling through to a confusing Prisma `P2002`
  unique-constraint failure.
- **`@openpipeline/store-memory`**: the single global `seqLock` was replaced
  with a `Map<runId, Promise>` (per-run locks), so serialization for one run
  no longer contends with an unrelated concurrent run.
- **`@openpipeline/runtime`**: the SUCCESS-path terminal write is now
  isolated in its own `try/catch` — a persistence failure on a _successful_
  run's final write can no longer reclassify that run as `FAILED` and
  discard its real `outputs`/`cost`.
- **`@openpipeline/runtime`**: on a run-ending failure, the engine now calls
  `controller.abort()` so a still-running sibling node's in-flight LLM call
  (and its billing) is actually canceled instead of running to completion
  after a `COST_CAP` trip or another node's failure.
- **`@openpipeline/runtime`**: `classifyRunFailure` no longer produces a
  self-contradictory `{ kind: 'ABORTED', code: 'COST_CAP' }` record when an
  abort and a cost-cap/recursion-limit trip race — `aborted` now wins
  unconditionally for both `kind` and `code`.
- **`@openpipeline/nodes`**: node-runner's cost accumulator is hoisted
  outside the handler's `try` block, so cost already spent (via
  `reportCost`) before a handler throws is preserved on the `FAILED` step
  instead of silently dropped.
- **`@openpipeline/nodes`**: the K12 input-validation-error hint (the
  offending state-binding path, appended to the error message) is now
  applied to a _derived_ `PipelineError` object instead of mutating the
  caught `ZodError.message` — the previous approach threw a `TypeError`
  under zod v3-classic's getter-only `message` property, silently
  reclassifying a validation error as a generic runtime error.
- **`@openpipeline/nodes`**: `PipelineCompiler`'s `validate` hook now runs
  on _every_ `compile()` call, not only on a cache miss — previously a
  non-first caller for the same `pipelineId:updatedAt` silently reused a
  cached `CompiledPipeline` with zero validation, defeating a
  tenant/permission-gating `validate` hook for every caller after the first.
- **`@openpipeline/nodes`**: the multi-node orphan-node
  `TOPOLOGY_UNREACHABLE` gate no longer fires on a legitimately edgeless,
  fully-parallel multi-node graph (every node its own entry and exit) — it
  is now scoped to graphs that have at least one edge elsewhere, so only a
  genuinely disconnected node is flagged.
- **`@openpipeline/mcp`**: `listTools` pagination now forwards the returned
  `cursor` on every page request — previously it fetched the same first
  page forever.
- **`@openpipeline/react`**: deleting a node now prunes every surviving
  node's `state`-kind input bindings that referenced the deleted node's
  `outputs.<id>` (or `outputs.<id>.*`) path, instead of leaving dangling
  references. Exact path-segment matching (deleting `ab` does not touch a
  binding on `outputs.abc.field`).
- **`@openpipeline/react`**: a self-loop edge (`fromNodeId === toNodeId`) is
  now rejected both at the store level (`addEdge`) and the canvas
  drag-connect level (`BuilderCanvas.handleConnect`).
- **`@openpipeline/server`**: `POST /pipeline/run/stream` now validates
  `pipelineId` and confirms the run actually started _before_ writing SSE
  response headers — a missing/invalid `pipelineId` now 400s cleanly
  instead of writing a raw JSON error body into an already-open
  `text/event-stream` response.
- **`@openpipeline/server`**: a client disconnect now reliably unsubscribes
  the engine listener for that stream. The disconnect detector was switched
  from `req.on('close', ...)` to `res.on('close', ...)` — the former fires
  as soon as the _request body_ finishes being read (independent of whether
  the client is still connected for the response), so it never actually
  fired on a real disconnect; a browser `EventSource`'s auto-reconnect could
  accumulate one dead listener per reconnect until the run's own timeout.
- **`@openpipeline/server`**: `sseFrame` now guards `JSON.stringify` — an
  unserializable event payload (e.g. a circular `output`) degrades to a
  `{ kind, error: 'payload_not_serializable' }` frame instead of throwing
  mid-stream.

### Changed

- `PipelineEngineOptions.logger` — no behavior change (default remains the
  silent `NOOP_LOGGER`), but see **Observability** in the README: injecting
  a real `Logger` is now explicitly documented as recommended for
  production use, since several of this release's fixes (terminal
  write-isolation, first-terminal-wins races, late-subscribe, disconnect
  handling) only become observable via `logger.warn`/`logger.error`.
- `examples/playground` and `examples/server` updated to the new
  `POST /pipeline/run/stream` route contract.

### Known limitations (explicit, not silent)

Carried forward from this release's own audit/self-review — tracked as
follow-up work, not shipped in 0.2.0:

- **finished-run SSE replay** — `PipelineStore.getRunWithSteps(runId)` needs
  interface extension for terminal-state event replay; separate spec.
- **stale-run sweeper** — no cron in the kernel; a `findStaleRunning(cutoff,
limit)` store primitive + host-side scheduling is the intended shape;
  separate spec.
- **`AutoParamResolver` reference implementation** — intentionally not
  bundled (provider coupling + cost-cap prerequisites); this release's
  `costCapUsd` guard lays the groundwork.
- **child-step kernel wiring** (`createChildStep`) — store-side primitives
  are ready; kernel wiring is a separate spec.
- **react reconnect wiring** and **explicit START/END marker persistence**
  — need product/design decisions; tracked as issues, not implemented here.
- **`NOOP_LOGGER` default** — unchanged by design (the library stays silent
  by default); see the README's new "Observability" section for the logger
  injection recommendation instead of a behavior change.
- **Cost cap is a post-node-boundary check** (checked right after a node's
  SUCCESS step, not a mid-handler preemption) — a node that crosses the cap
  has already billed. Real-time mid-handler cancellation would require a
  larger engine change; documented as a hard limitation in the README's
  "Engine options" table and in the `costCapUsd` error message.

### For `openpipeline-scheduler` consumers (separate repo, not part of this release)

- `patches/@openpipeline__react@0.1.0.patch` should be removable once
  pinned to `@openpipeline/react@0.2.0` — the edge-delete fix it patched
  around ships natively in this release (react's orphan-binding-prune +
  self-loop guard, above).
- `@openpipeline/mcp`'s dynamic-OAuth support is still consumed via a local
  tarball in that repo; migrating it to the npm-published `0.2.0` package is
  a separate follow-up, not done as part of this release.

(This section documents guidance only — no changes were made to the
`openpipeline-scheduler` repository as part of this task.)

## [0.1.0] - 2026-06-22

Initial lockstep release, published to the npm registry for all 8
`@openpipeline/*` packages (pre-dates this changelog; see the git history for
`7d1ac22` and earlier).
