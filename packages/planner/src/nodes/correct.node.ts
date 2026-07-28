import { checkAbort } from '../abort.js';
import { buildDesignFeedback } from '../id-map.js';
import type { PlannerRuntime } from '../runtime.js';
import type { PlannerState } from '../state.js';

/**
 * D2's correct node: `attempts++`, then either give up (>= maxAttempts,
 * carrying `state.validationIssues` through unchanged for `plan()` to surface
 * as `unresolvedValidationErrors`) or build short-id-rewritten feedback (D4)
 * for the next `design` call.
 *
 * D2 also describes routing selection-related errors (an unknown `mcp:` key)
 * to a `select` node when a catalog is configured. This build only supports
 * the no-catalog path (the constructor throws if `catalogLoader` /
 * `mcpNodeResolver` is passed — see `planner.ts`), so a `select` node does
 * not exist yet and every non-exhausted retry routes back to `design`. The
 * `select`-routing branch is intentionally NOT implemented here — tracked as
 * a follow-up alongside the intent/select nodes themselves, not silently
 * approximated.
 */
export function correctNode(
  state: PlannerState,
  runtime: PlannerRuntime,
  maxAttempts: number
): Promise<Partial<PlannerState>> {
  checkAbort(runtime.signal);
  const attempts = state.attempts + 1;
  runtime.onProgress?.({ phase: 'correct', attempt: attempts });

  if (attempts >= maxAttempts) {
    return Promise.resolve({ attempts });
  }

  const designFeedback = buildDesignFeedback(state.validationIssues, state.idMap);
  return Promise.resolve({ attempts, designFeedback });
}
