# @openworkflow/store-memory

In-memory WorkflowStore + StepRecorder reference implementation for OpenWorkflow.

Part of [OpenWorkflow](https://github.com/carefreelife98/openworkflow) — a framework-agnostic engine for compiling and running MCP-tool workflows as LangGraph DAGs.

## Install

```bash
npm i @openworkflow/store-memory
```

## Usage

An in-memory `WorkflowStore` + `StepRecorder`. Makes "install and run a workflow" work with zero database.

```ts
import { MemoryStore } from '@openworkflow/store-memory';
const engine = new WorkflowEngine({ store: new MemoryStore(), llmFactory });
```

See the [root README](https://github.com/carefreelife98/openworkflow#readme) for the full quickstart and the playground.

## License

MIT
