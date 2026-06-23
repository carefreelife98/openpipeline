import type { Edge as RfEdge, Node as RfNode } from '@xyflow/react';
import { describe, it, expect } from 'vitest';

import {
  START_MARKER_ID,
  END_MARKER_ID,
  DEFAULT_START_MARKER,
  DEFAULT_END_MARKER,
  startEdgeIdFor,
  endEdgeIdFor,
} from '../src/lib/markers.js';
import {
  buildDisplayNodes,
  mergeDisplayNodes,
  buildDisplayEdges,
  stripMarkers,
} from '../src/lib/serializer.js';
import type { BuilderNode, BuilderEdge } from '../src/types.js';

// The serializer is the boundary between persisted graph state (BuilderNode /
// BuilderEdge) and the on-screen ReactFlow representation. Its central contract
// (stated at the top of serializer.ts): the START/END markers are display-only —
// always injected for display, never present in stored state. We test that
// invariant from both directions plus the marker-edge round-trip.

function builderNode(id: string, overrides: Partial<BuilderNode> = {}): BuilderNode {
  return {
    id,
    nodeType: 'TOOL',
    key: 'tool.noop',
    label: id,
    inputs: {},
    ...overrides,
  };
}

describe('buildDisplayNodes', () => {
  it('always prepends a start marker and appends an end marker', () => {
    const rf = buildDisplayNodes([]);
    expect(rf).toHaveLength(2);
    expect(rf[0]?.id).toBe(START_MARKER_ID);
    expect(rf[0]?.type).toBe('startMarker');
    expect(rf[rf.length - 1]?.id).toBe(END_MARKER_ID);
    expect(rf[rf.length - 1]?.type).toBe('endMarker');
  });

  it('wraps user nodes between the markers with pipelineNode type and node data', () => {
    const rf = buildDisplayNodes([builderNode('a'), builderNode('b')]);
    expect(rf.map((n) => n.id)).toEqual([START_MARKER_ID, 'a', 'b', END_MARKER_ID]);
    const a = rf[1];
    expect(a?.type).toBe('pipelineNode');
    expect((a?.data as { node: BuilderNode }).node.id).toBe('a');
  });

  it('makes both markers non-deletable', () => {
    const rf = buildDisplayNodes([]);
    expect(rf[0]?.deletable).toBe(false);
    expect(rf[1]?.deletable).toBe(false);
  });

  it('falls back to default marker positions when none are supplied', () => {
    const rf = buildDisplayNodes([]);
    expect(rf[0]?.position).toEqual(DEFAULT_START_MARKER);
    expect(rf[1]?.position).toEqual(DEFAULT_END_MARKER);
  });

  it('uses supplied marker positions when provided', () => {
    const rf = buildDisplayNodes([], { x: 5, y: 6 }, { x: 7, y: 8 });
    expect(rf[0]?.position).toEqual({ x: 5, y: 6 });
    expect(rf[rf.length - 1]?.position).toEqual({ x: 7, y: 8 });
  });

  it('uses custom marker labels when provided, defaulting to Start/End', () => {
    const def = buildDisplayNodes([]);
    expect((def[0]?.data as { label: string }).label).toBe('Start');
    expect((def[1]?.data as { label: string }).label).toBe('End');

    const custom = buildDisplayNodes([], null, null, { start: '시작', end: '끝' });
    expect((custom[0]?.data as { label: string }).label).toBe('시작');
    expect((custom[custom.length - 1]?.data as { label: string }).label).toBe('끝');
  });

  it('uses the node stored position, falling back to (300,200) when absent', () => {
    const rf = buildDisplayNodes([
      builderNode('placed', { positionX: 11, positionY: 22 }),
      builderNode('unplaced'),
    ]);
    expect(rf[1]?.position).toEqual({ x: 11, y: 22 });
    expect(rf[2]?.position).toEqual({ x: 300, y: 200 });
  });
});

describe('mergeDisplayNodes', () => {
  it('preserves the on-screen (drag) position of an existing non-marker node', () => {
    const prev: RfNode[] = [
      { id: 'a', type: 'pipelineNode', position: { x: 999, y: 888 }, data: {}, selected: true },
    ];
    const fresh = buildDisplayNodes([builderNode('a', { positionX: 1, positionY: 2 })]);
    const merged = mergeDisplayNodes(prev, fresh);
    const a = merged.find((n) => n.id === 'a');
    // Transient drag position from prev wins over the store position.
    expect(a?.position).toEqual({ x: 999, y: 888 });
    expect(a?.selected).toBe(true);
  });

  it('keeps marker positions from fresh, never from prev', () => {
    const prev: RfNode[] = [
      {
        id: START_MARKER_ID,
        type: 'startMarker',
        position: { x: 1000, y: 1000 },
        data: {},
      },
    ];
    const fresh = buildDisplayNodes([], { x: 12, y: 34 });
    const merged = mergeDisplayNodes(prev, fresh);
    const start = merged.find((n) => n.id === START_MARKER_ID);
    expect(start?.position).toEqual({ x: 12, y: 34 });
  });

  it('passes through fresh nodes that have no prev counterpart', () => {
    const fresh = buildDisplayNodes([builderNode('new', { positionX: 7, positionY: 9 })]);
    const merged = mergeDisplayNodes([], fresh);
    const newNode = merged.find((n) => n.id === 'new');
    expect(newNode?.position).toEqual({ x: 7, y: 9 });
  });

  it('defaults selected to false when prev had no selection flag', () => {
    const prev: RfNode[] = [{ id: 'a', type: 'pipelineNode', position: { x: 1, y: 2 }, data: {} }];
    const fresh = buildDisplayNodes([builderNode('a')]);
    const merged = mergeDisplayNodes(prev, fresh);
    expect(merged.find((n) => n.id === 'a')?.selected).toBe(false);
  });
});

