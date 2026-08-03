# OpenPipeline

**Embeddable, MCP-native workflow automation for your product.**

OpenPipeline is a library, not a hosted product: you (a developer) embed it
into your own application so that _your_ end users — typically not
developers — can build, edit, and run workflows, instead of you hand-coding
one graph per use case. Those user-built graphs (tools, LLM calls, conditional
branches) compile to a
[LangGraph](https://github.com/langchain-ai/langgraphjs) `StateGraph` and run
on it, with typed inputs/outputs (Zod), state-path bindings between nodes,
cost tracking, and abort support.

It is **headless and unopinionated**: no web framework, no database, no
multi-tenancy baked in. You bring an LLM provider and (optionally) a
persistence backend; everything else — canvas, catalog policy, storage — is
an interface you can swap or skip.

## When to use this — and when not to

**If your graph is fixed at build time, use
[LangGraph](https://github.com/langchain-ai/langgraphjs) directly — you don't
need this. If the graph is user data — created, edited, validated, and
persisted at runtime by someone other than you, the developer — that's what
OpenPipeline is for.** OpenPipeline is built **on top of** LangGraph, not
competing with it: every pipeline still ultimately compiles to and runs as a
LangGraph `StateGraph`.

Concretely: your product's users draw a pipeline (or describe one in natural
language via the [planner](#plan-pipelines-from-natural-language)), it's
saved, and it runs later — possibly many times, possibly edited in between.
If your workflow graph never changes after you ship it, you don't need any of
this; write it directly in LangGraph and skip the extra layer.

## What you get

- **A typed `NodeSpec` registry + graph validation before a pipeline runs** —
  a user-authored graph is untrusted input, so before a single node executes,
  OpenPipeline checks topology (cycles, unreachable nodes), node/type
  mismatches, and unbound required inputs, and rejects the run with a
  structured `PipelineCompileError` instead of failing deep in a stack trace.
  Every run and every step is recorded, and an optional `costCapUsd` guard
  stops a run once cumulative spend crosses your budget (see
  [Engine options](#engine-options-operational-safety) for the exact
  checked-at-node-boundary semantics).
- **An MCP-native tool catalog** — point OpenPipeline at MCP servers
  (`@openpipeline/mcp`) and their tools become pipeline nodes. Bet on the MCP
  ecosystem instead of hand-building an integration per tool.
- **A natural-language planner** — `@openpipeline/planner` turns an
  instruction into a validated draft via a `design -> validate -> correct`
  loop, so your end users don't have to draw a graph by hand to get a working
  one.
- **A controlled React canvas** — `@openpipeline/react` renders and edits
  pipelines as a DAG; you own data loading, persistence, and the app shell
  around it.

Every piece above is independently adoptable — use the headless engine on its
own, or add the planner, the MCP catalog, and the canvas as you need them.

> Status: early (`0.5.x`). The headless engine, MCP integration, in-memory and
> Postgres persistence, an HTTP/SSE server, and a visual React builder are all
> functional end-to-end (see the playground). Packages are **ESM-only** and
> require **Node 22.12+**.

## Install

```bash
npm i @openpipeline/runtime @openpipeline/nodes @openpipeline/store-memory zod
```

## Quickstart

Run a 3-node DAG with zero database and zero API keys:

```ts
import { PipelineEngine } from '@openpipeline/runtime';
import { createIfNodeSpec, createLlmInvokeNodeSpec } from '@openpipeline/nodes';
import { MemoryStore } from '@openpipeline/store-memory';
import { defineNode } from '@openpipeline/core';
import { z } from 'zod';

const engine = new PipelineEngine({
  store: new MemoryStore(),
  llmFactory: { createModel: (id) => myLangchainModel(id) }, // your provider
});

engine.registerNode(createIfNodeSpec());
engine.registerNode(createLlmInvokeNodeSpec());
engine.registerNode(
  defineNode({
    key: 'tool.uppercase',
    nodeType: 'TOOL',
    displayName: 'Uppercase',
    description: 'Uppercases its input text.',
    icon: 'type',
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ kind: z.literal('tool.uppercase'), out: z.string() }),
    handler: async ({ text }) => ({ kind: 'tool.uppercase', out: text.toUpperCase() }),
  })
);

const id = await engine.save({
  name: 'demo',
  nodes: [
    /* ... */
  ],
  edges: [
    /* ... */
  ],
});
const { runId, done } = await engine.run({ pipelineId: id });
const result = await done; // { status: 'SUCCESS', outputs, cost }
```

A complete, runnable version (including the IF branch and node wiring) lives in
[`examples/quickstart`](./examples/quickstart). From the repo root:

```bash
pnpm install && pnpm build && pnpm example
```

## Concepts

- **NodeSpec** — the contract every node implements: a `key`, a `nodeType`
  (`TOOL` / `LLM` / `IF` / `MCP_TOOL`), Zod input/output schemas, and a `handler`.
  Author one with `defineNode(...)`. This is the public plugin API.
- **ValueBinding** — how a node's input slot gets its value:
  - `literal` — a constant
  - `state` — a reference into the run state, e.g. `outputs.<nodeId>.field`
  - `auto` — filled by an LLM at runtime (requires an `AutoParamResolver`)
- **The engine** — `PipelineEngine` loads a graph, compiles it (DAG → LangGraph
  `StateGraph`, with fan-in `defer` semantics and an LRU cache), runs it, records
  per-node steps, and tracks cost. Conditional `IF` nodes route to a `true`/`false`
  branch.

## Plan pipelines from natural language

`@openpipeline/planner` turns an instruction into a validated `PipelineDraft` via an LLM-driven `design -> validate -> correct` loop over LangGraph — the result is ready to hand straight to `PipelineEngine.save()`:

```ts
import { PipelinePlanner } from '@openpipeline/planner';
import { PipelineEngine } from '@openpipeline/runtime';

const planner = new PipelinePlanner({
  llmFactory,
  modelId: 'gpt-4o',
  specs: () => registry.list(), // a NodeSpecRegistry from @openpipeline/nodes
});

const { draft, attempts, unresolvedValidationErrors } = await planner.plan({
  instruction: 'Fetch the latest release notes and summarize them.',
});

const pipelineId = await engine.save(draft);
const { runId, done } = await engine.run({ pipelineId });
```

The model proposes short-id nodes/edges, `@openpipeline/nodes`'s `validateGraph` checks the draft, and failures are fed back to the model for up to `maxAttempts` correction rounds. Deterministic auto-fill wires an unmapped required slot to its single predecessor when the shape is unambiguous; anything the loop can't resolve on its own surfaces in `unresolvedValidationErrors`/`plannerWarnings` instead of being silently dropped. MCP tool selection (`catalogLoader` + `mcpNodeResolver`, an `intent -> select` step ahead of `design`) is opt-in.

See [`packages/planner`](./packages/planner) for the full API (including the MCP path) and [`examples/planner-quickstart`](./examples/planner-quickstart) for a complete, runnable version of this instruction -> `plan()` -> `save()` -> `run()` flow (deterministic, zero API keys).

## Packages

| Package                                                 | Responsibility                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@openpipeline/core`](./packages/core)                 | Types + interface contracts (`PipelineStore`, `StepRecorder`, `LlmFactory`, `CatalogLoader`, `Logger`). Zero framework deps.                                       |
| [`@openpipeline/nodes`](./packages/nodes)               | Execution kernel (compiler, node-runner, registry, binding resolver) + built-in `IF` / `LLM` nodes.                                                                |
| [`@openpipeline/planner`](./packages/planner)           | LLM-driven natural-language pipeline planner: a `design -> validate -> correct` LangGraph loop over a `NodeSpec` catalog, producing a valid `PipelineDraft`.       |
| [`@openpipeline/runtime`](./packages/runtime)           | `PipelineEngine` — orchestrates a run end to end over the kernel.                                                                                                  |
| [`@openpipeline/store-memory`](./packages/store-memory) | In-memory `PipelineStore` + `StepRecorder` reference implementation.                                                                                               |
| [`@openpipeline/mcp`](./packages/mcp)                   | Optional MCP integration: JSON-Schema→Zod converter, client factory, env catalog loader, `mcp:*` node resolver, and the `CatalogPolicy` hook.                      |
| [`@openpipeline/store-prisma`](./packages/store-prisma) | Postgres `PipelineStore` + `StepRecorder` adapter (Prisma). Ships a clean 5-model schema with no multi-tenancy.                                                    |
| [`@openpipeline/server`](./packages/server)             | Transport-agnostic HTTP + SSE handlers, plus a tiny Node `http` adapter. Streams live run events.                                                                  |
| [`@openpipeline/react`](./packages/react)               | The visual DAG builder as a controlled React component library (`<BuilderCanvas/>` + a Zustand store). No Next.js, no auth — you own data loading and persistence. |

## Bring your own

- **LLM provider** — implement `LlmFactory.createModel(modelId)` returning a
  LangChain `BaseChatModel`. OpenPipeline never hardcodes a provider or model list.
- **Persistence** — implement `PipelineStore` + `StepRecorder`. `MemoryStore` is the
  in-memory reference implementation; `@openpipeline/store-prisma` ships a
  Postgres adapter out of the box (see [Postgres persistence](#postgres-persistence)).
  There is **no multi-tenancy in core** — `companyId` / `scope` / permissions live
  in your adapter.
- **MCP tools** — provide a `CatalogLoader` (single-tenant default reads servers from
  config/env). Admin curation, tool allowlists, and per-user OAuth are an optional
  `CatalogPolicy` layered on top — never required by the core.

## Design

OpenPipeline is a clean-room extraction of a production pipeline engine. The
guiding rule: **the kernel depends on interfaces, not frameworks.** No NestJS, no
Prisma, no proprietary libraries in the core packages — verified by the dependency
tree (only `@langchain/*` + `zod`).

### Engine options (operational safety)

`PipelineEngine` constructor options that guard a run against runaway cost, an
unbounded graph loop, or a hung wall clock — all optional, all off/unlimited by
default so a minimal `new PipelineEngine({ store, llmFactory })` keeps working:

| Option           | Type     | Default                 | Behavior                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `costCapUsd`     | `number` | `undefined` (unlimited) | Per-run USD spend cap, checked **at node boundaries** (right after each node's SUCCESS step finishes) — not a mid-handler preemption, so the node that crosses the cap has already billed. A run that exceeds it fails with `error.kind: 'COST_CAP'`. A conservative starting point for most single-user pipelines is 1–5 USD/run; tune to your nodes' actual LLM cost. |
| `recursionLimit` | `number` | `100`                   | Max LangGraph super-steps per run. A graph that needs more (e.g. a long linear chain, or a loop) throws `GraphRecursionError`, surfaced as a FAILED run with `error.code: 'RECURSION_LIMIT'` instead of an opaque runtime error.                                                                                                                                        |
| `runTimeoutMs`   | `number` | `600_000` (10 min)      | Hard per-run wall-clock timeout — the run is aborted once it elapses. **Pass `0` to disable the timeout entirely** (no timer is armed at all; this is not "a 0ms timeout").                                                                                                                                                                                             |

```ts
const engine = new PipelineEngine({
  store,
  llmFactory,
  costCapUsd: 2, // fail the run rather than silently overspend
  recursionLimit: 50, // catch a runaway/looping graph early
  runTimeoutMs: 0, // e.g. a long-running batch job with no engine-level deadline
});
```

### Observability

`PipelineEngine` (and the node-runner / binding resolver it drives) accepts an
optional `logger: Logger` — a plain `{ info, warn, error, debug }` interface, so
any logging library adapts trivially. **The default is `NOOP_LOGGER` — silent, by
design** (a library shouldn't write to stdout/your log sink unasked). This has
been deliberately unchanged since `0.2.0`.

That silence has a real cost, though: several of the hardening fixes introduced
in `0.2.0` only surface via `logger.warn`/`logger.error` — a lost first-terminal-wins
race (`completeRun` returning `false`), a store failure isolated from a genuinely
successful run's terminal write, a late/direct `onEvent` subscribe on a
non-in-flight run, or an MCP `$ref` circularity truncation. Without a real logger
wired in, these degrade silently instead of loudly. **Inject a real `Logger` in
production**:

```ts
const engine = new PipelineEngine({
  store,
  llmFactory,
  logger: {
    info: (msg, meta) => myLogger.info(msg, meta),
    warn: (msg, meta) => myLogger.warn(msg, meta),
    error: (msg, meta) => myLogger.error(msg, meta),
    debug: (msg, meta) => myLogger.debug(msg, meta),
  },
});
```

### MCP tools

```ts
import { createEnvCatalogLoader, McpNodeResolverImpl } from '@openpipeline/mcp';

const engine = new PipelineEngine({
  store,
  llmFactory,
  catalogLoader: createEnvCatalogLoader({
    servers: [
      {
        key: 'github',
        transportType: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        authType: 'none',
        env: { GITHUB_TOKEN: process.env.GH_TOKEN! },
      },
    ],
  }),
  mcpNodeResolver: new McpNodeResolverImpl(),
});
// then use a node with key `mcp:github:<tool>`
```

No multi-tenancy by default (personal direct use). To add admin curation, tool
allowlists, or per-user OAuth, pass a `CatalogPolicy`
(`filterProviders` / `filterTools` / `resolveToken`) to the loader — the engine
never sees `companyId` or `scope`.

> Note: MCP servers whose tool schemas use `if/then/else`, `dependentSchemas`,
> external `$ref`, or `not` cannot be converted to Zod and are skipped (logged).
> This is a known limit of the single-step JSON-Schema→Zod conversion.

### Postgres persistence

```ts
import { PrismaPipelineStore } from '@openpipeline/store-prisma';
// PrismaClient generated from @openpipeline/store-prisma/schema.prisma
import { PrismaClient } from './generated/prisma';

const store = new PrismaPipelineStore(new PrismaClient());
const engine = new PipelineEngine({ store, llmFactory });
```

Apply the schema with `prisma migrate` using the shipped
`@openpipeline/store-prisma/schema.prisma` (set `OPENPIPELINE_DATABASE_URL`). The
schema has **no multi-tenancy** — `userId` is an optional opaque audit string with
no foreign key. It preserves the production-grade bits: race-free atomic cost
updates (JSONB) and fan-in-safe step sequencing.

### HTTP + live events (SSE)

```ts
import { createServer } from 'node:http';
import { createPipelineHandlers, createNodeHttpHandler } from '@openpipeline/server';

const handlers = createPipelineHandlers(engine);
createServer(createNodeHttpHandler(handlers)).listen(3000);
// POST /pipeline, GET /pipeline/:id (404 if the pipeline doesn't exist),
// GET /pipeline/:id/runs,
// POST /pipeline/run (non-streaming; 400 for a missing/non-string
// pipelineId, 404 if the pipeline doesn't exist),
// POST /pipeline/run/stream (starts a run and streams it, SSE; 400 for a
// missing/non-string pipelineId, 404 if the pipeline doesn't exist — both
// with headers unsent, before any SSE frame),
// GET /pipeline/runs/:runId/stream (attach to an
// already in-flight run's SSE stream; 404 if it's unknown or has finished —
// it never starts a run), POST /pipeline/run/:runId/abort (404 if unknown/finished)
```

`PipelineHandlers` are plain async functions with no framework dependency — mount
them into Express/Fastify/Hono, or use the bundled Node `http` adapter. Live run
events (`NODE_START` / `NODE_END` / `RUN_COMPLETE`, with node output + timing) are
streamed via SSE — the engine drives them from LangGraph `streamEvents`, and you
can also subscribe directly with `engine.onEvent(runId, listener)`. Passing
`onEvent` straight into `engine.run(opts)` (or using `runAndStream`) registers
the listener before the run starts executing, so no events from the very start
of the run are missed.

### Visual builder (React)

```tsx
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { BuilderCanvas, createBuilderStore } from '@openpipeline/react';

const store = createBuilderStore();
store.getState().loadDraft(myPipelineDraft); // from your GET endpoint

<ReactFlowProvider>
  <BuilderCanvas store={store} nodeRunStatus={liveStatus} />
</ReactFlowProvider>;
// persist with store.getState().toDraft() -> your POST endpoint
```

`<BuilderCanvas/>` is a controlled component over a Zustand store. It renders the
node graph with START/END markers, IF branches, drag/connect/delete, and a live
run-status overlay. You supply the data adapter (load via `loadDraft`, save via
`toDraft`), an i18n string map (`strings` prop, English defaults), and your own
auth/router wrapper. It deliberately does NOT ship a Next.js shell, an API client,
or auth — those are product-specific concerns every embedding product owns
differently, so the component stays framework- and stack-agnostic.

### Try it: the playground

[`examples/playground`](./examples/playground) is a full Vite app wiring
`@openpipeline/react` to `@openpipeline/server` — one `pnpm dev` boots a working
builder with a node palette, a seeded pipeline, save, and a Run button that streams
live node status onto the canvas:

```bash
pnpm install && pnpm build
pnpm --filter @openpipeline/example-playground dev   # http://localhost:5173
```

The playground also serves as the reference auth/router wrapper to copy: it owns
data loading, persistence, and the SSE run loop; the library contributes only the
canvas + store.

OpenPipeline's core is deliberately single-tenant (see [Bring your
own](#bring-your-own)); tenancy and auth are things a host adds via hooks like
`CatalogPolicy`, not something the library assumes for you. `openpipeline-scheduler`
is the full-stack reference for that: a separate, non-public repo that wires these
packages into a real multi-tenant, authenticated product. The playground above is
the public, runnable-in-under-a-minute version of the same idea, without the
tenancy layer.

## Roadmap

**Next major investment: canvas → builder kit.** `@openpipeline/react` currently
ships one controlled component, `<BuilderCanvas/>`. The next step is decomposing
that into composable, independently-adoptable pieces — a node palette, a
schema-driven inspector (edit a node's inputs straight from its published JSON Schema), and a
validation-display component (surface `validateGraph`/`PipelineCompileError`
issues in the UI) — instead of one all-or-nothing canvas.

Also planned:

- npm publish hardening (dual ESM/CJS, pinned peer deps, more examples)
- A multi-tenant `CatalogPolicy` example adapter

**Explicit non-goals:**

- A fluent, code-first pipeline DSL. If you want to author graphs in code,
  [LangGraph](https://github.com/langchain-ai/langgraphjs) already does this well
  — that's not a lane OpenPipeline is trying to win.
- Hosted product features — hosting, auth, a marketplace. OpenPipeline is a
  library you embed, not a product your end users sign up for directly.

## License

MIT
