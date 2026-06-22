import type { NodeType, NodeInputs, ValueBinding, WorkflowDraft } from '@openworkflow/core';

/** A node as held in the builder (client id = ReactFlow id = persisted id). */
export interface BuilderNode {
  id: string;
  nodeType: NodeType;
  key: string;
  label: string;
  inputs: NodeInputs;
  positionX?: number;
  positionY?: number;
}

export interface BuilderEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string | null;
}

/**
 * Catalog entry describing a node type the palette/inspector can render. The
 * consumer fetches these (e.g. from the engine's node-spec catalog endpoint)
 * and passes them to the canvas.
 */
export interface NodeSpecDescriptor {
  key: string;
  nodeType: NodeType;
  displayName: string;
  description: string;
  icon: string;
  /** Input slot names + whether each is required (for the inspector). */
  inputs?: Array<{ name: string; required: boolean; description?: string }>;
  meta?: Record<string, unknown>;
}

/** Live run status for a node, fed in by the consumer (from engine.onEvent). */
export type NodeRunStatus = 'WAITING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ABORTED';

/** All user-facing strings the canvas renders. English defaults provided. */
export interface BuilderStrings {
  emptyTitle: string;
  emptyHint: string;
  startLabel: string;
  endLabel: string;
  deleteEdge: string;
}

export const DEFAULT_STRINGS: BuilderStrings = {
  emptyTitle: 'What automation will you build?',
  emptyHint: 'Drag nodes from the palette, or describe your workflow in plain language.',
  startLabel: 'Start',
  endLabel: 'End',
  deleteEdge: 'Delete',
};

export type { ValueBinding, WorkflowDraft, NodeInputs };
