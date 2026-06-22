# @openpipeline/store-prisma

Postgres PipelineStore + StepRecorder adapter for OpenPipeline (Prisma).

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/store-prisma
```

## Usage

A Postgres `PipelineStore` + `StepRecorder` (Prisma). Ships a clean 5-model schema with no multi-tenancy. Apply it with `prisma migrate` using `@openpipeline/store-prisma/schema.prisma` and set `OPENPIPELINE_DATABASE_URL`.

```ts
import { PrismaPipelineStore } from '@openpipeline/store-prisma';
const store = new PrismaPipelineStore(new PrismaClient());
```

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT
