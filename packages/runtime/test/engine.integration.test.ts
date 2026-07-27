import { getEventListeners } from 'node:events';

import { defineNode, type PipelineEvent } from '@openpipeline/core';
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

function boomNodeSpec(key: string) {
  return defineNode({
    key,
    nodeType: 'TOOL' as const,
    displayName: key,
    description: 'Always throws.',
    icon: 'x',
    inputSchema: z.object({}),
    outputSchema: z.object({ kind: z.literal(key) }),
    handler: () => {
      throw new Error('boom');
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

  it('emits NODE_FAILED (with the failing nodeId) before RUN_COMPLETE when a node throws (#K15)', async () => {
    const engine = makeEngine();
    engine.registerNode(boomNodeSpec('tool.boom'));

    const pipelineId = await engine.save({
      name: 'boom-pipeline',
      nodes: [{ id: 'boom', nodeType: 'TOOL', key: 'tool.boom', label: 'Boom', inputs: {} }],
      edges: [],
    });

    const kinds: string[] = [];
    const events: PipelineEvent[] = [];
    const { done } = await engine.run({
      pipelineId,
      onEvent: (e) => {
        kinds.push(e.kind);
        events.push(e);
      },
    });
    const result = await done;

    expect(result.status).toBe('FAILED');
    expect(kinds).toContain('NODE_FAILED');
    expect(kinds.indexOf('NODE_FAILED')).toBeLessThan(kinds.indexOf('RUN_COMPLETE'));
    const failedEvent = events.find((e) => e.kind === 'NODE_FAILED');
    expect(failedEvent?.nodeId).toBe('boom');
  });

  // NOTE: there is deliberately no integration test here for the
  // NODE_ABORTED branch (aborted mid-node). Empirically (see task-7-report.md),
  // once `engine.abort()`/an external signal actually fires, LangGraph's own
  // signal handling on `streamEvents` always wins the race against
  // node-runner's wrapped PipelineNodeExecutionError — the error that reaches
  // `execute()`'s catch is a generic "operation was aborted" error, never the
  // PipelineNodeExecutionError node-runner independently constructs and logs
  // internally. This is the same class of "narrow, LangGraph-internals-
  // dependent microtask window" documented on `classifyRunFailure` for the
  // COST_CAP/RECURSION_LIMIT-vs-abort race (#I1) — not reliably reproducible
  // end-to-end, so `nodeFailureEvent` (the extracted pure branch, mirroring
  // `classifyRunFailure`'s own testing strategy) is unit-tested directly in
  // node-failure-event.test.ts instead.

  it('#4 — a store failure on the SUCCESS terminal write does not reclassify a genuinely successful run as FAILED', async () => {
    const store = new MemoryStore();
    const originalCompleteRun = store.completeRun.bind(store);
    vi.spyOn(store, 'completeRun').mockImplementation((runId, result) => {
      if (result.status === 'SUCCESS') {
        return Promise.reject(new Error('store is down'));
      }
      return originalCompleteRun(runId, result);
    });
    const warn = vi.fn();
    const engine = new PipelineEngine({
      store,
      llmFactory: stubLlmFactory,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    engine.registerNode(
      defineNode({
        key: 'tool.pass-4',
        nodeType: 'TOOL',
        displayName: 'Pass',
        description: 'No-op pass-through node.',
        icon: 'x',
        inputSchema: z.object({}),
        outputSchema: z.object({ kind: z.literal('tool.pass-4') }),
        handler: () => Promise.resolve({ kind: 'tool.pass-4' as const }),
      })
    );
    const pipelineId = await engine.save({
      name: 'success-persist-fails',
      nodes: [{ id: 'a', nodeType: 'TOOL', key: 'tool.pass-4', label: 'A', inputs: {} }],
      edges: [],
    });

    const result = await (await engine.run({ pipelineId })).done; // must not reject

    // The node graph genuinely succeeded — that must survive the store's
    // SUCCESS-write failure, not fall through to the catch block's FAILED
    // reclassification (which would also discard the real outputs/cost).
    expect(result.status).toBe('SUCCESS');
    expect(result.outputs.a).toEqual({ kind: 'tool.pass-4' });
    expect(warn).not.toHaveBeenCalled(); // this path logs via .error, not .warn
  });

  it('#5 — logs a warning (does not silently drop it) when completeRun(SUCCESS) reports it lost the terminal-write race', async () => {
    const store = new MemoryStore();
    vi.spyOn(store, 'completeRun').mockImplementation(() => Promise.resolve(false));
    const warn = vi.fn();
    const engine = new PipelineEngine({
      store,
      llmFactory: stubLlmFactory,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    engine.registerNode(
      defineNode({
        key: 'tool.pass-5',
        nodeType: 'TOOL',
        displayName: 'Pass',
        description: 'No-op pass-through node.',
        icon: 'x',
        inputSchema: z.object({}),
        outputSchema: z.object({ kind: z.literal('tool.pass-5') }),
        handler: () => Promise.resolve({ kind: 'tool.pass-5' as const }),
      })
    );
    const pipelineId = await engine.save({
      name: 'lost-terminal-race',
      nodes: [{ id: 'a', nodeType: 'TOOL', key: 'tool.pass-5', label: 'A', inputs: {} }],
      edges: [],
    });

    const result = await (await engine.run({ pipelineId })).done;

    expect(result.status).toBe('SUCCESS'); // still emits/returns SUCCESS...
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lost the terminal-write race')); // ...but the race loss is surfaced, not silently dropped
  });

  it('#7 — a node failure cancels a still-running sibling branch in the same superstep (controller.abort() propagation)', async () => {
    const engine = makeEngine();
    engine.registerNode(boomNodeSpec('tool.boom-7'));
    const observed = { abortedDuringWait: false, sawAbortAfterWait: false };
    engine.registerNode(
      defineNode({
        key: 'tool.slow-observer-7',
        nodeType: 'TOOL',
        displayName: 'SlowObserver',
        description: "Waits, observing whether ctx.signal gets aborted while it's in flight.",
        icon: 'x',
        inputSchema: z.object({}),
        outputSchema: z.object({ kind: z.literal('tool.slow-observer-7') }),
        handler: async (_i, ctx) => {
          const onAbort = () => {
            observed.abortedDuringWait = true;
          };
          ctx.signal?.addEventListener('abort', onAbort);
          await new Promise((resolve) => setTimeout(resolve, 50));
          ctx.signal?.removeEventListener('abort', onAbort);
          observed.sawAbortAfterWait = ctx.signal?.aborted ?? false;
          return { kind: 'tool.slow-observer-7' as const };
        },
      })
    );

    const pipelineId = await engine.save({
      name: 'sibling-cancel-on-failure',
      nodes: [
        { id: 'boom', nodeType: 'TOOL', key: 'tool.boom-7', label: 'Boom', inputs: {} },
        { id: 'slow', nodeType: 'TOOL', key: 'tool.slow-observer-7', label: 'Slow', inputs: {} },
      ],
      // Independent parallel branches (no edges between them) — both run as
      // entries in the SAME first superstep (#14 — a zero-edge multi-node
      // graph is a valid intentionally-parallel pipeline).
      edges: [],
    });

    const result = await (await engine.run({ pipelineId })).done;
    expect(result.status).toBe('FAILED');

    // Let the slow handler's 50ms timer (and its post-await bookkeeping)
    // actually finish before checking what it observed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(observed.abortedDuringWait || observed.sawAbortAfterWait).toBe(true);
  });

  it('onEvent on a finished run warns, returns a no-op unsubscribe, and does not leak a listener set (#K16)', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'onevent-late',
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
    await done;
    // Flush the deferred (queueMicrotask'd) listener-cleanup so the run's
    // listeners Set entry is definitely gone before we probe it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(engine.isInFlight(runId)).toBe(false);
    const listeners = (engine as unknown as { listeners: Map<string, Set<unknown>> }).listeners;
    expect(listeners.has(runId)).toBe(false); // sanity: normal cleanup already ran

    const receivedAfterFinish: string[] = [];
    const unsubscribe = engine.onEvent(runId, (e) => receivedAfterFinish.push(e.kind));

    expect(typeof unsubscribe).toBe('function');
    expect(() => {
      unsubscribe();
    }).not.toThrow();
    // The late subscribe must not resurrect a listener Set for this finished run.
    expect(listeners.has(runId)).toBe(false);
    expect(receivedAfterFinish).toEqual([]);
  });
});
