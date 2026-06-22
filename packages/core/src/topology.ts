import type { PipelineNodeRow, PipelineEdgeRow, TopologyAnalysis, CompiledNode } from './graph.js';

/**
 * Build predecessor/successor maps and identify entry (in-degree 0) and exit
 * (out-degree 0) nodes. An isolated node (in=0 AND out=0) is both — a
 * single-node pipeline is its own entry and exit.
 */
export function analyzeTopology(
  nodes: readonly PipelineNodeRow[],
  edges: readonly PipelineEdgeRow[]
): TopologyAnalysis {
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  for (const n of nodes) {
    predecessors.set(n.id, []);
    successors.set(n.id, []);
  }
  for (const e of edges) {
    predecessors.get(e.toNodeId)?.push(e.fromNodeId);
    successors.get(e.fromNodeId)?.push(e.toNodeId);
  }

  const entryNodes = nodes.filter((n) => (predecessors.get(n.id)?.length ?? 0) === 0);
  const exitNodes = nodes.filter((n) => (successors.get(n.id)?.length ?? 0) === 0);

  return {
    entryNodes,
    exitNodes,
    predecessorsByNode: predecessors as ReadonlyMap<string, readonly string[]>,
    successorsByNode: successors as ReadonlyMap<string, readonly string[]>,
  };
}

/**
 * Forward-topological ancestor ids of a node (those that can reach it), in data-
 * flow order. Used to scope predecessor outputs handed to the resolver.
 */
export function computeAncestors(
  nodeId: string,
  nodeMap: ReadonlyMap<string, CompiledNode>
): string[] {
  // Reverse BFS to collect ancestors, then order them forward-topologically.
  const ancestors = new Set<string>();
  const queue = [...(nodeMap.get(nodeId)?.predecessors ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    for (const p of nodeMap.get(id)?.predecessors ?? []) {
      if (!ancestors.has(p)) queue.push(p);
    }
  }

  // Kahn topological sort over the ancestor sub-DAG.
  const inDegree = new Map<string, number>();
  for (const id of ancestors) inDegree.set(id, 0);
  for (const id of ancestors) {
    for (const succ of nodeMap.get(id)?.successors ?? []) {
      if (ancestors.has(succ)) inDegree.set(succ, (inDegree.get(succ) ?? 0) + 1);
    }
  }
  const ready: string[] = [];
  for (const [id, d] of inDegree) if (d === 0) ready.push(id);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const succ of nodeMap.get(id)?.successors ?? []) {
      if (!ancestors.has(succ)) continue;
      const d = (inDegree.get(succ) ?? 0) - 1;
      inDegree.set(succ, d);
      if (d === 0) ready.push(succ);
    }
  }
  return ordered;
}
