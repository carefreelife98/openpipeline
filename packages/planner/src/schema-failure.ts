import { OutputParserException } from '@langchain/core/output_parsers';
import { z } from 'zod';

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

/**
 * A structured-output call can fail schema validation in two different error
 * shapes depending on which `withStructuredOutput` adapter
 * `llmFactory.createModel()` actually returned (T3 review llm-robustness #1):
 *
 * - The base "hand back `toolCall.args` unvalidated" adapter never throws at
 *   all — `structuredModel.invoke()` resolves with whatever shape the model
 *   returned, and this package's own defensive `<Schema>.parse(rawOutput)`
 *   re-validation (see each node) is what raises a `z.ZodError`. This is the
 *   only shape the test fakes in `test/helpers/fake-chat-model.ts` can ever
 *   produce, since they resolve `invoke()` unconditionally.
 * - A provider `functionCalling` override that supplies its own zod schema to
 *   `withStructuredOutput` (e.g. `ChatOpenAI`, via `@langchain/core`'s
 *   `JsonOutputKeyToolsParser._validateResult`) validates INSIDE `invoke` and
 *   REJECTS the call with an `OutputParserException` instead — `.parse()` is
 *   never reached because `rawOutput` never resolves.
 *
 * Every node that treats a structured-output parse failure as fail-soft
 * (`design`/`intent`/`select`) must classify BOTH shapes as "schema failure"
 * — not just `z.ZodError` — and let every other error (a genuine LLM/network
 * failure) rethrow unchanged.
 */
export type StructuredOutputSchemaFailure =
  | { kind: 'zod'; error: z.ZodError }
  | { kind: 'output-parser'; error: OutputParserException };

/**
 * Classifies a caught error as a {@link StructuredOutputSchemaFailure}, or
 * returns `undefined` for anything else — the caller's signal to rethrow
 * rather than degrade fail-soft.
 */
export function classifyStructuredOutputError(
  err: unknown
): StructuredOutputSchemaFailure | undefined {
  if (err instanceof z.ZodError) return { kind: 'zod', error: err };
  if (err instanceof OutputParserException) return { kind: 'output-parser', error: err };
  return undefined;
}

/**
 * Renders a classified {@link StructuredOutputSchemaFailure} into the same
 * short, human/model-readable summary regardless of which shape it was: the
 * `zod` case reuses {@link summarizeZodIssues}; the `output-parser` case has
 * no `.issues` tree to summarize, so its own `.message` (already a short,
 * human-readable description — see `OutputParserException` in
 * `@langchain/core`) is used as-is.
 */
export function describeStructuredOutputFailure(
  failure: StructuredOutputSchemaFailure,
  maxIssues = MAX_SCHEMA_ISSUES
): string {
  return failure.kind === 'zod'
    ? summarizeZodIssues(failure.error, maxIssues)
    : failure.error.message;
}
