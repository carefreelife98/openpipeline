# @openpipeline/store-prisma

Postgres PipelineStore + StepRecorder adapter for OpenPipeline (Prisma).

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/store-prisma
```

## Usage

A Postgres `PipelineStore` + `StepRecorder` (Prisma). Ships a clean 5-model schema with no multi-tenancy — `userId` on `Pipeline`/`PipelineRun` is an optional opaque audit string with no FK. Apply it with `prisma migrate` using `@openpipeline/store-prisma/schema.prisma` and set `OPENPIPELINE_DATABASE_URL`.

```ts
import { PrismaPipelineStore } from '@openpipeline/store-prisma';
const store = new PrismaPipelineStore(new PrismaClient());
```

**Prisma versions.** The shipped `schema.prisma` is written in the Prisma 6
form. Prisma 7 hosts are supported too (peer `@prisma/client >=5 <8`): copy the
models/enums into your own v7 schema and pass your generated client — the store
depends only on the structural `PrismaClientLike` interface, so extra host
columns (FKs, tenancy) are safe as long as the model names stay verbatim. See
`RELEASING.md` § "Prisma 7" in the repo root for the one raw-SQL caveat to
verify in your integration tests.

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT
