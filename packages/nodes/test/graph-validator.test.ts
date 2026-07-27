import type {
  NodeSpec,
  PipelineEdgeRow,
  PipelineNodeRow,
  PipelineWithGraph,
} from '@openpipeline/core';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { validateGraph } from '../src/graph-validator.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<NodeSpec> = {}): NodeSpec {
  return {
    key: 'tool.x',
    nodeType: 'TOOL',
    displayName: 'X',
    description: 'a test node',
    icon: 'x',
    inputSchema: z.object({}),
    outputSchema: z.object({ kind: z.literal('tool.x') }),
    handler: () => Promise.resolve({ kind: 'tool.x' }),
    ...overrides,
  };
}

function makeNode(id: string, overrides: Partial<PipelineNodeRow> = {}): PipelineNodeRow {
  return {
    id,
    pipelineId: 'p1',
    nodeType: 'TOOL',
    key: 'tool.x',
    label: id,
    inputs: {},
    ...overrides,
  };
}

/**
 * `'A>B'` -> an edge A->B. Every id seen in an edge token (plus `extraNodeIds`)
 * becomes a node, so tests can express a graph shape tersely.
 */
function graphOf(edgeSpecs: string[], extraNodeIds: string[] = []): PipelineWithGraph {
  const ids = new Set<string>(extraNodeIds);
  const edges: PipelineEdgeRow[] = edgeSpecs.map((spec, i) => {
    const [from, to] = spec.split('>');
    if (!from || !to) throw new Error(`bad edge spec: "${spec}"`);
    ids.add(from);
    ids.add(to);
    return { id: `e${String(i)}`, pipelineId: 'p1', fromNodeId: from, toNodeId: to };
  });
  const nodes = [...ids].map((id) => makeNode(id));
  return {
    pipeline: { id: 'p1', name: 'p1', createdAt: new Date(0), updatedAt: new Date(0) },
    nodes,
    edges,
  };
}

function getNode(graph: PipelineWithGraph, id: string): PipelineNodeRow {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`test fixture bug: no node "${id}" in graph`);
  return node;
}

/** One default spec per node in `graph`, keyed by nodeId, with per-node overrides. */
function specsFor(
  graph: PipelineWithGraph,
  overrides: Record<string, Partial<NodeSpec>> = {}
): Map<string, NodeSpec> {
  const specs = new Map<string, NodeSpec>();
  for (const n of graph.nodes) {
    specs.set(n.id, makeSpec({ key: n.key, nodeType: n.nodeType, ...overrides[n.id] }));
  }
  return specs;
}

