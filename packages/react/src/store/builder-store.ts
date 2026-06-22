import { create } from 'zustand';
import type { ValueBinding, PipelineDraft } from '@openpipeline/core';
import type { BuilderNode, BuilderEdge } from '../types.js';

/** Derive entry (no incoming) and exit (no outgoing) nodes. */
function deriveEntryExit(
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ fromNodeId: string; toNodeId: string }>
): { startTargets: string[]; endSources: string[] } {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const e of edges) {
    incoming.set(e.toNodeId, (incoming.get(e.toNodeId) ?? 0) + 1);
    outgoing.set(e.fromNodeId, (outgoing.get(e.fromNodeId) ?? 0) + 1);
  }
  const startTargets: string[] = [];
  const endSources: string[] = [];
  for (const n of nodes) {
    if ((incoming.get(n.id) ?? 0) === 0) startTargets.push(n.id);
    if ((outgoing.get(n.id) ?? 0) === 0) endSources.push(n.id);
  }
  return { startTargets, endSources };
}

export interface BuilderState {
  pipelineId: string | null;
  name: string;
  description: string;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
  startTargets: string[];
  endSources: string[];
  startMarker: { x: number; y: number } | null;
  endMarker: { x: number; y: number } | null;
  selectedNodeId: string | null;
  /** Has the graph changed since the last save? Position/selection changes count. */
  dirty: boolean;

  // ── actions ──
  loadDraft(draft: PipelineDraft & { id?: string }): void;
  reset(): void;
  setName(name: string): void;
  setDescription(d: string): void;
  addNode(node: BuilderNode): void;
  removeNode(id: string): void;
  updateNodePosition(id: string, x: number, y: number): void;
  setNodePositions(positions: ReadonlyArray<{ id: string; x: number; y: number }>): void;
  updateMarkerPosition(which: 'start' | 'end', x: number, y: number): void;
  updateNodeLabel(id: string, label: string): void;
  updateNodeInput(nodeId: string, paramName: string, binding: ValueBinding): void;
  removeNodeInput(nodeId: string, paramName: string): void;
  addEdge(edge: BuilderEdge): void;
  removeEdge(edgeId: string): void;
  addStartTarget(nodeId: string): void;
  removeStartTarget(nodeId: string): void;
  addEndSource(nodeId: string): void;
  removeEndSource(nodeId: string): void;
  selectNode(id: string | null): void;
  markClean(): void;
  toDraft(): PipelineDraft;
}

const genId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `n_${Math.random().toString(36).slice(2)}`;

/**
 * Create a pipeline-builder store. Unlike the Mate-X original, this carries only
 * graph-editing state — no scope/purpose/category, no planner-compile progress,
 * no schedule. Env/auth-free; types come from @openpipeline/core.
 */
