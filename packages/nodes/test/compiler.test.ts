import {
  RUN_DELIVERY_MODE,
  ZERO_COST,
  type NodeSpec,
  type PipelineEdgeRow,
  type PipelineNodeRow,
  type PipelineWithGraph,
} from '@openpipeline/core';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { createIfNodeSpec } from '../src/built-in/if-node.js';
import { PipelineCompiler, type CompilerDeps } from '../src/compiler.js';
import type { NodeResolveContext, NodeSpecRegistry } from '../src/registry.js';
import { ValueBindingResolver } from '../src/value-binding-resolver.js';

function makeGraph(pipelineId: string, nodeId: string, nodeKey: string): PipelineWithGraph {
  const node: PipelineNodeRow = {
    id: nodeId,
    pipelineId,
    nodeType: 'TOOL',
    key: nodeKey,
    label: nodeKey,
    inputs: {},
  };
  return {
    pipeline: {
      id: pipelineId,
      name: pipelineId,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    nodes: [node],
    edges: [],
  };
}

/**
 * A fake registry that resolves a NodeSpec whose `description` embeds the
 * exact `ctx` it was called with, after an artificial delay — so concurrent
 * `compile()` calls genuinely interleave around the `await`, not just race in
 * the same synchronous tick.
 */
function makeCapturingRegistry(delayMs: Record<string, number>): {
  registry: NodeSpecRegistry;
  captured: Array<{ key: string; ctx: NodeResolveContext }>;
} {
  const captured: Array<{ key: string; ctx: NodeResolveContext }> = [];
  const registry = {
    get: async (key: string, ctx: NodeResolveContext = {}): Promise<NodeSpec> => {
      captured.push({ key, ctx });
      const delay = delayMs[key] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        key,
        nodeType: 'TOOL',
        displayName: key,
        description: `userId=${ctx.userId ?? 'none'}`,
        icon: 'x',
        inputSchema: z.object({}),
        outputSchema: z.object({ kind: z.literal('tool.x') }),
        handler: () => Promise.resolve({ kind: 'tool.x' }),
      };
    },
  } as unknown as NodeSpecRegistry;
  return { registry, captured };
}

function makeDeps(registry: NodeSpecRegistry): CompilerDeps {
  return {
    registry,
    bindingResolver: { resolveExplicit: () => ({}) },
    stepRecorder: {
      start: () => Promise.resolve('step-1'),
      finish: () => Promise.resolve(undefined),
    },
    llmFactory: { createModel: () => ({}) },
  };
}

describe('PipelineCompiler.compile — per-call resolveContext (#E5)', () => {
  it("two concurrent MCP compiles do not leak each other's context", async () => {
    // graphA resolves slower than graphB, so graphB's `compile()` call
    // completes first even though both start "at once" — a genuine interleave,
    // not just synchronous ordering.
    const { registry, captured } = makeCapturingRegistry({ 'tool.a': 20, 'tool.b': 5 });
    const compiler = new PipelineCompiler(makeDeps(registry));

    const graphA = makeGraph('pipeline-a', 'n1', 'tool.a');
    const graphB = makeGraph('pipeline-b', 'n1', 'tool.b');
    const ctxA: NodeResolveContext = { userId: 'user-A' };
    const ctxB: NodeResolveContext = { userId: 'user-B' };

    const [compiledA, compiledB] = await Promise.all([
      compiler.compile(graphA, ctxA),
      compiler.compile(graphB, ctxB),
    ]);

    expect(compiledA.nodeMap.get('n1')?.spec.description).toBe('userId=user-A');
    expect(compiledB.nodeMap.get('n1')?.spec.description).toBe('userId=user-B');

    // The registry itself was asked with each call's own ctx, never the other's.
    const forA = captured.find((c) => c.key === 'tool.a');
    const forB = captured.find((c) => c.key === 'tool.b');
    expect(forA?.ctx.userId).toBe('user-A');
    expect(forB?.ctx.userId).toBe('user-B');
  });

  it('defaults to an empty ctx when none is passed', async () => {
    const { registry } = makeCapturingRegistry({});
    const compiler = new PipelineCompiler(makeDeps(registry));
    const graph = makeGraph('pipeline-c', 'n1', 'tool.c');

    const compiled = await compiler.compile(graph);
    expect(compiled.nodeMap.get('n1')?.spec.description).toBe('userId=none');
  });
});

// ── K13: an IF node that is also a fan-in target ────────────────────────────
//
// Drives the real compiler + real LangGraph execution (no mocked runner) —
// verified against LangGraph's actual channel implementations
// (`node_modules/@langchain/langgraph/dist/channels/{ephemeral_value,last_value}.js`):
// a non-deferred node's trigger channel is `EphemeralValue(guard: false)`,
// which becomes available (and fires the node) on the *first* predecessor
// write; a deferred node's trigger channel is `LastValueAfterFinish`, which
// only becomes available once `finish()` is called — i.e. once the step no
// longer advances anything else, so it coalesces every predecessor's write
// into exactly one trigger. With two *unconditional* parents that complete at
// different graph depths (asymmetric fan-in), a non-deferred IF would
// therefore fire once after the shallower parent's write and AGAIN after the
// deeper parent's write — a real double-run, not merely a theoretical one.

function makeFlagToolSpec(key: string, flag: boolean): NodeSpec {
  return {
    key,
    nodeType: 'TOOL',
    displayName: key,
    description: `emits { flag: ${String(flag)} }`,
    icon: 'x',
    inputSchema: z.object({}),
    outputSchema: z.object({ kind: z.literal(key), flag: z.boolean() }),
    handler: () => Promise.resolve({ kind: key, flag }),
  };
}

