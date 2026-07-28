import type { z } from 'zod';

/**
 * Minimal structural shape this package needs from the model
 * `llmFactory.createModel()` returns — the same `unknown`-and-cast-at-the-call-site
 * seam `@openpipeline/core`'s `LlmFactory` contract documents (e.g.
 * `@openpipeline/nodes`'s built-in LLM node handler does the same narrowing).
 * Matches LangChain's `BaseChatModel.withStructuredOutput` closely enough to
 * accept a real `BaseChatModel` without any adapter shim.
 */
export interface StructuredOutputCapableModel {
  withStructuredOutput(
    schema: z.ZodType,
    config?: { method?: string }
  ): { invoke(input: unknown): Promise<unknown> };
}

function hasStructuredOutput(value: object): value is { withStructuredOutput: unknown } {
  return 'withStructuredOutput' in value;
}

/**
 * Narrows the `unknown` model from `llmFactory.createModel()` to
 * {@link StructuredOutputCapableModel}, or throws a clear, actionable error —
 * never a silent `as` cast onto a model that doesn't actually support
 * structured output (D3 requires `withStructuredOutput(..., { method:
 * "functionCalling" })`; a model missing the method entirely would otherwise
 * fail as an opaque "not a function" a few lines later).
 */
export function asStructuredOutputModel(model: unknown): StructuredOutputCapableModel {
  if (
    model !== null &&
    typeof model === 'object' &&
    hasStructuredOutput(model) &&
    typeof model.withStructuredOutput === 'function'
  ) {
    return model as StructuredOutputCapableModel;
  }
  throw new Error(
    '[PipelinePlanner] the model returned by llmFactory.createModel(modelId, ...) does not ' +
      'implement withStructuredOutput(...) — the planner requires a LangChain ' +
      'BaseChatModel-compatible model.'
  );
}