export function createBuilderStore() {
  return create<BuilderState>((set, get) => ({
    pipelineId: null,
    name: '',
    description: '',
    nodes: [],
    edges: [],
    startTargets: [],
    endSources: [],
    startMarker: null,
    endMarker: null,
    selectedNodeId: null,
    dirty: false,

    loadDraft(draft) {
      const nodes: BuilderNode[] = draft.nodes.map((n) => ({
        id: n.id ?? genId(),
        nodeType: n.nodeType,
        key: n.key,
        label: n.label,
        inputs: { ...n.inputs },
        positionX: n.positionX,
        positionY: n.positionY,
      }));
      const edges: BuilderEdge[] = draft.edges.map((e) => ({
        id: e.id ?? genId(),
        fromNodeId: e.fromNodeId,
        toNodeId: e.toNodeId,
        label: e.label,
      }));
      const { startTargets, endSources } = deriveEntryExit(nodes, edges);
      set({
        pipelineId: draft.id ?? null,
        name: draft.name,
        description: draft.description ?? '',
        nodes,
        edges,
        startTargets,
        endSources,
        selectedNodeId: null,
        dirty: false,
      });
    },

    reset() {
      set({
        pipelineId: null,
        name: '',
        description: '',
        nodes: [],
        edges: [],
        startTargets: [],
        endSources: [],
        startMarker: null,
        endMarker: null,
        selectedNodeId: null,
        dirty: false,
      });
    },

    setName: (name) => set({ name, dirty: true }),
    setDescription: (description) => set({ description, dirty: true }),

    addNode: (node) => set((s) => ({ nodes: [...s.nodes, node], dirty: true })),

    removeNode: (id) =>
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== id),
        edges: s.edges.filter((e) => e.fromNodeId !== id && e.toNodeId !== id),
        startTargets: s.startTargets.filter((t) => t !== id),
        endSources: s.endSources.filter((t) => t !== id),
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        dirty: true,
      })),

    updateNodePosition: (id, x, y) =>
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, positionX: x, positionY: y } : n)),
        dirty: true,
      })),

    setNodePositions: (positions) =>
      set((s) => {
        const byId = new Map(positions.map((p) => [p.id, p]));
        let changed = false;
        const nodes = s.nodes.map((n) => {
          const p = byId.get(n.id);
          if (!p) return n;
          changed = true;
          return { ...n, positionX: p.x, positionY: p.y };
        });
        return changed ? { nodes, dirty: true } : {};
      }),

    updateMarkerPosition: (which, x, y) =>
      set((s) =>
        which === 'start'
          ? { startMarker: { x, y }, dirty: true }
          : { endMarker: { x, y }, dirty: true }
      ),

    updateNodeLabel: (id, label) =>
      set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, label } : n)), dirty: true })),

    updateNodeInput: (nodeId, paramName, binding) =>
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, inputs: { ...n.inputs, [paramName]: binding } } : n
        ),
        dirty: true,
      })),

    removeNodeInput: (nodeId, paramName) =>
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const inputs = { ...n.inputs };
          delete inputs[paramName];
          return { ...n, inputs };
        }),
        dirty: true,
      })),

    addEdge: (edge) =>
      set((s) => {
        const dup = s.edges.find(
          (e) =>
            e.fromNodeId === edge.fromNodeId &&
            e.toNodeId === edge.toNodeId &&
            e.label === edge.label
        );
        if (dup) return {};
        return { edges: [...s.edges, edge], dirty: true };
      }),

    removeEdge: (edgeId) =>
      set((s) => {
        const edges = s.edges.filter((e) => e.id !== edgeId);
        return edges.length !== s.edges.length ? { edges, dirty: true } : {};
      }),

    addStartTarget: (nodeId) =>
      set((s) =>
        s.startTargets.includes(nodeId)
          ? {}
          : { startTargets: [...s.startTargets, nodeId], dirty: true }
      ),
    removeStartTarget: (nodeId) =>
      set((s) => ({ startTargets: s.startTargets.filter((t) => t !== nodeId), dirty: true })),
    addEndSource: (nodeId) =>
      set((s) =>
        s.endSources.includes(nodeId) ? {} : { endSources: [...s.endSources, nodeId], dirty: true }
      ),
    removeEndSource: (nodeId) =>
      set((s) => ({ endSources: s.endSources.filter((t) => t !== nodeId), dirty: true })),

    selectNode: (id) => set({ selectedNodeId: id }),
    markClean: () => set({ dirty: false }),

    toDraft(): PipelineDraft {
      const s = get();
      return {
        id: s.pipelineId ?? undefined,
        name: s.name,
        description: s.description || undefined,
        nodes: s.nodes.map((n) => ({
          id: n.id,
          nodeType: n.nodeType,
          key: n.key,
          label: n.label,
          inputs: n.inputs,
          positionX: n.positionX,
          positionY: n.positionY,
        })),
        edges: s.edges.map((e) => ({
          id: e.id,
          fromNodeId: e.fromNodeId,
          toNodeId: e.toNodeId,
          label: e.label ?? null,
        })),
      };
    },
  }));
}

export type BuilderStore = ReturnType<typeof createBuilderStore>;
