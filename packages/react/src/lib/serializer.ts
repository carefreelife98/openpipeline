// Convert between ReactFlow node/edge representations and BuilderNode/BuilderEdge.
// START/END markers are display-only — never stored in state or persisted.
// Faithful port; the only change is local types and English marker labels.
import type { Node as RfNode, Edge as RfEdge } from '@xyflow/react';

import type { BuilderNode, BuilderEdge } from '../types.js';

import {
  START_MARKER_ID,
  END_MARKER_ID,
  DEFAULT_START_MARKER,
  DEFAULT_END_MARKER,
  startEdgeIdFor,
  endEdgeIdFor,
} from './markers.js';

export function buildDisplayNodes(
  stateNodes: BuilderNode[],
  startMarker: { x: number; y: number } | null = null,
  endMarker: { x: number; y: number } | null = null,
  labels: { start: string; end: string } = { start: 'Start', end: 'End' }
): RfNode[] {
  const startMarkerNode: RfNode = {
    id: START_MARKER_ID,
    type: 'startMarker',
    position: startMarker ?? DEFAULT_START_MARKER,
    data: { label: labels.start },
    deletable: false,
  };
  const endMarkerNode: RfNode = {
    id: END_MARKER_ID,
    type: 'endMarker',
    position: endMarker ?? DEFAULT_END_MARKER,
    data: { label: labels.end },
    deletable: false,
  };
  const nodeRfList: RfNode[] = stateNodes.map((n) => ({
    id: n.id,
    type: 'pipelineNode',
    position: { x: n.positionX ?? 300, y: n.positionY ?? 200 },
    data: { node: n },
  }));
  return [startMarkerNode, ...nodeRfList, endMarkerNode];
}

/** Merge fresh (store) nodes with prev (on-screen) nodes, preserving transient drag positions. */
export function mergeDisplayNodes(prev: RfNode[], fresh: RfNode[]): RfNode[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  return fresh.map((freshNode) => {
    const prevNode = prevById.get(freshNode.id);
    if (!prevNode) return freshNode;
    const isMarker = freshNode.id === START_MARKER_ID || freshNode.id === END_MARKER_ID;
    return {
      ...freshNode,
      position: isMarker ? freshNode.position : prevNode.position,
      selected: prevNode.selected ?? false,
    };
  });
}

export function buildDisplayEdges(
  stateEdges: BuilderEdge[],
  startTargets: string[],
  endSources: string[]
): RfEdge[] {
  const result: RfEdge[] = stateEdges.map((e) => {
    const sourceHandle =
      e.label === 'true' || e.label === 'false' ? `branch-${e.label}` : undefined;
    return {
      id: e.id,
      source: e.fromNodeId,
      target: e.toNodeId,
      sourceHandle,
      type: 'deletable',
      deletable: true,
      reconnectable: true,
      selectable: true,
      focusable: true,
      data: { label: e.label },
      style: { strokeWidth: 2 },
    };
  });
  for (const target of startTargets) {
    result.push({
      id: startEdgeIdFor(target),
      source: START_MARKER_ID,
      target,
      type: 'deletable',
      deletable: true,
      reconnectable: false,
      style: { strokeWidth: 1.5, stroke: '#10b981', strokeDasharray: '4 2' },
    });
  }
  for (const source of endSources) {
    result.push({
      id: endEdgeIdFor(source),
      source,
      target: END_MARKER_ID,
      type: 'deletable',
      deletable: true,
      reconnectable: false,
      style: { strokeWidth: 1.5, stroke: '#94a3b8', strokeDasharray: '4 2' },
    });
  }
  return result;
}

export interface StripMarkersResult {
  startTargets: string[];
  endSources: string[];
  userEdges: RfEdge[];
}

export function stripMarkers(rfEdges: RfEdge[]): StripMarkersResult {
  const startTargets: string[] = [];
  const endSources: string[] = [];
  const userEdges: RfEdge[] = [];
  for (const e of rfEdges) {
    if (e.source === START_MARKER_ID) {
      if (!startTargets.includes(e.target)) startTargets.push(e.target);
    } else if (e.target === END_MARKER_ID) {
      if (!endSources.includes(e.source)) endSources.push(e.source);
    } else {
      userEdges.push(e);
    }
  }
  return { startTargets, endSources, userEdges };
}
