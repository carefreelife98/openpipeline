# OpenWorkflow

A framework-agnostic engine for compiling and running **MCP-tool workflows** as
[LangGraph](https://github.com/langchain-ai/langgraphjs) DAGs.

Draw a graph of nodes — tools, LLM calls, conditional branches — and OpenWorkflow
compiles it to a LangGraph `StateGraph` and executes it, with typed inputs/outputs
(Zod), state-path bindings between nodes, cost tracking, and abort support.

It is **headless and unopinionated**: no web framework, no database, no
multi-tenancy. You bring an LLM provider and (optionally) a persistence backend;
everything else is an interface you can swap.

> Status: early (`0.1.x`). The headless core is functional end-to-end; the React
> builder and Prisma/MCP adapters are on the roadmap below.

## Install

```bash
npm i @openworkflow/runtime @openworkflow/nodes @openworkflow/store-memory zod
```

## Quickstart

Run a 3-node DAG with zero database and zero API keys:

```ts
import { WorkflowEngine } from '@openworkflow/runtime';
import { createIfNodeSpec, createLlmInvokeNodeSpec } from '@openworkflow/nodes';
import { MemoryStore } from '@openworkflow/store-memory';
import { defineNode } from '@openworkflow/core';
import { z } from 'zod';

const engine = new WorkflowEngine({
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
  }),
);

const id = await engine.save({ name: 'demo', nodes: [/* ... */], edges: [/* ... */] });
const { runId, done } = await engine.run({ workflowId: id });
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
- **The engine** — `WorkflowEngine` loads a graph, compiles it (DAG → LangGraph
  `StateGraph`, with fan-in `defer` semantics and an LRU cache), runs it, records
  per-node steps, and tracks cost. Conditional `IF` nodes route to a `true`/`false`
  branch.

## Packages

| Package | Responsibility |
| --- | --- |
| [`@openworkflow/core`](./packages/core) | Types + interface contracts (`WorkflowStore`, `StepRecorder`, `LlmFactory`, `CatalogLoader`, `Logger`). Zero framework deps. |
| [`@openworkflow/nodes`](./packages/nodes) | Execution kernel (compiler, node-runner, registry, binding resolver) + built-in `IF` / `LLM` nodes. |
| [`@openworkflow/runtime`](./packages/runtime) | `WorkflowEngine` — orchestrates a run end to end over the kernel. |
| [`@openworkflow/store-memory`](./packages/store-memory) | In-memory `WorkflowStore` + `StepRecorder` reference implementation. |
| [`@openworkflow/mcp`](./packages/mcp) | Optional MCP integration: JSON-Schema→Zod converter, client factory, env catalog loader, `mcp:*` node resolver, and the `CatalogPolicy` hook. |
| [`@openworkflow/store-prisma`](./packages/store-prisma) | Postgres `WorkflowStore` + `StepRecorder` adapter (Prisma). Ships a clean 5-model schema with no multi-tenancy. |

## Bring your own

- **LLM provider** — implement `LlmFactory.createModel(modelId)` returning a
  LangChain `BaseChatModel`. OpenWorkflow never hardcodes a provider or model list.
- **Persistence** — implement `WorkflowStore` + `StepRecorder`. `MemoryStore` is the
  reference; a Prisma/Postgres adapter is on the roadmap. There is **no
  multi-tenancy in core** — `companyId` / `scope` / permissions live in your adapter.
- **MCP tools** — provide a `CatalogLoader` (single-tenant default reads servers from
  config/env). Admin curation, tool allowlists, and per-user OAuth are an optional
  `CatalogPolicy` layered on top — never required by the core.

## Design

OpenWorkflow is a clean-room extraction of a production workflow engine. The
guiding rule: **the kernel depends on interfaces, not frameworks.** No NestJS, no
Prisma, no proprietary libraries in the core packages — verified by the dependency
tree (only `@langchain/*` + `zod`).

### MCP tools

```ts
import { createEnvCatalogLoader, McpNodeResolverImpl } from '@openworkflow/mcp';

const engine = new WorkflowEngine({
  store, llmFactory,
  catalogLoader: createEnvCatalogLoader({
    servers: [
      { key: 'github', transportType: 'stdio', command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        authType: 'none', env: { GITHUB_TOKEN: process.env.GH_TOKEN! } },
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
import { PrismaWorkflowStore } from '@openworkflow/store-prisma';
// PrismaClient generated from @openworkflow/store-prisma/schema.prisma
import { PrismaClient } from './generated/prisma';

const store = new PrismaWorkflowStore(new PrismaClient());
const engine = new WorkflowEngine({ store, llmFactory });
```

Apply the schema with `prisma migrate` using the shipped
`@openworkflow/store-prisma/schema.prisma` (set `OPENWORKFLOW_DATABASE_URL`). The
schema has **no multi-tenancy** — `userId` is an optional opaque audit string with
no foreign key. It preserves the production-grade bits: race-free atomic cost
updates (JSONB) and fan-in-safe step sequencing.

## Roadmap

- `@openworkflow/server` — framework-agnostic HTTP + SSE handlers
- `@openworkflow/react` — the visual DAG builder as a controlled component library

## License

MIT
