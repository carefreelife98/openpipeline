# @openworkflow/store-prisma

Postgres WorkflowStore + StepRecorder adapter for OpenWorkflow (Prisma).

Part of [OpenWorkflow](https://github.com/carefreelife98/openworkflow) — a framework-agnostic engine for compiling and running MCP-tool workflows as LangGraph DAGs.

## Install

```bash
npm i @openworkflow/store-prisma
```

## Usage

A Postgres `WorkflowStore` + `StepRecorder` (Prisma). Ships a clean 5-model schema with no multi-tenancy. Apply it with `prisma migrate` using `@openworkflow/store-prisma/schema.prisma` and set `OPENWORKFLOW_DATABASE_URL`.

```ts
import { PrismaWorkflowStore } from '@openworkflow/store-prisma';
const store = new PrismaWorkflowStore(new PrismaClient());
```

See the [root README](https://github.com/carefreelife98/openworkflow#readme) for the full quickstart and the playground.

## License

MIT
