import { PipelineAbortedError } from '@openpipeline/core';

/**
 * Checked at the entry of every planner node (design/validate/correct), per
 * the task's explicit requirement: "signal aborts between nodes (check
 * signal at node entry, throw PipelineAbortedError from core)". Mirrors
 * `@openpipeline/nodes`'s own `node-runner.ts` `checkAbort` verbatim.
 */
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PipelineAbortedError();
}
