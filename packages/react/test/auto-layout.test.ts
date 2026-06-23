import { describe, it, expect } from 'vitest';

import {
  layoutWithDagre,
  type LayoutInputNode,
  type LayoutInputEdge,
} from '../src/lib/auto-layout.js';

// layoutWithDagre is a pure wrapper over dagre: given measured node sizes and
// edges it returns a Map of node-id -> top-left {x,y}. We assert the contract
// (which nodes get positions, the top-left conversion, ordering along the rank
// direction) rather than exact dagre pixel output, which is an implementation
// detail of the layout engine.

function node(id: string, width = 160, height = 80): LayoutInputNode {
  return { id, width, height };
}

describe('layoutWithDagre', () => {
  it('returns an empty map for no nodes', () => {
    const result = layoutWithDagre([], []);
    expect(result.size).toBe(0);
  });

  it('returns a position for a single isolated node', () => {
    const result = layoutWithDagre([node('a')], []);
    expect(result.size).toBe(1);
    const pos = result.get('a');
    expect(pos).toBeDefined();
    expect(typeof pos?.x).toBe('number');
    expect(typeof pos?.y).toBe('number');
    expect(Number.isFinite(pos?.x)).toBe(true);
    expect(Number.isFinite(pos?.y)).toBe(true);
  });

  it('returns top-left coordinates, not dagre centers', () => {
    // dagre reports node centers; the helper subtracts half width/height to
    // convert to the top-left origin ReactFlow expects. With marginx=marginy=20
    // a single node's center sits at (20 + w/2, 20 + h/2), so the top-left is
    // exactly the margin (20, 20).
    const width = 100;
    const height = 40;
    const result = layoutWithDagre([{ id: 'solo', width, height }], []);
    const pos = result.get('solo');
    expect(pos).toEqual({ x: 20, y: 20 });
  });

  it('positions a position for every input node in a connected chain', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges: LayoutInputEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const result = layoutWithDagre(nodes, edges);
    expect([...result.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('orders a chain left-to-right by default (LR direction)', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges: LayoutInputEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const result = layoutWithDagre(nodes, edges);
    const ax = result.get('a')?.x ?? 0;
    const bx = result.get('b')?.x ?? 0;
    const cx = result.get('c')?.x ?? 0;
    expect(ax).toBeLessThan(bx);
    expect(bx).toBeLessThan(cx);
  });

  it('orders a chain top-to-bottom in TB direction', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges: LayoutInputEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const result = layoutWithDagre(nodes, edges, { direction: 'TB' });
    const ay = result.get('a')?.y ?? 0;
    const by = result.get('b')?.y ?? 0;
    const cy = result.get('c')?.y ?? 0;
    expect(ay).toBeLessThan(by);
    expect(by).toBeLessThan(cy);
  });

  it('ignores edges that reference unknown node ids', () => {
    // Dangling edges (target/source not in nodes) must not crash or invent
    // phantom nodes — only the real node should be laid out.
    const result = layoutWithDagre([node('a')], [{ source: 'a', target: 'ghost' }]);
    expect([...result.keys()]).toEqual(['a']);
  });

  it('lays out disconnected nodes without error', () => {
    const result = layoutWithDagre([node('a'), node('b')], []);
    expect(result.size).toBe(2);
    expect(result.get('a')).toBeDefined();
    expect(result.get('b')).toBeDefined();
  });

  it('is pure: repeated calls with the same input yield the same positions', () => {
    const nodes = [node('a'), node('b')];
    const edges: LayoutInputEdge[] = [{ source: 'a', target: 'b' }];
    const first = layoutWithDagre(nodes, edges);
    const second = layoutWithDagre(nodes, edges);
    expect(Object.fromEntries(first)).toEqual(Object.fromEntries(second));
  });
});
