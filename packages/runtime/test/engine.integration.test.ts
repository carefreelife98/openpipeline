import { getEventListeners } from 'node:events';

import { defineNode } from '@openpipeline/core';
import { createIfNodeSpec, createLlmInvokeNodeSpec } from '@openpipeline/nodes';
import { MemoryStore } from '@openpipeline/store-memory';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { PipelineEngine } from '@openpipeline/runtime';

function costNodeSpec(key: string, dollars: number) {
  return defineNode({
    key,
    nodeType: 'TOOL' as const,
    displayName: key,
    description: 'Reports a fixed dollar cost.',
    icon: 'x',
    inputSchema: z.object({}),
    outputSchema: z.object({ kind: z.literal(key) }),
    handler: (_i, ctx) => {
      ctx.reportCost({ tokens: { input: 0, output: 0, total: 0 }, dollars, llmCalls: 1 });
      return Promise.resolve({ kind: key });
    },
  });
}

function passNodeSpec(key: string) {
  return defineNode({
    key,
    nodeType: 'TOOL' as const,
    displayName: key,
    description: 'No-op pass-through node.',
    icon: 'x',
    inputSchema: z.object({}),
    outputSchema: z.object({ kind: z.literal(key) }),
    handler: () => Promise.resolve({ kind: key }),
  });
}

