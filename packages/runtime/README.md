# @openworkflow/runtime

WorkflowEngine orchestrator for OpenWorkflow — drives a run end to end over the kernel.

Part of [OpenWorkflow](https://github.com/carefreelife98/openworkflow) — a framework-agnostic engine for compiling and running MCP-tool workflows as LangGraph DAGs.

## Install

```bash
npm i @openworkflow/runtime
```

## Usage

The `WorkflowEngine` — loads a graph, compiles it, runs it, records steps, tracks cost, and streams live events. This is the package most apps import.

```ts
import { WorkflowEngine } from '@openworkflow/runtime';
const engine = new WorkflowEngine({ store, llmFactory });
const { runId, done } = await engine.run({ workflowId });
```

See the [root README](https://github.com/carefreelife98/openworkflow#readme) for the full quickstart and the playground.

## License

MIT
