# @openpipeline/store-memory

In-memory PipelineStore + StepRecorder reference implementation for OpenPipeline.

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/store-memory
```

## Usage

An in-memory `PipelineStore` + `StepRecorder`. Makes "install and run a pipeline" work with zero database.

```ts
import { MemoryStore } from '@openpipeline/store-memory';
const engine = new PipelineEngine({ store: new MemoryStore(), llmFactory });
```

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT
