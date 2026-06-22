// @openworkflow/react — visual DAG builder as a controlled component library.
//
// Usage:
//   import '@xyflow/react/dist/style.css';
//   import { ReactFlowProvider } from '@xyflow/react';
//   import { BuilderCanvas, createBuilderStore } from '@openworkflow/react';
//
//   const store = createBuilderStore();
//   store.getState().loadDraft(myWorkflowDraft);
//   <ReactFlowProvider><BuilderCanvas store={store} /></ReactFlowProvider>
//
// The consumer owns data loading (loadDraft) and persistence (store.toDraft() ->
// your save endpoint). No Next.js, no auth, no ApiClient.

export { createBuilderStore, type BuilderStore, type BuilderState } from './store/builder-store.js';
export { BuilderCanvas, type BuilderCanvasProps } from './canvas/BuilderCanvas.js';
export { WorkflowNodeCard, type WorkflowNodeData } from './canvas/WorkflowNodeCard.js';
export { DeletableEdge } from './canvas/DeletableEdge.js';
export { StartMarker, EndMarker } from './canvas/markers.js';

export {
  buildDisplayNodes,
  buildDisplayEdges,
  mergeDisplayNodes,
  stripMarkers,
  type StripMarkersResult,
} from './lib/serializer.js';
export { layoutWithDagre, type LayoutInputNode, type LayoutInputEdge, type LayoutOptions } from './lib/auto-layout.js';
export * from './lib/markers.js';

export {
  type BuilderNode,
  type BuilderEdge,
  type NodeSpecDescriptor,
  type NodeRunStatus,
  type BuilderStrings,
  DEFAULT_STRINGS,
} from './types.js';
