import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { checkAbort } from '../abort.js';
import { buildIntentPrompt, INTENT_SYSTEM_PROMPT } from '../prompts.js';
import type { PlannerRuntime } from '../runtime.js';
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
 * there is no retry loop to consider for a schema-parse failure the way
 * `design.node.ts` handles one (T1 review round 3, M6): a malformed
 * structured output here throws, the same defensive-only treatment
 * `validate.node.ts`'s "no draft in state" guard uses for a condition that
 * should be structurally unreachable with a real, schema-following model.
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
  const rawOutput = await structuredModel.invoke(messages);
  const intent = IntentSchema.parse(rawOutput);

  return {
    taskSummary: intent.taskSummary,
    needsMcp: intent.needsMcp,
    candidateProviderKeys: intent.candidateProviderKeys,
  };
}
