# @openpipeline/server

Transport-agnostic HTTP + SSE handlers for OpenPipeline, with a tiny Node http adapter.

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/server
```

## Usage

Transport-agnostic HTTP + SSE handlers, plus a tiny Node `http` adapter. Streams live run events to a builder UI.

```ts
import { createPipelineHandlers, createNodeHttpHandler } from '@openpipeline/server';
createServer(createNodeHttpHandler(createPipelineHandlers(engine))).listen(3000);
```

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT
