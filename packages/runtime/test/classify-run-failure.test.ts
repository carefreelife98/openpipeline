import { PipelineCostCapError, PipelineNodeExecutionError } from '@openpipeline/core';
import { describe, it, expect } from 'vitest';

import { classifyRunFailure } from '../src/index.js';

// I1 — `kind`/`code` must never disagree with `aborted`. A self-contradictory
// pair like `{kind:'ABORTED', code:'COST_CAP'}` must never be produced, even
// when the underlying error is COST_CAP/RECURSION_LIMIT-shaped, because the
// run's AbortSignal won the race against the node/graph error.
//
// This is a direct unit test of the extracted pure classifier rather than an
// end-to-end engine test that fires a real abort mid-run: reproducing the
// actual race through the full LangGraph stack only happens inside an
// extremely narrow, LangGraph-internals-dependent microtask window (verified
// empirically — not a number of ticks a test should pin itself to), so the
// fix is verified directly against its own inputs instead.
describe('classifyRunFailure', () => {
  it('classifies a bare GraphRecursionError-named error as RECURSION_LIMIT when not aborted', () => {
    const err = new Error('Recursion limit reached');
    err.name = 'GraphRecursionError';
    expect(classifyRunFailure(err, false)).toEqual({ kind: 'RUNTIME', code: 'RECURSION_LIMIT' });
  });

  it('classifies a PipelineCostCapError as COST_CAP when not aborted', () => {
    const err = new PipelineCostCapError(6, 5);
    expect(classifyRunFailure(err, false)).toEqual({ kind: 'COST_CAP', code: 'COST_CAP' });
  });

  it('classifies a PipelineNodeExecutionError wrapping a COST_CAP pipelineError as COST_CAP when not aborted', () => {
    const err = new PipelineNodeExecutionError('n1', {
      kind: 'COST_CAP',
      code: 'COST_CAP',
      message: 'over cap',
    });
    expect(classifyRunFailure(err, false)).toEqual({ kind: 'COST_CAP', code: 'COST_CAP' });
  });

  it('classifies a generic error as RUNTIME/RUN when not aborted', () => {
    expect(classifyRunFailure(new Error('boom'), false)).toEqual({ kind: 'RUNTIME', code: 'RUN' });
  });

  it('I1 — classifies a GraphRecursionError-named error as ABORTED/ABORTED-scoped RUN when the run is also aborted, never RECURSION_LIMIT', () => {
    const err = new Error('Recursion limit reached');
    err.name = 'GraphRecursionError';
    expect(classifyRunFailure(err, true)).toEqual({ kind: 'ABORTED', code: 'RUN' });
  });

  it('I1 — classifies a PipelineCostCapError as ABORTED/RUN when the run is also aborted, never COST_CAP', () => {
    const err = new PipelineCostCapError(6, 5);
    expect(classifyRunFailure(err, true)).toEqual({ kind: 'ABORTED', code: 'RUN' });
  });

  it('I1 — classifies a PipelineNodeExecutionError wrapping a COST_CAP pipelineError as ABORTED/RUN when the run is also aborted, never {kind:ABORTED, code:COST_CAP}', () => {
    const err = new PipelineNodeExecutionError('n1', {
      kind: 'COST_CAP',
      code: 'COST_CAP',
      message: 'over cap',
    });
    const result = classifyRunFailure(err, true);
    expect(result).toEqual({ kind: 'ABORTED', code: 'RUN' });
    // Explicitly guard the exact self-contradictory pair the bug produced.
    expect(result).not.toEqual({ kind: 'ABORTED', code: 'COST_CAP' });
  });

  // #6 — LangGraph 1.4.4 throws a native AggregateError (not a single error)
  // when two or more nodes fail in the same superstep before the first is
  // consumed. classifyRunFailure must look inside `.errors`, not just treat
  // the AggregateError itself as an opaque, unrecognized RUNTIME failure.
  describe('AggregateError (#6 — same-superstep multi-node failure fan-out)', () => {
    it('classifies an AggregateError containing a COST_CAP PipelineNodeExecutionError as COST_CAP', () => {
      const costCapErr = new PipelineNodeExecutionError('n1', {
        kind: 'COST_CAP',
        code: 'COST_CAP',
        message: 'over cap',
      });
      const otherErr = new PipelineNodeExecutionError('n2', {
        kind: 'RUNTIME',
        code: 'RUN',
        message: 'unrelated node failure',
      });
      const agg = new AggregateError([otherErr, costCapErr], 'multiple nodes failed');

      expect(classifyRunFailure(agg, false)).toEqual({ kind: 'COST_CAP', code: 'COST_CAP' });
    });

    it('classifies an AggregateError containing a GraphRecursionError-named error as RECURSION_LIMIT', () => {
      const recursionErr = new Error('Recursion limit reached');
      recursionErr.name = 'GraphRecursionError';
      const otherErr = new PipelineNodeExecutionError('n2', {
        kind: 'RUNTIME',
        code: 'RUN',
        message: 'unrelated node failure',
      });
      const agg = new AggregateError([recursionErr, otherErr], 'multiple failures');

      expect(classifyRunFailure(agg, false)).toEqual({ kind: 'RUNTIME', code: 'RECURSION_LIMIT' });
    });

    it('classifies an AggregateError with no COST_CAP/recursion signal as generic RUNTIME/RUN', () => {
      const errA = new PipelineNodeExecutionError('n1', {
        kind: 'RUNTIME',
        code: 'RUN',
        message: 'a',
      });
      const errB = new PipelineNodeExecutionError('n2', {
        kind: 'RUNTIME',
        code: 'RUN',
        message: 'b',
      });
      const agg = new AggregateError([errA, errB], 'multiple plain failures');

      expect(classifyRunFailure(agg, false)).toEqual({ kind: 'RUNTIME', code: 'RUN' });
    });

    it('I1 — an AggregateError containing a COST_CAP error is still classified ABORTED/RUN when the run is also aborted, never {kind:ABORTED, code:COST_CAP}', () => {
      const costCapErr = new PipelineNodeExecutionError('n1', {
        kind: 'COST_CAP',
        code: 'COST_CAP',
        message: 'over cap',
      });
      const agg = new AggregateError([costCapErr], 'aborted with a cost-cap node inside');

      const result = classifyRunFailure(agg, true);
      expect(result).toEqual({ kind: 'ABORTED', code: 'RUN' });
      expect(result).not.toEqual({ kind: 'ABORTED', code: 'COST_CAP' });
    });
  });
});
