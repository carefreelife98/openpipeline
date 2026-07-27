import {
  createCostGuard,
  PipelineCostCapError,
  PipelineNodeExecutionError,
  type CostGuard,
  type PipelineNodeRow,
  type PipelineStateType,
  type StepFinish,
} from '@openpipeline/core';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { makeNodeRunner, type NodeRunnerDeps } from '../src/node-runner.js';

function makeState(): PipelineStateType {
  return {
    meta: {
      runId: 'r1',
      pipelineId: 'p1',
      pipelineName: 'p',
      pipelineDescription: '',
      deliveryMode: 'INVOKE',
    },
    outputs: {},
    nodeMeta: {},
    cost: { tokens: { input: 0, output: 0, total: 0 }, dollars: 0, llmCalls: 0 },
    events: [],
  } as unknown as PipelineStateType;
}

describe('node-runner cost preservation on failure', () => {
  it('records accumulated cost on the FAILED step', async () => {
    const finish = vi.fn<(stepId: string, result: StepFinish) => Promise<void>>(() =>
      Promise.resolve()
    );
    const spec = {
      key: 'tool.boom',
      nodeType: 'TOOL' as const,
      displayName: 'Boom',
      description: '',
      icon: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({ kind: z.literal('tool.boom') }),
      handler: (_i: unknown, ctx: { reportCost: (c: unknown) => void }) => {
        ctx.reportCost({ tokens: { input: 5, output: 7, total: 12 }, dollars: 0.5, llmCalls: 1 });
        throw new Error('handler exploded after spending');
      },
    };
    const node: PipelineNodeRow = {
      id: 'n1',
      pipelineId: 'p1',
      nodeType: 'TOOL',
      key: 'tool.boom',
      label: 'Boom',
      inputs: {},
    };
    const deps = {
      bindingResolver: { resolveExplicit: () => ({}) },
      stepRecorder: { start: vi.fn().mockResolvedValue('step-1'), finish },
      llmFactory: { createModel: () => ({}) },
      nodeMap: new Map(),
    } as unknown as NodeRunnerDeps;
    const runner = makeNodeRunner(node, spec as never, deps);
    const state = {
      meta: {
        runId: 'r1',
        pipelineId: 'p1',
        pipelineName: 'p',
        pipelineDescription: '',
        deliveryMode: 'INVOKE',
      },
      outputs: {},
      nodeMeta: {},
      cost: { tokens: { input: 0, output: 0, total: 0 }, dollars: 0, llmCalls: 0 },
      events: [],
    } as unknown as PipelineStateType;

    await expect(runner(state)).rejects.toThrow();
    expect(finish).toHaveBeenCalledTimes(1);
    const [stepIdArg, resultArg] = finish.mock.calls[0] ?? [];
    expect(stepIdArg).toBe('step-1');
    expect(resultArg?.status).toBe('FAILED');
    // The failed node still spent 0.5 via reportCost before throwing — that
    // cost must survive onto the FAILED step, not be silently dropped (#24).
    expect(resultArg?.cost).toEqual({
      tokens: { input: 5, output: 7, total: 12 },
      dollars: 0.5,
      llmCalls: 1,
    });
  });
});

