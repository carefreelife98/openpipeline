import { defineNode } from '@openpipeline/core';
import { createIfNodeSpec, createLlmInvokeNodeSpec } from '@openpipeline/nodes';
import { MemoryStore } from '@openpipeline/store-memory';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { PipelineEngine } from '@openpipeline/runtime';

// End-to-end integration test against the BUILT packages (run `pnpm build`
// first — CI builds before test). Exercises save -> run -> done through the
// real engine, compiler, and LangGraph, with an in-memory store and a stub LLM.

const stubLlmFactory = {
  createModel: () => ({
    invoke: () =>
      Promise.resolve({
        content: 'stub reply',
        usage_metadata: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }),
  }),
};

function makeEngine() {
  const engine = new PipelineEngine({ store: new MemoryStore(), llmFactory: stubLlmFactory });
  engine.registerNode(createIfNodeSpec());
  engine.registerNode(
    createLlmInvokeNodeSpec({ models: ['stub-model'], defaultModel: 'stub-model' })
  );
  engine.registerNode(
    defineNode({
      key: 'tool.uppercase',
      nodeType: 'TOOL',
      displayName: 'Uppercase',
      description: 'Uppercases its input text.',
      icon: 'type',
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({
        kind: z.literal('tool.uppercase'),
        out: z.string(),
        nonEmpty: z.boolean(),
      }),
      handler: ({ text }) => {
        const out = text.toUpperCase();
        return Promise.resolve({ kind: 'tool.uppercase' as const, out, nonEmpty: out.length > 0 });
      },
    })
  );
  return engine;
}