function slowNodeSpec(key: string, delayMs: number) {
  return defineNode({
    key,
    nodeType: 'TOOL' as const,
    displayName: key,
    description: 'Resolves after a real macrotask delay.',
    icon: 'x',
    inputSchema: z.object({}),
    outputSchema: z.object({ kind: z.literal(key) }),
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { kind: key };
    },
  });
}

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

  it('delivers the very first event (NODE_START) with no gap when onEvent is passed via RunOptions (#S11b)', async () => {
    // Before the fix, a consumer had to `await engine.run(...)` then separately
    // call `engine.onEvent(runId, ...)` — the run's async execution can emit
    // its first events during that gap, and they are lost (fire-and-forget, no
    // replay). Passing `onEvent` as part of RunOptions registers the listener
    // synchronously, before `execute()` is kicked off, closing the gap
    // structurally rather than by timing luck.
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'no-gap',
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

    const kinds: string[] = [];
    const { done } = await engine.run({ pipelineId, onEvent: (evt) => kinds.push(evt.kind) });
    await done;

    expect(kinds[0]).toBe('NODE_START');
    expect(kinds).toContain('RUN_COMPLETE');
  });

  it('abort() returns false for an unknown run and true for an in-flight one; isInFlight tracks the same lifecycle', async () => {
    const engine = makeEngine();

    // Unknown run: no-op, honestly reported as "nothing to abort".
    expect(engine.isInFlight('nonexistent')).toBe(false);
    expect(engine.abort('nonexistent')).toBe(false);

    const pipelineId = await engine.save({
      name: 'abort-me',
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
    // `run()` has already registered the controller in `inFlight` by the time
    // it resolves (before `execute()`'s first await settles), so this is
    // deterministic — no polling required.
    expect(engine.isInFlight(runId)).toBe(true);
    expect(engine.abort(runId)).toBe(true);

    const result = await done;
    expect(result.status).toBe('ABORTED');
    expect(engine.isInFlight(runId)).toBe(false);
    // Finished run: abort is now a no-op too.
    expect(engine.abort(runId)).toBe(false);
  });

  it('aborts the run with COST_CAP when accumulated dollars exceed costCapUsd', async () => {
    // Two $3 nodes chained, costCapUsd: 5 — the cap trips at the 2nd node's
    // boundary (3 -> ok, 3+3=6 > 5 -> COST_CAP), after that node has already
    // succeeded and billed (#K9 — node-boundary cap, not mid-handler preemption).
    const store = new MemoryStore();
    const completeRunSpy = vi.spyOn(store, 'completeRun');
    const engine = new PipelineEngine({ store, llmFactory: stubLlmFactory, costCapUsd: 5 });
    engine.registerNode(costNodeSpec('tool.cost3.a', 3));
    engine.registerNode(costNodeSpec('tool.cost3.b', 3));

    const pipelineId = await engine.save({
      name: 'cost-cap',
      nodes: [
        { id: 'a', nodeType: 'TOOL', key: 'tool.cost3.a', label: 'A', inputs: {} },
        { id: 'b', nodeType: 'TOOL', key: 'tool.cost3.b', label: 'B', inputs: {} },
      ],
      edges: [{ id: 'e1', fromNodeId: 'a', toNodeId: 'b' }],
    });

    const { runId, done } = await engine.run({ pipelineId });
    const result = await done;

    expect(result.status).toBe('FAILED');
    expect(result.error?.kind).toBe('COST_CAP');

    const call = completeRunSpy.mock.calls.find(([id]) => id === runId);
    expect(call?.[1].error?.kind).toBe('COST_CAP');
    expect(call?.[1].error?.code).toBe('COST_CAP');
  });

  it('runs to SUCCESS when accumulated dollars stay within costCapUsd', async () => {
    const engine = new PipelineEngine({
      store: new MemoryStore(),
      llmFactory: stubLlmFactory,
      costCapUsd: 100,
    });
    engine.registerNode(costNodeSpec('tool.cost3.c', 3));

    const pipelineId = await engine.save({
      name: 'under-cap',
      nodes: [{ id: 'a', nodeType: 'TOOL', key: 'tool.cost3.c', label: 'A', inputs: {} }],
      edges: [],
    });

    const result = await (await engine.run({ pipelineId })).done;
    expect(result.status).toBe('SUCCESS');
  });

  it('classifies GraphRecursionError as RECURSION_LIMIT (recursionLimit: 2, 3-node linear chain)', async () => {
    const store = new MemoryStore();
    const completeRunSpy = vi.spyOn(store, 'completeRun');
    const engine = new PipelineEngine({ store, llmFactory: stubLlmFactory, recursionLimit: 2 });
    engine.registerNode(passNodeSpec('tool.pass'));

    const pipelineId = await engine.save({
      name: 'linear-3',
      nodes: [
        { id: 'a', nodeType: 'TOOL', key: 'tool.pass', label: 'A', inputs: {} },
        { id: 'b', nodeType: 'TOOL', key: 'tool.pass', label: 'B', inputs: {} },
        { id: 'c', nodeType: 'TOOL', key: 'tool.pass', label: 'C', inputs: {} },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'a', toNodeId: 'b' },
        { id: 'e2', fromNodeId: 'b', toNodeId: 'c' },
      ],
    });

    const { runId, done } = await engine.run({ pipelineId });
    const result = await done;

    expect(result.status).toBe('FAILED');
    const call = completeRunSpy.mock.calls.find(([id]) => id === runId);
    expect(call?.[1].error?.code).toBe('RECURSION_LIMIT');
  });

  it('runTimeoutMs: 0 disables the wall-clock timeout (old bug: `setTimeout(abort, 0)` fired almost immediately)', async () => {
    const engine = new PipelineEngine({
      store: new MemoryStore(),
      llmFactory: stubLlmFactory,
      runTimeoutMs: 0,
    });
    // A real (short) macrotask delay: with the old `?? 600_000` + always-armed
    // timer, `runTimeoutMs: 0` survives the `??` (0 is not nullish) and arms a
    // 0ms timer that fires long before this delay elapses, aborting the run.
    engine.registerNode(slowNodeSpec('tool.slow', 20));

    const pipelineId = await engine.save({
      name: 'no-timeout',
      nodes: [{ id: 'a', nodeType: 'TOOL', key: 'tool.slow', label: 'A', inputs: {} }],
      edges: [],
    });

    const result = await (await engine.run({ pipelineId })).done;
    expect(result.status).toBe('SUCCESS');
  });

  it('removes the external abort listener after normal completion (no accumulation across repeated runs)', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'listener-cleanup',
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

    const external = new AbortController();

    await (
      await engine.run({ pipelineId, signal: external.signal })
    ).done;
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);

    await (
      await engine.run({ pipelineId, signal: external.signal })
    ).done;
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);
  });
});
