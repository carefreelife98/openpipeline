// Live run events. The engine streams these as a workflow executes so a server
// (or any listener) can drive a UI. Translated from LangGraph's streamEvents.

export type WorkflowEventKind =
  | 'NODE_START'
  | 'NODE_END'
  | 'NODE_FAILED'
  | 'NODE_ABORTED'
  | 'LLM_CHUNK'
  | 'RUN_COMPLETE';

export interface NodeLifecycleEvent {
  kind: 'NODE_START' | 'NODE_END' | 'NODE_FAILED' | 'NODE_ABORTED';
  nodeId: string;
  /** NODE_END only: the output the node just produced. */
  output?: unknown;
  /** NODE_END only: execution timing (ISO strings). */
  startedAt?: string;
  finishedAt?: string;
}

export interface LlmChunkEvent {
  kind: 'LLM_CHUNK';
  text: string;
}

export interface RunCompleteEvent {
  kind: 'RUN_COMPLETE';
  status: 'SUCCESS' | 'FAILED' | 'ABORTED';
}

export type WorkflowEvent = NodeLifecycleEvent | LlmChunkEvent | RunCompleteEvent;

export type WorkflowEventListener = (event: WorkflowEvent) => void;
