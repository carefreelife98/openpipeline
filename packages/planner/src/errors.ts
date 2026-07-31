import type { GraphValidationIssue } from '@openpipeline/nodes';

/**
 * Thrown by {@link PipelinePlanner.plan} when the `design -> validate ->
 * correct` loop exhausts every attempt WITHOUT ever producing a single
 * `PlannerDraft` to return — i.e. every attempt (including the last) failed
 * `PlannerDraftSchema.parse` (a schema-shape defect, never a graph-structure
 * one; see `design.node.ts`/`routeAfterDesign`). This is a DIFFERENT
 * exhaustion shape from a run that produces a draft but never gets it to
 * validate cleanly — that path still RESOLVES normally, with
 * `PlannerResult.unresolvedValidationErrors` set (quality-batch item 6:
 * unchanged by this error type's introduction) — there is simply no draft
 * here to attach anything to, so throwing is the only option.
 *
 * Typed (quality-batch item 6) — `PipelineNotFoundError`-style (`extends
 * Error`, a stable `name`, structured fields a caller can read instead of
 * parsing the message) — instead of a bare `Error`, so a caller classifying
 * `plan()`'s rejection can do so via `instanceof` rather than a message
 * substring match.
 */
export class PlannerExhaustedError extends Error {
  override readonly name = 'PlannerExhaustedError';
  constructor(
    /** Number of `design` attempts actually made (equals `maxAttempts` — see `PlannerState.attempts`'s doc comment). */
    readonly attempts: number,
    /**
     * The accumulated validation/schema-failure issues from the exhausted
     * run, when any exist (every failed attempt's schema-parse complaint is
     * appended here by `design.node.ts`'s catch branch). `undefined` only in
     * the structurally-unreachable case of an exhaustion with zero
     * accumulated issues.
     */
    readonly lastIssues?: GraphValidationIssue[]
  ) {
    super(
      `[PipelinePlanner] planning finished with no draft produced after ${String(attempts)} attempt(s).`
    );
  }
}
