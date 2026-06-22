import { describe, it, expect } from 'vitest';
import { analyzeTopology, computeAncestors } from '../src/topology.js';
import type { PipelineNodeRow, PipelineEdgeRow, CompiledNode } from '../src/graph.js';

function node(id: string): PipelineNodeRow {
  return { id, pipelineId: 'p', nodeType: 'TOOL', key: 'tool.x', label: id, inputs: {} };
}
function edge(from: string, to: string): PipelineEdgeRow {
  return { id: `${from}->${to}`, pipelineId: 'p', fromNodeId: from, toNodeId: to };
}

/** Build a CompiledNode map from a node list + edge list (specs are stubbed). */
function compiledMap(ids: string[], edges: PipelineEdgeRow[]): ReadonlyMap<string, CompiledNode> {
  const pred = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succ = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    pred.get(e.toNodeId)!.push(e.fromNodeId);
    succ.get(e.fromNodeId)!.push(e.toNodeId);
  }
  const map = new Map<string, CompiledNode>();
  for (const id of ids) {
    map.set(id, {
      node: node(id),
      spec: {} as CompiledNode['spec'],
      predecessors: pred.get(id)!,
      successors: succ.get(id)!,
    });
  }
  return map;
}

describe('analyzeTopology', () => {
  it('identifies entry (in-degree 0) and exit (out-degree 0) nodes in a line', () => {
    // a -> b -> c
    const t = analyzeTopology([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    expect(t.entryNodes.map((n) => n.id)).toEqual(['a']);
    expect(t.exitNodes.map((n) => n.id)).toEqual(['c']);
  });

  it('treats an isolated node as both entry and exit', () => {
    const t = analyzeTopology([node('solo')], []);
    expect(t.entryNodes.map((n) => n.id)).toEqual(['solo']);
    expect(t.exitNodes.map((n) => n.id)).toEqual(['solo']);
  });

  it('builds correct predecessor and successor maps for a diamond', () => {
    // a -> b, a -> c, b -> d, c -> d
    const t = analyzeTopology(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
    );
    expect([...(t.predecessorsByNode.get('d') ?? [])].sort()).toEqual(['b', 'c']);
    expect([...(t.successorsByNode.get('a') ?? [])].sort()).toEqual(['b', 'c']);
    expect(t.entryNodes.map((n) => n.id)).toEqual(['a']);
    expect(t.exitNodes.map((n) => n.id)).toEqual(['d']);
  });

  it('reports multiple entries and exits when the graph has them', () => {
    // a -> c, b -> c, c -> d, c -> e
    const t = analyzeTopology(
      [node('a'), node('b'), node('c'), node('d'), node('e')],
      [edge('a', 'c'), edge('b', 'c'), edge('c', 'd'), edge('c', 'e')]
    );
    expect(t.entryNodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(t.exitNodes.map((n) => n.id).sort()).toEqual(['d', 'e']);
  });

  it('yields zero entry nodes for a pure cycle (how the compiler detects cycles)', () => {
    // a -> b -> a : every node has in-degree >= 1, so no entry exists.
    const t = analyzeTopology([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
    expect(t.entryNodes).toHaveLength(0);
    expect(t.exitNodes).toHaveLength(0);
  });
});

describe('computeAncestors', () => {
  it('returns an empty list for an entry node with no predecessors', () => {
    const map = compiledMap(['a', 'b'], [edge('a', 'b')]);
    expect(computeAncestors('a', map)).toEqual([]);
  });

  it('returns the single ancestor of a 2-node line', () => {
    const map = compiledMap(['a', 'b'], [edge('a', 'b')]);
    expect(computeAncestors('b', map)).toEqual(['a']);
  });

  it('returns ancestors in forward-topological (data-flow) order for a line', () => {
    // a -> b -> c -> d ; ancestors of d are [a, b, c] in that order
    const map = compiledMap(['a', 'b', 'c', 'd'], [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]);
    expect(computeAncestors('d', map)).toEqual(['a', 'b', 'c']);
  });

  it('orders a diamond so the root precedes the two middles', () => {
    // a -> b, a -> c, b -> d, c -> d ; ancestors of d = {a,b,c}, with a first
    const map = compiledMap(
      ['a', 'b', 'c', 'd'],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]
    );
    const ancestors = computeAncestors('d', map);
    expect(ancestors.sort()).toEqual(['a', 'b', 'c']);
    // `a` must come before both `b` and `c` in topological order.
    const order = computeAncestors('d', map);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
  });
});
