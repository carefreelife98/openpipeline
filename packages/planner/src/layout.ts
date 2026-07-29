import type { PipelineEdgeRow, PipelineNodeRow } from '@openpipeline/core';

type DraftNode = Omit<PipelineNodeRow, 'pipelineId'>;
type DraftEdge = Omit<PipelineEdgeRow, 'pipelineId'>;

/**
 * D6 — simple deterministic layered layout: multi-source BFS depth from every
 * zero-indegree node (`x = depth * 280`), grouped into columns and stacked
 * top-to-bottom in each node's original array order (`y = index * 120`).
 * Advisory only — a consumer (e.g. the React canvas) is free to re-layout.
 *
 * Deliberately the textbook single-pass BFS (first-visit wins), not a
 * longest-path/Sugiyama layering — this is a planner convenience, not a
 * general graph-layout engine (no `dagre` dependency here, D6).
 *
 * An edge referencing a node id absent from `nodes` (a "dangling edge" —
 * `validate()` reports these separately) is simply skipped for layout
 * purposes; a node BFS never reaches (e.g. the interior of a pure cycle with
 * no external entry — `validate()` reports that too) still gets a
 * deterministic fallback depth of 0 so every node always has *some* advisory
 * position.
 */
export function computeLayeredPositions(
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[]
): DraftNode[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const successors = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    successors.set(n.id, []);
    indegree.set(n.id, 0);
  }
  for (const e of edges) {
    if (!nodeIds.has(e.fromNodeId) || !nodeIds.has(e.toNodeId)) continue;
    successors.get(e.fromNodeId)?.push(e.toNodeId);
    indegree.set(e.toNodeId, (indegree.get(e.toNodeId) ?? 0) + 1);
  }

  const depthById = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((indegree.get(n.id) ?? 0) === 0) {
      depthById.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const depth = depthById.get(id) as number;
    for (const next of successors.get(id) ?? []) {
      if (depthById.has(next)) continue; // BFS: first visit wins (shortest depth)
      depthById.set(next, depth + 1);
      queue.push(next);
    }
  }
  for (const n of nodes) {
    if (!depthById.has(n.id)) depthById.set(n.id, 0);
  }

  const seenAtDepth = new Map<number, number>();
  return nodes.map((n) => {
    const depth = depthById.get(n.id) as number;
    const index = seenAtDepth.get(depth) ?? 0;
    seenAtDepth.set(depth, index + 1);
    return { ...n, positionX: depth * 280, positionY: index * 120 };
  });
}
