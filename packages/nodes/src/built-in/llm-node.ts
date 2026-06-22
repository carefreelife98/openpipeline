import { z } from 'zod';
import { defineNode, type NodeSpec, type LlmNodeOutput } from '@openpipeline/core';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  costFromLlmResponse,
  extractTokenUsage,
  resolveFinishReason,
  resolveText,
} from './llm-helpers.js';

export interface LlmNodeOptions {
  /**
   * Allowed model ids. Unlike the Mate-X hardcoded list, this is configurable.
   * Pass the model ids your LlmFactory understands. If omitted, any string is
   * accepted.
   */
  models?: readonly string[];
  /** Default model id when the input omits one. */
  defaultModel?: string;
}

function buildInputSchema(opts: LlmNodeOptions) {
  const modelField =
    opts.models && opts.models.length > 0
      ? z.enum(opts.models as [string, ...string[]])
      : z.string().min(1);
  return z.object({
    userPrompt: z.string().min(1).describe('The user message.'),
    systemPrompt: z.string().optional().describe('Optional system prompt.'),
    model: (opts.defaultModel ? modelField.default(opts.defaultModel) : modelField).describe(
      'Model id to invoke.'
    ),
    temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0–2).'),
    maxTokens: z.number().int().positive().optional().describe('Max output tokens.'),
  });
}

export type LlmInput = z.infer<ReturnType<typeof buildInputSchema>>;

export const LlmOutputSchema = z.object({
  kind: z.literal('llm.invoke'),
  text: z.string(),
  finishReason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'unknown']),
  tokenUsage: z.object({ input: z.number(), output: z.number(), total: z.number() }),
}) as unknown as z.ZodType<LlmNodeOutput>;

/**
 * Built-in LLM node. Invokes a model via `ctx.createLLM` (your LlmFactory) and
 * returns the text + token usage. Provider-agnostic: it only relies on the
 * LangChain `BaseChatModel` `.invoke()` shape.
 */
export function createLlmInvokeNodeSpec(
  opts: LlmNodeOptions = {}
): NodeSpec<LlmInput, LlmNodeOutput> {
  const inputSchema = buildInputSchema(opts) as unknown as z.ZodType<LlmInput>;
  return defineNode<LlmInput, LlmNodeOutput>({
    key: 'llm.invoke',
    nodeType: 'LLM',
    displayName: 'LLM Invoke',
    description: 'Sends a message to a language model and returns the response.',
    icon: 'sparkles',
    inputSchema,
    outputSchema: LlmOutputSchema,
    handler: async (input, ctx) => {
      const model = ctx.createLLM(input.model, {
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      }) as { invoke: (messages: unknown[], config?: unknown) => Promise<unknown> };

      const messages = [
        ...(input.systemPrompt ? [new SystemMessage(input.systemPrompt)] : []),
        new HumanMessage(input.userPrompt),
      ];

      const response = await model.invoke(messages, { signal: ctx.signal });
      ctx.reportCost(costFromLlmResponse(response));

      return {
        kind: 'llm.invoke',
        text: resolveText(response),
        finishReason: resolveFinishReason(response),
        tokenUsage: extractTokenUsage(response),
      };
    },
  });
}