describe('node-runner cost guard (config.configurable.costGuard)', () => {
  function makeCostNode(dollars: number): {
    node: PipelineNodeRow;
    spec: unknown;
  } {
    const spec = {
      key: 'tool.cost',
      nodeType: 'TOOL' as const,
      displayName: 'Cost',
      description: '',
      icon: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({ kind: z.literal('tool.cost') }),
      handler: (_i: unknown, ctx: { reportCost: (c: unknown) => void }) => {
        ctx.reportCost({ tokens: { input: 0, output: 0, total: 0 }, dollars, llmCalls: 1 });
        return Promise.resolve({ kind: 'tool.cost' as const });
      },
    };
    const node: PipelineNodeRow = {
      id: 'n1',
      pipelineId: 'p1',
      nodeType: 'TOOL',
      key: 'tool.cost',
      label: 'Cost',
      inputs: {},
    };
    return { node, spec };
  }

  function makeDeps(): {
    deps: NodeRunnerDeps;
    finish: ReturnType<typeof vi.fn<(stepId: string, result: StepFinish) => Promise<void>>>;
  } {
    const finish = vi.fn<(stepId: string, result: StepFinish) => Promise<void>>(() =>
      Promise.resolve()
    );
    const deps: NodeRunnerDeps = {
      bindingResolver: { resolveExplicit: () => ({}) },
      stepRecorder: { start: vi.fn().mockResolvedValue('step-1'), finish },
      llmFactory: { createModel: () => ({}) },
      nodeMap: new Map(),
    };
    return { deps, finish };
  }

  it("adds the node's total cost to the guard and calls check() right after the SUCCESS step finish", async () => {
    const { node, spec } = makeCostNode(3);
    const { deps } = makeDeps();
    const runner = makeNodeRunner(node, spec as never, deps);

    const added: unknown[] = [];
    let checkCalledAfterAdd = false;
    const costGuard: CostGuard = {
      add: (c) => {
        added.push(c);
      },
      check: () => {
        checkCalledAfterAdd = added.length === 1;
      },
    };

    const result = await runner(makeState(), { configurable: { costGuard } });

    expect(result.outputs?.n1).toEqual({ kind: 'tool.cost' });
    expect(added).toEqual([{ tokens: { input: 0, output: 0, total: 0 }, dollars: 3, llmCalls: 1 }]);
    expect(checkCalledAfterAdd).toBe(true);
  });

  it('propagates guard.check() throwing PipelineCostCapError as a COST_CAP node failure', async () => {
    const { node, spec } = makeCostNode(3);
    const { deps, finish } = makeDeps();
    const runner = makeNodeRunner(node, spec as never, deps);

    // A real guard, pre-loaded past its cap so the SUCCESS-path check() trips.
    const costGuard = createCostGuard(1);
    costGuard.add({ tokens: { input: 0, output: 0, total: 0 }, dollars: 5, llmCalls: 1 });

    await expect(runner(makeState(), { configurable: { costGuard } })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(PipelineNodeExecutionError);
        const wrapped = err as PipelineNodeExecutionError;
        expect(wrapped.pipelineError.kind).toBe('COST_CAP');
        expect(wrapped.pipelineError.code).toBe('COST_CAP');
        return true;
      }
    );

    // The FAILED step re-write still records the node's own accumulated cost
    // (the cap trip happens after the node already earned that spend).
    const failedCall = finish.mock.calls.find(([, r]) => r.status === 'FAILED');
    expect(failedCall?.[1].cost).toEqual({
      tokens: { input: 0, output: 0, total: 0 },
      dollars: 3,
      llmCalls: 1,
    });
  });

  it('adds the accumulated cost to the guard on a handler failure, but never calls check() from the catch path', async () => {
    const spec = {
      key: 'tool.boom-cost',
      nodeType: 'TOOL' as const,
      displayName: 'BoomCost',
      description: '',
      icon: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({ kind: z.literal('tool.boom-cost') }),
      handler: (_i: unknown, ctx: { reportCost: (c: unknown) => void }) => {
        ctx.reportCost({ tokens: { input: 0, output: 0, total: 0 }, dollars: 9, llmCalls: 1 });
        throw new Error('handler exploded after spending, above any cap');
      },
    };
    const node: PipelineNodeRow = {
      id: 'n1',
      pipelineId: 'p1',
      nodeType: 'TOOL',
      key: 'tool.boom-cost',
      label: 'BoomCost',
      inputs: {},
    };
    const { deps } = makeDeps();
    const runner = makeNodeRunner(node, spec as never, deps);

    const added: unknown[] = [];
    let checkCalled = false;
    const costGuard: CostGuard = {
      add: (c) => {
        added.push(c);
      },
      check: () => {
        checkCalled = true;
        throw new PipelineCostCapError(999, 1); // must never be reached
      },
    };

    await expect(runner(makeState(), { configurable: { costGuard } })).rejects.toThrow(
      'handler exploded after spending, above any cap'
    );
    expect(added).toEqual([{ tokens: { input: 0, output: 0, total: 0 }, dollars: 9, llmCalls: 1 }]);
    expect(checkCalled).toBe(false);
  });

  it('works with no costGuard configured at all (optional dependency)', async () => {
    const { node, spec } = makeCostNode(1_000_000);
    const { deps } = makeDeps();
    const runner = makeNodeRunner(node, spec as never, deps);

    await expect(runner(makeState())).resolves.toBeDefined();
  });
});

