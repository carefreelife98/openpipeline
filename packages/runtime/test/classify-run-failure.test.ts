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
});
