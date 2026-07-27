import { PipelineCostCapError, PipelineNodeExecutionError } from '@openpipeline/core';
import { describe, it, expect } from 'vitest';

import { nodeFailureEvent } from '../src/index.js';

// K15 — NODE_FAILED/NODE_ABORTED were declared in @openpipeline/core's event
// union but never actually emitted by the engine, so a node that throws
// "evaporates" for a live subscriber (no NODE_END either, since translateEvent
// only emits that from LangGraph's own on_chain_end).
//
// This is a direct unit test of the extracted pure branch rather than an
// end-to-end engine test that fires a real abort mid-node: empirically, once
// an abort signal actually fires, LangGraph's own signal handling on
// streamEvents always wins the race against node-runner's wrapped
// PipelineNodeExecutionError — the error execute() observes is a generic
// "operation was aborted" rejection, never the PipelineNodeExecutionError
// node-runner independently constructs (same class of narrow,
// LangGraph-internals-dependent race documented on classifyRunFailure for
// COST_CAP/RECURSION_LIMIT, #I1) — so the fix is verified directly against
// its own inputs instead.
//
// #6 — returns an ARRAY (not a single event | undefined): LangGraph 1.4.4
// throws a native `AggregateError` (not a single error) when two or more
// nodes fail in the same superstep before the first is consumed
// (`pregel/runner.js`'s `nodeErrors.size > 1` branch) — every attributable
// `PipelineNodeExecutionError` inside `.errors` must get its own event, not
// just the first.
describe('nodeFailureEvent', () => {
  it('returns a single-element array with a NODE_FAILED event carrying the failing nodeId when not aborted', () => {
    const err = new PipelineNodeExecutionError('n1', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'handler exploded',
    });
    expect(nodeFailureEvent(err, false)).toEqual([{ kind: 'NODE_FAILED', nodeId: 'n1' }]);
  });

  it('returns a single-element array with a NODE_ABORTED event (not NODE_FAILED) carrying the same nodeId when aborted', () => {
    const err = new PipelineNodeExecutionError('n1', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'aborted mid-handler',
    });
    expect(nodeFailureEvent(err, true)).toEqual([{ kind: 'NODE_ABORTED', nodeId: 'n1' }]);
  });

  it('preserves the exact failing nodeId across multiple distinct node ids', () => {
    const err = new PipelineNodeExecutionError('some-other-node-id', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'boom',
    });
    expect(nodeFailureEvent(err, false)[0]?.nodeId).toBe('some-other-node-id');
  });

  it('returns an empty array for a non-PipelineNodeExecutionError (e.g. a bare PipelineCostCapError) — no node to attribute it to', () => {
    const err = new PipelineCostCapError(6, 5);
    expect(nodeFailureEvent(err, false)).toEqual([]);
    expect(nodeFailureEvent(err, true)).toEqual([]);
  });

  it('returns an empty array for a generic Error (e.g. a graph compile failure, GraphRecursionError)', () => {
    const err = new Error('Recursion limit reached');
    err.name = 'GraphRecursionError';
    expect(nodeFailureEvent(err, false)).toEqual([]);
    expect(nodeFailureEvent(err, true)).toEqual([]);
  });

  it('returns an empty array for a non-Error thrown value', () => {
    expect(nodeFailureEvent('a raw string throw', false)).toEqual([]);
    expect(nodeFailureEvent(undefined, true)).toEqual([]);
  });

  // #6 — AggregateError fan-out.
  it('emits a NODE_FAILED event for EVERY PipelineNodeExecutionError inside a native AggregateError, in order', () => {
    const errA = new PipelineNodeExecutionError('node-a', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'a exploded',
    });
    const errB = new PipelineNodeExecutionError('node-b', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'b exploded',
    });
    const agg = new AggregateError([errA, errB], 'multiple nodes failed');

    expect(nodeFailureEvent(agg, false)).toEqual([
      { kind: 'NODE_FAILED', nodeId: 'node-a' },
      { kind: 'NODE_FAILED', nodeId: 'node-b' },
    ]);
  });

  it('emits NODE_ABORTED (not NODE_FAILED) for every attributable error inside an AggregateError when aborted', () => {
    const errA = new PipelineNodeExecutionError('node-a', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'a aborted',
    });
    const errB = new PipelineNodeExecutionError('node-b', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'b aborted',
    });
    const agg = new AggregateError([errA, errB], 'multiple nodes aborted');

    expect(nodeFailureEvent(agg, true)).toEqual([
      { kind: 'NODE_ABORTED', nodeId: 'node-a' },
      { kind: 'NODE_ABORTED', nodeId: 'node-b' },
    ]);
  });

  it('skips non-attributable errors inside an AggregateError while still surfacing the attributable ones', () => {
    const errA = new PipelineNodeExecutionError('node-a', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'a exploded',
    });
    const genericGraphError = new Error('unrelated graph-level failure');
    const agg = new AggregateError([genericGraphError, errA], 'mixed failures');

    expect(nodeFailureEvent(agg, false)).toEqual([{ kind: 'NODE_FAILED', nodeId: 'node-a' }]);
  });

  it('returns an empty array for an AggregateError with no attributable errors inside it', () => {
    const agg = new AggregateError([new Error('one'), new Error('two')], 'no node failures');
    expect(nodeFailureEvent(agg, false)).toEqual([]);
  });
});
