import type { PipelineDraft } from '@openpipeline/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { createBuilderStore, type BuilderStore } from '../src/store/builder-store.js';
import type { BuilderNode, BuilderEdge } from '../src/types.js';

// The builder store is the editing model: it owns nodes/edges + the derived
// start/end target sets and a `dirty` flag. We exercise the action contract
// (mutations, cascades, dedup, draft round-trip) directly against a fresh store
// instance per test — no React, no canvas.

function node(id: string, overrides: Partial<BuilderNode> = {}): BuilderNode {
  return {
    id,
    nodeType: 'TOOL',
    key: 'tool.noop',
    label: id,
    inputs: {},
    ...overrides,
  };
}

function edge(id: string, from: string, to: string, label?: string | null): BuilderEdge {
  return { id, fromNodeId: from, toNodeId: to, label };
}

describe('createBuilderStore', () => {
  let store: BuilderStore;
  beforeEach(() => {
    store = createBuilderStore();
  });

  it('starts empty and clean', () => {
    const s = store.getState();
    expect(s.nodes).toEqual([]);
    expect(s.edges).toEqual([]);
    expect(s.startTargets).toEqual([]);
    expect(s.endSources).toEqual([]);
    expect(s.pipelineId).toBeNull();
    expect(s.dirty).toBe(false);
  });

  describe('addNode', () => {
    it('appends a node and marks the graph dirty', () => {
      store.getState().addNode(node('a'));
      expect(store.getState().nodes.map((n) => n.id)).toEqual(['a']);
      expect(store.getState().dirty).toBe(true);
    });

    it('preserves insertion order across multiple adds', () => {
      store.getState().addNode(node('a'));
      store.getState().addNode(node('b'));
      expect(store.getState().nodes.map((n) => n.id)).toEqual(['a', 'b']);
    });
  });

  describe('removeNode', () => {
    beforeEach(() => {
      const s = store.getState();
      s.addNode(node('a'));
      s.addNode(node('b'));
      s.addEdge(edge('e', 'a', 'b'));
      s.addStartTarget('a');
      s.addEndSource('b');
      s.selectNode('a');
      s.markClean();
    });

    it('removes the node', () => {
      store.getState().removeNode('a');
      expect(store.getState().nodes.map((n) => n.id)).toEqual(['b']);
    });

    it('cascades: drops edges touching the removed node (as source or target)', () => {
      store.getState().removeNode('a');
      expect(store.getState().edges).toEqual([]);
    });

    it('cascades: drops the node from startTargets and endSources', () => {
      store.getState().removeNode('a');
      expect(store.getState().startTargets).toEqual([]);
      // b is untouched as an end source.
      expect(store.getState().endSources).toEqual(['b']);
    });

    it('clears selection only when the removed node was selected', () => {
      store.getState().removeNode('a');
      expect(store.getState().selectedNodeId).toBeNull();
    });

    it('keeps selection when a different node is removed', () => {
      store.getState().removeNode('b');
      expect(store.getState().selectedNodeId).toBe('a');
    });

    it('marks dirty', () => {
      store.getState().removeNode('a');
      expect(store.getState().dirty).toBe(true);
    });
  });

  describe('addEdge', () => {
    beforeEach(() => {
      store.getState().addNode(node('a'));
      store.getState().addNode(node('b'));
      store.getState().markClean();
    });

    it('adds a new edge and marks dirty', () => {
      store.getState().addEdge(edge('e1', 'a', 'b'));
      expect(store.getState().edges.map((e) => e.id)).toEqual(['e1']);
      expect(store.getState().dirty).toBe(true);
    });

    it('ignores a duplicate edge (same from/to/label) and leaves state clean', () => {
      store.getState().addEdge(edge('e1', 'a', 'b'));
      store.getState().markClean();
      store.getState().addEdge(edge('e2', 'a', 'b'));
      // Duplicate rejected: still one edge, and the no-op did not re-dirty.
      expect(store.getState().edges.map((e) => e.id)).toEqual(['e1']);
      expect(store.getState().dirty).toBe(false);
    });

    it('treats same from/to but different label as distinct edges', () => {
      store.getState().addEdge(edge('t', 'a', 'b', 'true'));
      store.getState().addEdge(edge('f', 'a', 'b', 'false'));
      expect(store.getState().edges.map((e) => e.id)).toEqual(['t', 'f']);
    });
  });

  describe('removeEdge', () => {
    it('removes a matching edge and marks dirty', () => {
      const s = store.getState();
      s.addEdge(edge('e1', 'a', 'b'));
      s.markClean();
      s.removeEdge('e1');
      expect(store.getState().edges).toEqual([]);
      expect(store.getState().dirty).toBe(true);
    });

    it('is a no-op (stays clean) when the edge id is unknown', () => {
      store.getState().addEdge(edge('e1', 'a', 'b'));
      store.getState().markClean();
      store.getState().removeEdge('does-not-exist');
      expect(store.getState().edges.map((e) => e.id)).toEqual(['e1']);
      expect(store.getState().dirty).toBe(false);
    });
  });

  describe('start/end targets', () => {
    it('adds a start target once (idempotent) and marks dirty only on change', () => {
      store.getState().addStartTarget('a');
      expect(store.getState().startTargets).toEqual(['a']);
      store.getState().markClean();
      store.getState().addStartTarget('a');
      expect(store.getState().startTargets).toEqual(['a']);
      expect(store.getState().dirty).toBe(false);
    });

    it('adds an end source once (idempotent)', () => {
      store.getState().addEndSource('z');
      store.getState().addEndSource('z');
      expect(store.getState().endSources).toEqual(['z']);
    });

    it('removes a start target and marks dirty', () => {
      store.getState().addStartTarget('a');
      store.getState().markClean();
      store.getState().removeStartTarget('a');
      expect(store.getState().startTargets).toEqual([]);
      expect(store.getState().dirty).toBe(true);
    });

    it('removes an end source', () => {
      store.getState().addEndSource('z');
      store.getState().removeEndSource('z');
      expect(store.getState().endSources).toEqual([]);
    });
  });

  describe('node mutation actions', () => {
    beforeEach(() => {
      store.getState().addNode(node('a'));
      store.getState().markClean();
    });

    it('updateNodeLabel changes only the targeted node label', () => {
      store.getState().addNode(node('b'));
      store.getState().updateNodeLabel('a', 'Renamed');
      const nodes = store.getState().nodes;
      expect(nodes.find((n) => n.id === 'a')?.label).toBe('Renamed');
      expect(nodes.find((n) => n.id === 'b')?.label).toBe('b');
    });

    it('updateNodePosition sets x/y on the targeted node', () => {
      store.getState().updateNodePosition('a', 42, 99);
      const a = store.getState().nodes.find((n) => n.id === 'a');
      expect(a?.positionX).toBe(42);
      expect(a?.positionY).toBe(99);
    });

    it('updateNodeInput adds a binding under the param name', () => {
      store.getState().updateNodeInput('a', 'text', { kind: 'literal', value: 'hi' });
      expect(store.getState().nodes[0]?.inputs.text).toEqual({ kind: 'literal', value: 'hi' });
    });

    it('removeNodeInput deletes the binding immutably, leaving siblings intact', () => {
      const s = store.getState();
      s.updateNodeInput('a', 'keep', { kind: 'auto' });
      s.updateNodeInput('a', 'drop', { kind: 'auto' });
      s.removeNodeInput('a', 'drop');
      const inputs = store.getState().nodes[0]?.inputs ?? {};
      expect(Object.keys(inputs)).toEqual(['keep']);
    });

    it('setNodePositions applies multiple positions at once', () => {
      store.getState().addNode(node('b'));
      store.getState().setNodePositions([
        { id: 'a', x: 1, y: 2 },
        { id: 'b', x: 3, y: 4 },
      ]);
      const nodes = store.getState().nodes;
      expect(nodes.find((n) => n.id === 'a')).toMatchObject({ positionX: 1, positionY: 2 });
      expect(nodes.find((n) => n.id === 'b')).toMatchObject({ positionX: 3, positionY: 4 });
    });

    it('setNodePositions is a no-op (stays clean) when no id matches', () => {
      store.getState().setNodePositions([{ id: 'ghost', x: 9, y: 9 }]);
      expect(store.getState().dirty).toBe(false);
    });
  });

  describe('updateMarkerPosition', () => {
    it('sets the start marker position', () => {
      store.getState().updateMarkerPosition('start', 11, 22);
      expect(store.getState().startMarker).toEqual({ x: 11, y: 22 });
      expect(store.getState().endMarker).toBeNull();
    });

    it('sets the end marker position', () => {
      store.getState().updateMarkerPosition('end', 33, 44);
      expect(store.getState().endMarker).toEqual({ x: 33, y: 44 });
    });
  });

  describe('selection and dirty flag', () => {
    it('selectNode does not mark the graph dirty (selection is transient here)', () => {
      store.getState().selectNode('a');
      expect(store.getState().selectedNodeId).toBe('a');
      expect(store.getState().dirty).toBe(false);
    });

    it('markClean resets the dirty flag', () => {
      store.getState().addNode(node('a'));
      expect(store.getState().dirty).toBe(true);
      store.getState().markClean();
      expect(store.getState().dirty).toBe(false);
    });

    it('setName / setDescription mark dirty', () => {
      store.getState().setName('My pipeline');
      expect(store.getState().name).toBe('My pipeline');
      expect(store.getState().dirty).toBe(true);
      store.getState().markClean();
      store.getState().setDescription('desc');
      expect(store.getState().description).toBe('desc');
      expect(store.getState().dirty).toBe(true);
    });
  });

  describe('loadDraft', () => {
    const draft: PipelineDraft & { id?: string } = {
      id: 'p1',
      name: 'Loaded',
      description: 'a desc',
      nodes: [
        { id: 'a', nodeType: 'TOOL', key: 'tool.noop', label: 'A', inputs: {} },
        { id: 'b', nodeType: 'TOOL', key: 'tool.noop', label: 'B', inputs: {} },
        { id: 'c', nodeType: 'TOOL', key: 'tool.noop', label: 'C', inputs: {} },
      ],
      edges: [{ id: 'e', fromNodeId: 'a', toNodeId: 'b', label: null }],
    };

    it('hydrates id, name, description, nodes, and edges', () => {
      store.getState().loadDraft(draft);
      const s = store.getState();
      expect(s.pipelineId).toBe('p1');
      expect(s.name).toBe('Loaded');
      expect(s.description).toBe('a desc');
      expect(s.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
      expect(s.edges.map((e) => e.id)).toEqual(['e']);
    });

    it('lands clean (no unsaved changes) after loading', () => {
      store.getState().addNode(node('x'));
      expect(store.getState().dirty).toBe(true);
      store.getState().loadDraft(draft);
      expect(store.getState().dirty).toBe(false);
    });

    it('derives startTargets = nodes with no incoming edge', () => {
      store.getState().loadDraft(draft);
      // a has no incoming; c is isolated so also an entry.
      expect(store.getState().startTargets.sort()).toEqual(['a', 'c']);
    });

    it('derives endSources = nodes with no outgoing edge', () => {
      store.getState().loadDraft(draft);
      // b has no outgoing; c is isolated so also an exit. a has outgoing -> not an exit.
      expect(store.getState().endSources.sort()).toEqual(['b', 'c']);
    });

    it('defaults pipelineId to null and description to "" when absent', () => {
      const minimal: PipelineDraft = { name: 'min', nodes: [], edges: [] };
      store.getState().loadDraft(minimal);
      expect(store.getState().pipelineId).toBeNull();
      expect(store.getState().description).toBe('');
    });

    it('clears any prior selection on load', () => {
      store.getState().selectNode('old');
      store.getState().loadDraft(draft);
      expect(store.getState().selectedNodeId).toBeNull();
    });
  });

  describe('toDraft', () => {
    it('serializes current state back into a PipelineDraft', () => {
      const s = store.getState();
      s.setName('Out');
      s.setDescription('d');
      s.addNode(node('a', { positionX: 1, positionY: 2 }));
      s.addEdge(edge('e', 'a', 'a', 'true'));

      const draft = store.getState().toDraft();
      expect(draft.name).toBe('Out');
      expect(draft.description).toBe('d');
      expect(draft.nodes.map((n) => n.id)).toEqual(['a']);
      expect(draft.nodes[0]).toMatchObject({ positionX: 1, positionY: 2, label: 'a' });
      expect(draft.edges[0]).toMatchObject({
        id: 'e',
        fromNodeId: 'a',
        toNodeId: 'a',
        label: 'true',
      });
    });

    it('omits id when there is no loaded pipeline (id stays undefined)', () => {
      store.getState().setName('x');
      expect(store.getState().toDraft().id).toBeUndefined();
    });

    it('omits description when empty (undefined, not "")', () => {
      store.getState().setName('x');
      expect(store.getState().toDraft().description).toBeUndefined();
    });

    it('normalizes an undefined edge label to null in the draft', () => {
      store.getState().addNode(node('a'));
      store.getState().addEdge(edge('e', 'a', 'a')); // label undefined
      expect(store.getState().toDraft().edges[0]?.label).toBeNull();
    });

    it('round-trips loadDraft -> toDraft preserving graph shape', () => {
      const draft: PipelineDraft & { id?: string } = {
        id: 'rt',
        name: 'Round',
        description: 'trip',
        nodes: [
          {
            id: 'n1',
            nodeType: 'TOOL',
            key: 'tool.noop',
            label: 'N1',
            inputs: {},
            positionX: 5,
            positionY: 6,
          },
          { id: 'n2', nodeType: 'IF', key: 'control.if', label: 'N2', inputs: {} },
        ],
        edges: [{ id: 'edge1', fromNodeId: 'n1', toNodeId: 'n2', label: 'true' }],
      };
      store.getState().loadDraft(draft);
      const out = store.getState().toDraft();

      expect(out.id).toBe('rt');
      expect(out.name).toBe('Round');
      expect(out.description).toBe('trip');
      expect(out.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
      expect(out.nodes.find((n) => n.id === 'n1')).toMatchObject({ positionX: 5, positionY: 6 });
      expect(out.edges).toEqual([{ id: 'edge1', fromNodeId: 'n1', toNodeId: 'n2', label: 'true' }]);
    });
  });

  describe('reset', () => {
    it('clears the store back to its initial empty/clean state', () => {
      const s = store.getState();
      s.loadDraft({
        id: 'p',
        name: 'X',
        description: 'Y',
        nodes: [{ id: 'a', nodeType: 'TOOL', key: 'tool.noop', label: 'A', inputs: {} }],
        edges: [],
      });
      s.updateMarkerPosition('start', 1, 2);
      store.getState().reset();
      const after = store.getState();
      expect(after.pipelineId).toBeNull();
      expect(after.name).toBe('');
      expect(after.description).toBe('');
      expect(after.nodes).toEqual([]);
      expect(after.edges).toEqual([]);
      expect(after.startTargets).toEqual([]);
      expect(after.endSources).toEqual([]);
      expect(after.startMarker).toBeNull();
      expect(after.endMarker).toBeNull();
      expect(after.selectedNodeId).toBeNull();
      expect(after.dirty).toBe(false);
    });
  });

  it('isolates state between separate store instances', () => {
    const other = createBuilderStore();
    store.getState().addNode(node('a'));
    expect(store.getState().nodes).toHaveLength(1);
    expect(other.getState().nodes).toHaveLength(0);
  });
});