describe('node-runner input-parse hint (K12)', () => {
  it('enriches an inputSchema.parse ZodError with the state-bound slot(s) that fed it, keeping VALIDATION/ZOD_PARSE classification', async () => {
    const spec = {
      key: 'tool.needs-number',
      nodeType: 'TOOL' as const,
      displayName: 'NeedsNumber',
      description: '',
      icon: 'x',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ kind: z.literal('tool.needs-number') }),
      handler: () => Promise.resolve({ kind: 'tool.needs-number' as const }),
    };
    const node: PipelineNodeRow = {
      id: 'n1',
      pipelineId: 'p1',
      nodeType: 'TOOL',
      key: 'tool.needs-number',
      label: 'NeedsNumber',
      inputs: { n: { kind: 'state', path: 'outputs.upstream.value' } },
    };
    const deps = {
      // Resolver hands back a non-numeric value for `n`, forcing inputSchema.parse to fail.
      bindingResolver: { resolveExplicit: () => ({ n: 'not-a-number' }) },
      stepRecorder: {
        start: vi.fn().mockResolvedValue('step-1'),
        finish: vi.fn(() => Promise.resolve()),
      },
      llmFactory: { createModel: () => ({}) },
      nodeMap: new Map(),
    } as unknown as NodeRunnerDeps;
    const runner = makeNodeRunner(node, spec, deps);

    await expect(runner(makeState())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PipelineNodeExecutionError);
      const wrapped = err as PipelineNodeExecutionError;
      expect(wrapped.pipelineError.kind).toBe('VALIDATION');
      expect(wrapped.pipelineError.code).toBe('ZOD_PARSE');
      expect(wrapped.pipelineError.message).toContain('outputs.upstream.value');
      expect(wrapped.pipelineError.message).toContain('"n"');
      return true;
    });
  });

  it('does NOT attach state-binding hints to an outputSchema.parse ZodError (would mislead — the mismatch is on the output, not the input bindings)', async () => {
    const spec = {
      key: 'tool.bad-output',
      nodeType: 'TOOL' as const,
      displayName: 'BadOutput',
      description: '',
      icon: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({ kind: z.literal('tool.bad-output'), n: z.number() }),
      // Handler returns something that fails the OUTPUT schema, not the input schema.
      handler: () =>
        Promise.resolve({ kind: 'tool.bad-output' as const, n: 'oops' as unknown as number }),
    };
    const node: PipelineNodeRow = {
      id: 'n1',
      pipelineId: 'p1',
      nodeType: 'TOOL',
      key: 'tool.bad-output',
      label: 'BadOutput',
      inputs: { irrelevant: { kind: 'state', path: 'outputs.upstream.value' } },
    };
    const deps = {
      bindingResolver: { resolveExplicit: () => ({}) },
      stepRecorder: {
        start: vi.fn().mockResolvedValue('step-1'),
        finish: vi.fn(() => Promise.resolve()),
      },
      llmFactory: { createModel: () => ({}) },
      nodeMap: new Map(),
    } as unknown as NodeRunnerDeps;
    const runner = makeNodeRunner(node, spec, deps);

    await expect(runner(makeState())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PipelineNodeExecutionError);
      const wrapped = err as PipelineNodeExecutionError;
      expect(wrapped.pipelineError.kind).toBe('VALIDATION');
      expect(wrapped.pipelineError.code).toBe('ZOD_PARSE');
      expect(wrapped.pipelineError.message).not.toContain('state 바인딩');
      expect(wrapped.pipelineError.message).not.toContain('outputs.upstream.value');
      return true;
    });
  });

  it('enriches the hint without mutating a getter-only ZodError.message (C1 — zod v3 classic peer-range regression)', async () => {
    // Reproduces zod v3 classic's `ZodError.prototype.message`: a getter with
    // NO setter. In ESM (strict mode, which this package is), `err.message =
    // ...` on such an object throws `TypeError: Cannot set property message
    // ... which has only a getter` instead of updating the message — exactly
    // what the declared `"zod": "^3.25.32 || ^4.2.0"` peerDependency range
    // permits a consumer to install. The fix must never write to the caught
    // ZodError; it must only enrich the *derived* pipelineError.
    let originalMessage = '';
    let getterOnlyZodError!: z.ZodError;
    try {
      z.object({ n: z.number() }).parse({ n: 'nope' });
    } catch (e) {
      getterOnlyZodError = e as z.ZodError;
      originalMessage = getterOnlyZodError.message;
    }
    Object.defineProperty(getterOnlyZodError, 'message', {
      get: () => originalMessage,
      configurable: true,
      enumerable: true,
      // Deliberately no `set` — an assignment must throw, just like zod v3.
    });

    const spec = {
      key: 'tool.needs-number-v3',
      nodeType: 'TOOL' as const,
      displayName: 'NeedsNumberV3',
      description: '',
      icon: 'x',
      // Stand-in for inputSchema: `.safeParse()` returns the getter-only
      // fixture above (node-runner uses `.safeParse`, not `.parse`, for K12
      // — see node-runner.ts) instead of doing real validation.
      inputSchema: {
        safeParse: () => ({ success: false as const, error: getterOnlyZodError }),
      } as unknown as z.ZodType,
      outputSchema: z.object({ kind: z.literal('tool.needs-number-v3') }),
      handler: () => Promise.resolve({ kind: 'tool.needs-number-v3' as const }),
    };
    const node: PipelineNodeRow = {
      id: 'n1',
      pipelineId: 'p1',
      nodeType: 'TOOL',
      key: 'tool.needs-number-v3',
      label: 'NeedsNumberV3',
      inputs: { n: { kind: 'state', path: 'outputs.upstream.value' } },
    };
    const deps = {
      bindingResolver: { resolveExplicit: () => ({ n: 'not-a-number' }) },
      stepRecorder: {
        start: vi.fn().mockResolvedValue('step-1'),
        finish: vi.fn(() => Promise.resolve()),
      },
      llmFactory: { createModel: () => ({}) },
      nodeMap: new Map(),
    } as unknown as NodeRunnerDeps;
    const runner = makeNodeRunner(node, spec, deps);

    // Must not throw a TypeError from mutating err.message — the run must
    // still surface a well-formed VALIDATION/ZOD_PARSE error with the hint.
    await expect(runner(makeState())).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PipelineNodeExecutionError);
      const wrapped = err as PipelineNodeExecutionError;
      expect(wrapped.pipelineError.kind).toBe('VALIDATION');
      expect(wrapped.pipelineError.code).toBe('ZOD_PARSE');
      expect(wrapped.pipelineError.message).toContain('outputs.upstream.value');
      expect(wrapped.pipelineError.message).toContain('"n"');
      return true;
    });

    // Classification-invariant: the caught ZodError itself is never mutated.
    expect(getterOnlyZodError.message).toBe(originalMessage);
  });
});
