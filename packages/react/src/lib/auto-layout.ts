import dagre from '@dagrejs/dagre';

export interface LayoutInputNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutInputEdge {
  source: string;
  target: string;
  /** weight:0 on single-sink (END) edges keeps same-depth nodes aligned in a column. */
  weight?: number;
  minlen?: number;
}

export interface LayoutOptions {
  direction?: 'TB' | 'LR';
}

/**
 * Compute a DAG layout with dagre and return top-left positions per node. Pure
 * (no React/store dependency) — the canvas injects measured node sizes. Faithful
 * port of the Mate-X helper.
 */
export function layoutWithDagre(
  nodes: ReadonlyArray<LayoutInputNode>,
  edges: ReadonlyArray<LayoutInputEdge>,
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: options.direction ?? 'LR',
    nodesep: 60,
    ranksep: 80,
    marginx: 20,
    marginy: 20,
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) {
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
      const label: { weight?: number; minlen?: number } = {};
      if (e.weight !== undefined) label.weight = e.weight;
      if (e.minlen !== undefined) label.minlen = e.minlen;
      g.setEdge(e.source, e.target, label);
    }
  }

  dagre.layout(g);

  for (const n of nodes) {
    const laid = g.node(n.id) as { x: number; y: number } | undefined;
    if (!laid) continue;
    result.set(n.id, { x: laid.x - n.width / 2, y: laid.y - n.height / 2 });
  }
  return result;
}
