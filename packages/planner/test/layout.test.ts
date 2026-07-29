import type { PipelineEdgeRow, PipelineNodeRow } from '@openpipeline/core';
import { describe, expect, it } from 'vitest';

import { computeLayeredPositions } from '../src/layout.js';

type DraftNode = Omit<PipelineNodeRow, 'pipelineId'>;
type DraftEdge = Omit<PipelineEdgeRow, 'pipelineId'>;

function node(id: string): DraftNode {
  return { id, nodeType: 'TOOL', key: 'tool.x', label: id, inputs: {} };
}

function edge(from: string, to: string): DraftEdge {
  return { id: `${from}->${to}`, fromNodeId: from, toNodeId: to };
}

describe('computeLayeredPositions (D6)', () => {
  it('places a linear chain in increasing depth columns, one per row (y=0)', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('b', 'c')];

    const positioned = computeLayeredPositions(nodes, edges);

    expect(positioned.map((n) => [n.id, n.positionX, n.positionY])).toEqual([
      ['a', 0, 0],
      ['b', 280, 0],
      ['c', 560, 0],
    ]);
  });

  it('stacks siblings at the same depth by original array order (y increases by 120)', () => {
    const nodes = [node('root'), node('left'), node('right')];
    const edges = [edge('root', 'left'), edge('root', 'right')];

    const positioned = computeLayeredPositions(nodes, edges);
    const byId = new Map(positioned.map((n) => [n.id, n]));

    expect(byId.get('root')).toMatchObject({ positionX: 0, positionY: 0 });
    expect(byId.get('left')).toMatchObject({ positionX: 280, positionY: 0 });
    expect(byId.get('right')).toMatchObject({ positionX: 280, positionY: 120 });
  });

  it('gives every disconnected zero-edge node its own depth-0 column entry (BFS, first-visit wins)', () => {
    const nodes = [node('x'), node('y')];
    const positioned = computeLayeredPositions(nodes, []);

    expect(positioned).toEqual([
      { ...node('x'), positionX: 0, positionY: 0 },
      { ...node('y'), positionX: 0, positionY: 120 },
    ]);
  });

  it('skips a dangling edge for layout purposes instead of throwing', () => {
    const nodes = [node('a')];
    const edges = [edge('a', 'ghost')]; // "ghost" is not a declared node

    const positioned = computeLayeredPositions(nodes, edges);

    expect(positioned).toEqual([{ ...node('a'), positionX: 0, positionY: 0 }]);
  });

  it('falls back an unreached (pure-cycle) node to depth 0 rather than leaving it unpositioned', () => {
    const nodes = [node('p'), node('q')];
    const edges = [edge('p', 'q'), edge('q', 'p')]; // 2-node cycle, no external entry

    const positioned = computeLayeredPositions(nodes, edges);

    expect(positioned.every((n) => typeof n.positionX === 'number')).toBe(true);
    expect(positioned.every((n) => typeof n.positionY === 'number')).toBe(true);
  });
});
