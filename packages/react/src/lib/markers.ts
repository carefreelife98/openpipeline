export const START_MARKER_ID = '__start__';
export const END_MARKER_ID = '__end__';

export const START_EDGE_ID_PREFIX = '__edge_start__';
export const END_EDGE_ID_PREFIX = '__edge_end__';

export const DEFAULT_START_MARKER = { x: 100, y: 200 };
export const DEFAULT_END_MARKER = { x: 800, y: 200 };

export const startEdgeIdFor = (nodeId: string): string => `${START_EDGE_ID_PREFIX}${nodeId}`;
export const endEdgeIdFor = (nodeId: string): string => `${END_EDGE_ID_PREFIX}${nodeId}`;

export const isStartMarkerEdge = (edgeId: string): boolean => edgeId.startsWith(START_EDGE_ID_PREFIX);
export const isEndMarkerEdge = (edgeId: string): boolean => edgeId.startsWith(END_EDGE_ID_PREFIX);
export const isMarkerEdge = (edgeId: string): boolean => isStartMarkerEdge(edgeId) || isEndMarkerEdge(edgeId);

/** IF source handle id (`branch-true`/`branch-false`) -> edge label. */
export function sourceLabelFromHandle(handle: string | null | undefined): string | undefined {
  if (handle === 'branch-true') return 'true';
  if (handle === 'branch-false') return 'false';
  return undefined;
}
