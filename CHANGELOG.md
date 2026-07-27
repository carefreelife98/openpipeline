# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
All 8 `@openpipeline/*` packages (`core`, `nodes`, `runtime`, `mcp`,
`store-memory`, `store-prisma`, `react`, `server`) are versioned in
**lockstep** — one version number for the whole set, published together (see
[RELEASING.md](./RELEASING.md)).

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
