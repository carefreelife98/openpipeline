import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { checkAbort } from '../abort.js';
import { buildIntentPrompt, INTENT_SYSTEM_PROMPT } from '../prompts.js';
import type { PlannerRuntime } from '../runtime.js';
import {
  classifyStructuredOutputError,
  describeStructuredOutputFailure,
} from '../schema-failure.js';
import { IntentSchema } from '../schema.js';
import type { PlannerState } from '../state.js';
import { asStructuredOutputModel } from '../structured-output.js';

/**
 * T2/D2's `intent` node: the MCP-catalog path's entry point (only wired into
 * the graph when `catalogLoader`/`mcpNodeResolver` are both configured — see
 * `planner.ts`'s `buildPlannerGraph`). One structured-output call decides
 * `needsMcp`: `false` routes straight to `design` (the tool catalog is never
 * loaded and `select`'s LLM is never invoked — D2), `true` routes to `select`.
 *
 * Runs once per `plan()` call, not once per correction attempt — `correct`
 * never routes back here (only `design`/`select` — see `correct.node.ts`), so
 * there is no retry loop to consider. If the model's structured output fails
 * schema validation — either `IntentSchema.parse` throwing (a schema-SHAPE
 * defect) or `structuredModel.invoke(messages)` itself rejecting with an
 * `OutputParserException` (a provider `functionCalling` override validates
 * its own zod schema INSIDE `invoke` — T3 review llm-robustness #1) — this
 * does NOT abort `plan()` (T2 review Important 1 / Minor 1: real models do
 * return off-schema structured output — the same assumption T1 review round
 * 3, M6 already rejected for `design`, and Important 1 extends to `select`).
 * Both shapes are caught here (a single `try` spans `invoke` AND `.parse`)
 * and degrade to `needsMcp: false` with a `plannerWarning` naming the schema
 * failure — `routeAfterIntent` then sends the run straight to `design` with
 * static specs only, the same non-blocking degradation `select`'s own
 * fail-soft path uses. Any other error (a genuine LLM/network failure) still
 * rejects `plan()`.
 */
export async function intentNode(
  state: PlannerState,
  runtime: PlannerRuntime
): Promise<Partial<PlannerState>> {
  checkAbort(runtime.signal);
  runtime.logger.debug(`[PipelinePlanner] intent attempt=${String(state.attempts)}`);
  runtime.onProgress?.({ phase: 'intent', attempt: state.attempts });

  const rawModel = runtime.llmFactory.createModel(runtime.modelId, {
    temperature: runtime.temperature,
  });
  const structuredModel = asStructuredOutputModel(rawModel).withStructuredOutput(IntentSchema, {
    method: 'functionCalling',
  });

  const prompt = buildIntentPrompt({ instruction: state.instruction });
  const messages = [new SystemMessage(INTENT_SYSTEM_PROMPT), new HumanMessage(prompt)];

  try {
    // T3 review llm-robustness #1: `invoke` is inside this `try` too, not
    // just `IntentSchema.parse` — see `design.node.ts`'s matching comment for
    // why a provider `functionCalling` adapter can reject `invoke` itself.
    const rawOutput = await structuredModel.invoke(messages);
    const intent = IntentSchema.parse(rawOutput);
    return {
      taskSummary: intent.taskSummary,
      needsMcp: intent.needsMcp,
      candidateProviderKeys: intent.candidateProviderKeys,
    };
  } catch (err) {
    const failure = classifyStructuredOutputError(err);
    if (!failure) throw err;
    return {
      needsMcp: false,
      plannerWarnings: [
        `[intent] structured output did not match the required schema ` +
          `(${describeStructuredOutputFailure(failure)}); proceeding to design with static specs only.`,
      ],
    };
  }
}
