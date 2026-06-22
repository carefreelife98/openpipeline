# @openpipeline/react

Visual DAG builder for OpenPipeline as a controlled React component library (ReactFlow + Zustand).

Part of [OpenPipeline](https://github.com/carefreelife98/openpipeline) — a framework-agnostic engine for compiling and running MCP-tool pipelines as LangGraph DAGs.

## Install

```bash
npm i @openpipeline/react
```

## Usage

The visual DAG builder as a controlled React component library (ReactFlow + Zustand). No Next.js, no auth — you own data loading and persistence.

```tsx
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { BuilderCanvas, createBuilderStore } from '@openpipeline/react';
const store = createBuilderStore();
<ReactFlowProvider><BuilderCanvas store={store} /></ReactFlowProvider>;
```

See the [root README](https://github.com/carefreelife98/openpipeline#readme) for the full quickstart and the playground.

## License

MIT
