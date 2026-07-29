import type { z } from 'zod';

/** How many of a ZodError's issues to quote back — enough to be actionable, not a full dump. */
const MAX_SCHEMA_ISSUES = 3;

/**
 * Renders the first few issues of a `.parse()` failure into a short,
 * human/model-readable summary. Shared by every node that treats a
 * structured-output schema mismatch as fail-soft rather than a hard abort
 * (T1 review round 3, M6 for `design`; T2 review Important 1/Minor 1 extend
 * the same treatment to `select`/`intent`) — each call site composes its own
 * full message around this summary (a design-feedback sentence vs. a
 * `plannerWarning`), but the "which issues, how many" logic is identical.
 * Capped at {@link MAX_SCHEMA_ISSUES} — enough to be actionable without
 * dumping the entire ZodError tree into a prompt or warning.
 */
export function summarizeZodIssues(err: z.ZodError, maxIssues = MAX_SCHEMA_ISSUES): string {
  return err.issues
    .slice(0, maxIssues)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}
