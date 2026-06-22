# @openpipeline/runtime

PipelineEngine orchestrator for OpenPipeline — drives a run end to end over the kernel.

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/runtime
```

## Usage

The `PipelineEngine` — loads a graph, compiles it, runs it, records steps, tracks cost, and streams live events. This is the package most apps import.

```ts
import { PipelineEngine } from '@openpipeline/runtime';
const engine = new PipelineEngine({ store, llmFactory });
const { runId, done } = await engine.run({ pipelineId });
```

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT
