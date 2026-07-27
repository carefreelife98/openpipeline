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
describe('nodeFailureEvent', () => {
  it('returns a NODE_FAILED event carrying the failing nodeId when not aborted', () => {
    const err = new PipelineNodeExecutionError('n1', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'handler exploded',
    });
    expect(nodeFailureEvent(err, false)).toEqual({ kind: 'NODE_FAILED', nodeId: 'n1' });
  });

  it('returns a NODE_ABORTED event (not NODE_FAILED) carrying the same nodeId when aborted', () => {
    const err = new PipelineNodeExecutionError('n1', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'aborted mid-handler',
    });
    expect(nodeFailureEvent(err, true)).toEqual({ kind: 'NODE_ABORTED', nodeId: 'n1' });
  });

  it('preserves the exact failing nodeId across multiple distinct node ids', () => {
    const err = new PipelineNodeExecutionError('some-other-node-id', {
      kind: 'RUNTIME',
      code: 'RUN',
      message: 'boom',
    });
    expect(nodeFailureEvent(err, false)?.nodeId).toBe('some-other-node-id');
  });

  it('returns undefined for a non-PipelineNodeExecutionError (e.g. a bare PipelineCostCapError) — no node to attribute it to', () => {
    const err = new PipelineCostCapError(6, 5);
    expect(nodeFailureEvent(err, false)).toBeUndefined();
    expect(nodeFailureEvent(err, true)).toBeUndefined();
  });

  it('returns undefined for a generic Error (e.g. a graph compile failure, GraphRecursionError)', () => {
    const err = new Error('Recursion limit reached');
    err.name = 'GraphRecursionError';
    expect(nodeFailureEvent(err, false)).toBeUndefined();
    expect(nodeFailureEvent(err, true)).toBeUndefined();
  });

  it('returns undefined for a non-Error thrown value', () => {
    expect(nodeFailureEvent('a raw string throw', false)).toBeUndefined();
    expect(nodeFailureEvent(undefined, true)).toBeUndefined();
  });
});
