import { checkAbort } from '../abort.js';
import { buildDesignFeedback } from '../id-map.js';
import type { PlannerRuntime } from '../runtime.js';
import type { PlannerState } from '../state.js';

/**
 * D2's correct node: gate on `maxAttempts` BEFORE incrementing `attempts`,
 * not after (deliberate resolution of the `maxAttempts` off-by-one flagged in
 * T1 review I3 — see `PlannerState.attempts`'s doc comment in `state.ts` for
 * the full rationale). This keeps `attempts` equal to "the number of `design`
 * calls actually made" in both the success path and the exhaustion path, and
 * makes `maxAttempts` design calls actually happen in total (never
 * `maxAttempts - 1`, and `maxAttempts: 2` is no longer a dead setting
 * behaviorally identical to `maxAttempts: 1`).
 *
 * - Exhausted (`state.attempts >= maxAttempts`): give up without a further
 *   `design` call, carrying `state.validationIssues` through unchanged for
 *   `plan()` to surface as `unresolvedValidationErrors`. `attempts` is left
 *   untouched — it already equals the number of `design` calls made.
 * - Otherwise: `attempts++`, then build short-id-rewritten feedback (D4) for
 *   the next `design` call.
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
  runtime.logger.debug(`[PipelinePlanner] correct attempt=${String(state.attempts)}`);
  runtime.onProgress?.({ phase: 'correct', attempt: state.attempts });

  if (state.attempts >= maxAttempts) {
    return Promise.resolve({});
  }

  const attempts = state.attempts + 1;
  const designFeedback = buildDesignFeedback(state.validationIssues, state.idMap);
  return Promise.resolve({ attempts, designFeedback });
}
