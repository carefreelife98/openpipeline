import type { NodeSpec, PipelineNodeRow, PipelineWithGraph } from '@openpipeline/core';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { PipelineCompiler, type CompilerDeps } from '../src/compiler.js';
import type { NodeResolveContext, NodeSpecRegistry } from '../src/registry.js';

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