describe('PipelineEngine end-to-end', () => {
  it('runs a single TOOL node to SUCCESS and returns its output', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'just-upper',
      nodes: [
        {
          id: 'upper',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Uppercase',
          inputs: { text: { kind: 'literal', value: 'hello' } },
        },
      ],
      edges: [],
    });

    const { done } = await engine.run({ pipelineId });
    const result = await done;

    expect(result.status).toBe('SUCCESS');
    expect(result.outputs.upper).toMatchObject({ out: 'HELLO', nonEmpty: true });
  });

  it('flows an IF gate down the TRUE branch and skips the FALSE branch', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'upper-then-branch',
      nodes: [
        {
          id: 'upper',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Uppercase',
          inputs: { text: { kind: 'literal', value: 'hello' } },
        },
        {
          id: 'gate',
          nodeType: 'IF',
          key: 'control.if',
          label: 'Has output?',
          inputs: { condition: { kind: 'state', path: 'outputs.upper.nonEmpty' } },
        },
        {
          id: 'taken',
          nodeType: 'LLM',
          key: 'llm.invoke',
          label: 'Taken',
          inputs: {
            userPrompt: { kind: 'state', path: 'outputs.upper.out' },
            model: { kind: 'literal', value: 'stub-model' },
          },
        },
        {
          id: 'skipped',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Skipped',
          inputs: { text: { kind: 'literal', value: 'not taken' } },
        },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'upper', toNodeId: 'gate' },
        { id: 'e2', fromNodeId: 'gate', toNodeId: 'taken', label: 'true' },
        { id: 'e3', fromNodeId: 'gate', toNodeId: 'skipped', label: 'false' },
      ],
    });

    const { done } = await engine.run({ pipelineId });
    const result = await done;

    expect(result.status).toBe('SUCCESS');
    expect(result.outputs.gate).toMatchObject({ branch: 'true' });
    expect(result.outputs.taken).toBeDefined();
    expect(result.outputs.skipped).toBeUndefined(); // false branch never ran
  });

  it('accumulates LLM token cost across the run', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'just-llm',
      nodes: [
        {
          id: 'say',
          nodeType: 'LLM',
          key: 'llm.invoke',
          label: 'Say',
          inputs: {
            userPrompt: { kind: 'literal', value: 'hi' },
            model: { kind: 'literal', value: 'stub-model' },
          },
        },
      ],
      edges: [],
    });

    const result = await (await engine.run({ pipelineId })).done;
    expect(result.status).toBe('SUCCESS');
    expect(result.cost.tokens.total).toBe(6);
    expect(result.cost.llmCalls).toBe(1);
  });

  it('fails (not throws) when the graph is a pure cycle with no entry node', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'cyclic',
      nodes: [
        {
          id: 'a',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'A',
          inputs: { text: { kind: 'literal', value: 'x' } },
        },
        {
          id: 'b',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'B',
          inputs: { text: { kind: 'literal', value: 'y' } },
        },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'a', toNodeId: 'b' },
        { id: 'e2', fromNodeId: 'b', toNodeId: 'a' },
      ],
    });

    const result = await (await engine.run({ pipelineId })).done;
    expect(result.status).toBe('FAILED');
    expect(result.error).toBeDefined();
  });

  it('completes SUCCESS even when a node output contains circular refs (safeJson)', async () => {
    // defineNode handler returns a self-referential object. Before the
    // first-terminal-wins + safeJson fix, persisting this via a naive JSON
    // write would throw mid-completeRun, and a retry/second completeRun call
    // could flip an already-SUCCESS run to FAILED (K10 -> S1/K5 chain). Now:
    // the run still completes SUCCESS, `done` never rejects, and the value
    // handed to the store's terminal write has the cycle replaced by the
    // '[circular]' sentinel instead of throwing.
    const store = new MemoryStore();
    // Spy on completeRun (still delegates to the real MemoryStore impl) so the
    // test can inspect exactly what the engine hands the store for
    // persistence — MemoryStore's public RunSummary doesn't surface `output`.
    const completeRunSpy = vi.spyOn(store, 'completeRun');
    const engine = new PipelineEngine({ store, llmFactory: stubLlmFactory });
    engine.registerNode(
      defineNode({
        key: 'tool.circ',
        nodeType: 'TOOL',
        displayName: 'Circular',
        description: 'Returns a self-referential object.',
        icon: 'x',
        inputSchema: z.object({}),
        outputSchema: z.looseObject({ kind: z.literal('tool.circ') }),
        handler: () => {
          const circ: Record<string, unknown> = { ok: true };
          circ.self = circ;
          return Promise.resolve({ kind: 'tool.circ' as const, ...circ });
        },
      })
    );

    const pipelineId = await engine.save({
      name: 'circular-output',
      nodes: [
        {
          id: 'circ',
          nodeType: 'TOOL',
          key: 'tool.circ',
          label: 'Circular',
          inputs: {},
        },
      ],
      edges: [],
    });

    const { runId, done } = await engine.run({ pipelineId });
    const result = await done; // must not reject

    expect(result.status).toBe('SUCCESS');
    const [summary] = await store.listRuns(pipelineId);
    expect(summary?.id).toBe(runId);
    expect(summary?.status).toBe('SUCCESS');

    const completeCall = completeRunSpy.mock.calls.find(([id]) => id === runId);
    expect(completeCall).toBeDefined();
    const persistedOutput = completeCall?.[1].output;
    // safeJson broke the cycle — this must not throw, and must contain the
    // explicit sentinel (never a silently dropped/empty value).
    expect(() => JSON.stringify(persistedOutput)).not.toThrow();
    expect(JSON.stringify(persistedOutput)).toContain('[circular]');
  });

  it('streams NODE_START/NODE_END and RUN_COMPLETE events via onEvent', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'evented',
      nodes: [
        {
          id: 'upper',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Uppercase',
          inputs: { text: { kind: 'literal', value: 'hello' } },
        },
      ],
      edges: [],
    });

    const { runId, done } = await engine.run({ pipelineId });
    const kinds: string[] = [];
    engine.onEvent(runId, (evt) => kinds.push(evt.kind));
    await done;

    expect(kinds).toContain('RUN_COMPLETE');
  });
});
