import type { PipelineNodeRow, PipelineStateType, StepFinish } from '@openpipeline/core';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { makeNodeRunner, type NodeRunnerDeps } from '../src/node-runner.js';

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
