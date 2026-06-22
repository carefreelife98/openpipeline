# @openworkflow/server

Transport-agnostic HTTP + SSE handlers for OpenWorkflow, with a tiny Node http adapter.

Part of [OpenWorkflow](https://github.com/carefreelife98/openworkflow) — a framework-agnostic engine for compiling and running MCP-tool workflows as LangGraph DAGs.

## Install

```bash
npm i @openworkflow/server
```

## Usage

Transport-agnostic HTTP + SSE handlers, plus a tiny Node `http` adapter. Streams live run events to a builder UI.

```ts
import { createWorkflowHandlers, createNodeHttpHandler } from '@openworkflow/server';
createServer(createNodeHttpHandler(createWorkflowHandlers(engine))).listen(3000);
```

See the [root README](https://github.com/carefreelife98/openworkflow#readme) for the full quickstart and the playground.

## License

MIT