describe('PipelineCompiler — K13 (IF x fan-in)', () => {
  it('an IF node that is also a fan-in target evaluates exactly once and routes correctly', async () => {
    // Shape (`gate` is the node under test — an IF that is ALSO a fan-in
    // target of two parents at ASYMMETRIC depth from START):
    //
    //   a -----------------------\
    //                             --> gate --true--> t
    //   b1 -> b2 -----------------/            \-false-> f
    //
    // `a` is 1 hop from START; `b2` is 2 hops (via b1). Both always run
    // (neither is behind a skipped IF branch), so `gate`'s in-degree-2
    // fan-in must coalesce two writes that land in different supersteps —
    // exactly the "asymmetric fan-in would otherwise double-run" case the
    // compiler's `defer: true` comment describes.
    let gateCallCount = 0;
    const realIfSpec = createIfNodeSpec();
    const countingIfSpec: NodeSpec = {
      ...realIfSpec,
      handler: (input, ctx) => {
        gateCallCount++;
        return realIfSpec.handler(input, ctx);
      },
    };

    const specsByKey: Record<string, NodeSpec> = {
      'tool.a': makeFlagToolSpec('tool.a', true),
      'tool.b1': makeFlagToolSpec('tool.b1', true),
      'tool.b2': makeFlagToolSpec('tool.b2', true),
      'control.if': countingIfSpec,
      'tool.t': makeFlagToolSpec('tool.t', true),
      'tool.f': makeFlagToolSpec('tool.f', true),
    };
    const registry = {
      get: (key: string) => {
        const spec = specsByKey[key];
        if (!spec) throw new Error(`no spec registered for "${key}"`);
        return Promise.resolve(spec);
      },
    } as unknown as NodeSpecRegistry;

    const nodes: PipelineNodeRow[] = [
      { id: 'a', pipelineId: 'p-k13', nodeType: 'TOOL', key: 'tool.a', label: 'A', inputs: {} },
      { id: 'b1', pipelineId: 'p-k13', nodeType: 'TOOL', key: 'tool.b1', label: 'B1', inputs: {} },
      { id: 'b2', pipelineId: 'p-k13', nodeType: 'TOOL', key: 'tool.b2', label: 'B2', inputs: {} },
      {
        id: 'gate',
        pipelineId: 'p-k13',
        nodeType: 'IF',
        key: 'control.if',
        label: 'Gate',
        inputs: { condition: { kind: 'state', path: 'outputs.a.flag' } },
      },
      { id: 't', pipelineId: 'p-k13', nodeType: 'TOOL', key: 'tool.t', label: 'True', inputs: {} },
      { id: 'f', pipelineId: 'p-k13', nodeType: 'TOOL', key: 'tool.f', label: 'False', inputs: {} },
    ];
    const edges: PipelineEdgeRow[] = [
      { id: 'e1', pipelineId: 'p-k13', fromNodeId: 'a', toNodeId: 'gate' },
      { id: 'e2', pipelineId: 'p-k13', fromNodeId: 'b1', toNodeId: 'b2' },
      { id: 'e3', pipelineId: 'p-k13', fromNodeId: 'b2', toNodeId: 'gate' },
      { id: 'e4', pipelineId: 'p-k13', fromNodeId: 'gate', toNodeId: 't', label: 'true' },
      { id: 'e5', pipelineId: 'p-k13', fromNodeId: 'gate', toNodeId: 'f', label: 'false' },
    ];
    const graph: PipelineWithGraph = {
      pipeline: {
        id: 'p-k13',
        name: 'k13-if-fanin',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      nodes,
      edges,
    };

    // gate is a fan-in target (predecessors a, b2 -> in-degree 2), asserted
    // directly so this test still means something if the compiler's fan-in
    // threshold ever changes.
    const gateInDegree = edges.filter((e) => e.toNodeId === 'gate').length;
    expect(gateInDegree).toBe(2);

    const deps: CompilerDeps = {
      registry,
      bindingResolver: new ValueBindingResolver(),
      stepRecorder: {
        start: () => Promise.resolve('step-1'),
        finish: () => Promise.resolve(undefined),
      },
      llmFactory: { createModel: () => ({}) },
    };
    const compiler = new PipelineCompiler(deps);
    const compiled = await compiler.compile(graph);

    const initialState = {
      meta: {
        runId: 'run-k13',
        pipelineId: graph.pipeline.id,
        pipelineName: graph.pipeline.name,
        pipelineDescription: '',
        deliveryMode: RUN_DELIVERY_MODE.INVOKE,
      },
      outputs: {},
      nodeMeta: {},
      cost: ZERO_COST,
      events: [],
    };

    const result = (await compiled.app.invoke(initialState)) as {
      outputs: Record<string, { branch?: string; flag?: boolean } | undefined>;
    };

    // Both fan-in parents actually ran.
    expect(result.outputs.a).toBeDefined();
    expect(result.outputs.b2).toBeDefined();

    // gate (fan-in target of a/b2, at asymmetric depth) ran exactly once —
    // not twice (double-fired once per predecessor write landing in a
    // different superstep).
    expect(gateCallCount).toBe(1);
    expect(result.outputs.gate).toMatchObject({ branch: 'true' });
    expect(result.outputs.t).toBeDefined();
    expect(result.outputs.f).toBeUndefined();
  });
});