describe('validateGraph', () => {
  it('detects a downstream cycle even when an entry exists (TOPOLOGY_CYCLE)', () => {
    // A(entry) -> B -> C -> B: Kahn drains only A, leaving {B, C} residual.
    const graph = graphOf(['A>B', 'B>C', 'C>B']);
    const issues = validateGraph(graph, specsFor(graph));
    expect(issues.map((i) => i.code)).toContain('TOPOLOGY_CYCLE');
  });

  it('flags nodes unreachable from any entry (TOPOLOGY_UNREACHABLE)', () => {
    // A->B is a normal, reachable path. D<->E is a 2-node cycle with nothing
    // pointing into it from outside — under the confirmed semantics (ambiguity
    // resolution #7: a zero-indegree node is always its own entry, so a truly
    // isolated *zero-edge* node is valid, never flagged), the only way a node
    // ends up genuinely unreachable is a cyclic island with no external entry.
    const graph = graphOf(['A>B', 'D>E', 'E>D']);
    const issues = validateGraph(graph, specsFor(graph));
    const unreachableIds = issues
      .filter((i) => i.code === 'TOPOLOGY_UNREACHABLE')
      .map((i) => i.nodeId);
    expect(unreachableIds).toEqual(expect.arrayContaining(['D', 'E']));
  });

  it('remains VALID for an isolated single-node graph (no edges at all)', () => {
    // Ambiguity resolution #7, made explicit as its own case: entry === exit,
    // no edges — must not be flagged unreachable or cyclic.
    const graph = graphOf([], ['solo']);
    const issues = validateGraph(graph, specsFor(graph));
    expect(issues).toEqual([]);
  });

  it('flags an orphan node with no edges at all inside a multi-node graph (TOPOLOGY_UNREACHABLE)', () => {
    // A->B is a normal, reachable pipeline; ORPHAN has zero incoming and zero
    // outgoing edges. This is the brief's Step-1 case verbatim ("A(entry),
    // 고립 D") and is distinct from ambiguity resolution #7 (a *single*-node,
    // zero-edge graph is valid): here ORPHAN sits inside a larger graph that
    // has its own legitimate entries, so it is an authoring defect — the
    // compiler would otherwise silently wire it START->ORPHAN->END and run it
    // standalone. It must also not be reported as TOPOLOGY_CYCLE (it has no
    // edges, so it cannot be part of a cycle).
    const graph = graphOf(['A>B'], ['ORPHAN']);
    const issues = validateGraph(graph, specsFor(graph));
    expect(issues).toEqual([
      expect.objectContaining({ code: 'TOPOLOGY_UNREACHABLE', nodeId: 'ORPHAN' }),
    ]);
  });

  it('rejects persisted nodeType that differs from the resolved spec (NODE_TYPE_MISMATCH)', () => {
    const graph = graphOf([], ['gate']);
    const gateNode = getNode(graph, 'gate');
    gateNode.nodeType = 'IF';
    gateNode.key = 'control.if';
    const specs = new Map<string, NodeSpec>([
      // Persisted node claims IF, but the key resolves to a TOOL spec.
      ['gate', makeSpec({ key: 'control.if', nodeType: 'TOOL' })],
    ]);
    const issues = validateGraph(graph, specs);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'NODE_TYPE_MISMATCH', nodeId: 'gate' })
    );
  });

  it('flags required slots with no binding at all (INPUTS_REQUIRED_MISSING)', () => {
    const graph = graphOf([], ['n1']);
    const specs = specsFor(graph, { n1: { inputSchema: z.object({ text: z.string() }) } });
    const issues = validateGraph(graph, specs);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'INPUTS_REQUIRED_MISSING', nodeId: 'n1', slot: 'text' })
    );
  });

  it('does not flag optional or defaulted slots as missing', () => {
    const graph = graphOf([], ['n1']);
    const specs = specsFor(graph, {
      n1: {
        inputSchema: z.object({
          text: z.string().optional(),
          mode: z.string().default('x'),
        }),
      },
    });
    const issues = validateGraph(graph, specs);
    expect(issues).toEqual([]);
  });

  it('flags state paths whose source node does not exist (REF_SOURCE_MISSING)', () => {
    const graph = graphOf([], ['n1']);
    getNode(graph, 'n1').inputs = { text: { kind: 'state', path: 'outputs.ghost.out' } };
    const specs = specsFor(graph, { n1: { inputSchema: z.object({ text: z.string() }) } });
    const issues = validateGraph(graph, specs);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'REF_SOURCE_MISSING', nodeId: 'n1', slot: 'text' })
    );
  });

  it('flags state paths referencing a non-ancestor (REF_NOT_PREDECESSOR)', () => {
    // A -> B and A -> C are siblings; B reads C's output, but C is not an
    // ancestor of B (only A is).
    const graph = graphOf(['A>B', 'A>C']);
    getNode(graph, 'B').inputs = {
      text: { kind: 'state', path: 'outputs.C.out' },
    };
    const specs = specsFor(graph, { B: { inputSchema: z.object({ text: z.string() }) } });
    const issues = validateGraph(graph, specs);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'REF_NOT_PREDECESSOR', nodeId: 'B', slot: 'text' })
    );
  });

  it('accepts a state path referencing a real ancestor', () => {
    const graph = graphOf(['A>B']);
    getNode(graph, 'B').inputs = {
      text: { kind: 'state', path: 'outputs.A.out' },
    };
    const specs = specsFor(graph, { B: { inputSchema: z.object({ text: z.string() }) } });
    const issues = validateGraph(graph, specs);
    expect(issues).toEqual([]);
  });

  it('skips required-slot checking for a non-ZodObject inputSchema (e.g. MCP generic z.record)', () => {
    const graph = graphOf([], ['mcpNode']);
    const specs = specsFor(graph, { mcpNode: { inputSchema: z.record(z.string(), z.unknown()) } });
    const issues = validateGraph(graph, specs);
    expect(issues).toEqual([]);
  });

  it('skips nodes whose spec could not be resolved (leaves that to the registry error path)', () => {
    const graph = graphOf([], ['unresolved']);
    const issues = validateGraph(graph, new Map());
    expect(issues).toEqual([]);
  });

  // #14 — a multi-node graph with ZERO edges (every node independently
  // entry AND exit) is an intentionally parallel pipeline, not the
  // brief's orphan-inside-a-connected-graph defect. The compiler has
  // always supported multiple independent entry nodes.
  it('remains VALID for a multi-node graph with no edges at all — independent parallel entries, not orphans (#14)', () => {
    const graph = graphOf([], ['a', 'b', 'c']);
    const issues = validateGraph(graph, specsFor(graph));
    expect(issues).toEqual([]);
  });

  it('still flags a node with no incoming/outgoing edges when the graph DOES have edges elsewhere (#14 — narrower gate, not removed)', () => {
    // Unchanged from the pre-#14 behavior: A->B is a real connected
    // pipeline; ORPHAN sits disconnected inside it — still an authoring
    // defect once edges exist anywhere in the graph.
    const graph = graphOf(['A>B'], ['ORPHAN']);
    const issues = validateGraph(graph, specsFor(graph));
    expect(issues).toEqual([
      expect.objectContaining({ code: 'TOPOLOGY_UNREACHABLE', nodeId: 'ORPHAN' }),
    ]);
  });
});
