# @openworkflow/react

Visual DAG builder for OpenWorkflow as a controlled React component library (ReactFlow + Zustand).

Part of [OpenWorkflow](https://github.com/carefreelife98/openworkflow) — a framework-agnostic engine for compiling and running MCP-tool workflows as LangGraph DAGs.

## Install

```bash
npm i @openworkflow/react
```

## Usage

The visual DAG builder as a controlled React component library (ReactFlow + Zustand). No Next.js, no auth — you own data loading and persistence.

```tsx
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { BuilderCanvas, createBuilderStore } from '@openworkflow/react';
const store = createBuilderStore();
<ReactFlowProvider><BuilderCanvas store={store} /></ReactFlowProvider>;
```

See the [root README](https://github.com/carefreelife98/openworkflow#readme) for the full quickstart and the playground.

## License

MIT