describe('buildDisplayEdges', () => {
  function builderEdge(id: string, from: string, to: string, label?: string | null): BuilderEdge {
    return { id, fromNodeId: from, toNodeId: to, label };
  }

  it('maps a plain user edge to source/target with no branch handle', () => {
    const edges = buildDisplayEdges([builderEdge('e1', 'a', 'b')], [], []);
    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e?.id).toBe('e1');
    expect(e?.source).toBe('a');
    expect(e?.target).toBe('b');
    expect(e?.sourceHandle).toBeUndefined();
    expect(e?.type).toBe('deletable');
  });

  it('attaches a branch-<label> source handle for true/false IF edges', () => {
    const edges = buildDisplayEdges(
      [builderEdge('t', 'if', 'x', 'true'), builderEdge('f', 'if', 'y', 'false')],
      [],
      []
    );
    expect(edges.find((e) => e.id === 't')?.sourceHandle).toBe('branch-true');
    expect(edges.find((e) => e.id === 'f')?.sourceHandle).toBe('branch-false');
  });

  it('does not treat an arbitrary label as a branch handle', () => {
    const edges = buildDisplayEdges([builderEdge('e', 'a', 'b', 'maybe')], [], []);
    expect(edges[0]?.sourceHandle).toBeUndefined();
  });

  it('synthesizes start-marker edges for each start target', () => {
    const edges = buildDisplayEdges([], ['a', 'b'], []);
    const startEdges = edges.filter((e) => e.source === START_MARKER_ID);
    expect(startEdges.map((e) => e.id)).toEqual([startEdgeIdFor('a'), startEdgeIdFor('b')]);
    expect(startEdges.map((e) => e.target)).toEqual(['a', 'b']);
    expect(startEdges.every((e) => e.reconnectable === false)).toBe(true);
  });

  it('synthesizes end-marker edges for each end source', () => {
    const edges = buildDisplayEdges([], [], ['x']);
    const endEdges = edges.filter((e) => e.target === END_MARKER_ID);
    expect(endEdges.map((e) => e.id)).toEqual([endEdgeIdFor('x')]);
    expect(endEdges[0]?.source).toBe('x');
  });

  it('emits user edges first, then marker edges', () => {
    const edges = buildDisplayEdges([builderEdge('u', 'a', 'b')], ['a'], ['b']);
    expect(edges).toHaveLength(3);
    expect(edges[0]?.id).toBe('u');
    expect(
      edges.slice(1).every((e) => e.source === START_MARKER_ID || e.target === END_MARKER_ID)
    ).toBe(true);
  });
});

describe('stripMarkers', () => {
  function edge(id: string, source: string, target: string): RfEdge {
    return { id, source, target };
  }

  it('separates start targets, end sources, and plain user edges', () => {
    const result = stripMarkers([
      edge(startEdgeIdFor('a'), START_MARKER_ID, 'a'),
      edge(endEdgeIdFor('b'), 'b', END_MARKER_ID),
      edge('u1', 'a', 'b'),
    ]);
    expect(result.startTargets).toEqual(['a']);
    expect(result.endSources).toEqual(['b']);
    expect(result.userEdges.map((e) => e.id)).toEqual(['u1']);
  });

  it('deduplicates repeated start targets and end sources', () => {
    const result = stripMarkers([
      edge('s1', START_MARKER_ID, 'a'),
      edge('s2', START_MARKER_ID, 'a'),
      edge('e1', 'b', END_MARKER_ID),
      edge('e2', 'b', END_MARKER_ID),
    ]);
    expect(result.startTargets).toEqual(['a']);
    expect(result.endSources).toEqual(['b']);
  });

  it('returns empty arrays when there are no edges', () => {
    const result = stripMarkers([]);
    expect(result.startTargets).toEqual([]);
    expect(result.endSources).toEqual([]);
    expect(result.userEdges).toEqual([]);
  });

  it('round-trips with buildDisplayEdges: stored edges survive, markers are recovered', () => {
    const userEdges: BuilderEdge[] = [{ id: 'u', fromNodeId: 'a', toNodeId: 'b', label: null }];
    const startTargets = ['a'];
    const endSources = ['b'];

    const display = buildDisplayEdges(userEdges, startTargets, endSources);
    const stripped = stripMarkers(display);

    expect(stripped.startTargets).toEqual(startTargets);
    expect(stripped.endSources).toEqual(endSources);
    expect(stripped.userEdges.map((e) => e.id)).toEqual(['u']);
  });
});
