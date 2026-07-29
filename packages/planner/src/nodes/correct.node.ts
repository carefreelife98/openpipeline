import { checkAbort } from '../abort.js';
import { buildDesignFeedback } from '../id-map.js';
import { issuesReferenceUnresolvedMcpKey } from '../mcp-routing.js';
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
 *   `design`/`select` call, carrying `state.validationIssues` through
 *   unchanged for `plan()` to surface as `unresolvedValidationErrors`.
 *   `attempts` is left untouched — it already equals the number of `design`
 *   calls made. `correctTarget` is explicitly cleared back to `undefined`
 *   here (never just omitted) so a PREVIOUS non-exhausted round's `'design'`/
 *   `'select'` value can never survive stale into `routeAfterCorrect` on the
 *   round that actually exhausts — mirrors `designFeedback`/`designError`'s
 *   own "unconditionally clear, never merely omit" discipline elsewhere in
 *   this package.
 * - Otherwise: `attempts++`, build short-id-rewritten feedback (D4) for the
 *   next `design` call, and decide `correctTarget` (D2b's correct-routing
 *   extension): on the catalog path (`catalogLoader`/`mcpNodeResolver` both
 *   configured — checked via `runtime`, never by re-deriving it from
 *   `state`), a validation issue referencing an unresolved `mcp:` key routes
 *   back to `'select'` so the model gets another chance to pick a different
 *   tool; every other issue (and the entire no-catalog path, where `select`
 *   doesn't even exist in the compiled graph) routes to `'design'` — mirrors
 *   Mate-X's `routeCorrection`.
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
    return Promise.resolve({ correctTarget: undefined });
  }

  const attempts = state.attempts + 1;
  const designFeedback = buildDesignFeedback(state.validationIssues, state.idMap);

  const catalogPathActive =
    runtime.catalogLoader !== undefined && runtime.mcpNodeResolver !== undefined;
  const correctTarget =
    catalogPathActive && issuesReferenceUnresolvedMcpKey(state.validationIssues, state.draft)
      ? 'select'
      : 'design';

  return Promise.resolve({ attempts, designFeedback, correctTarget });
}
