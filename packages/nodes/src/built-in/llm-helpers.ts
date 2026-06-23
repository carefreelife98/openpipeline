import type { CostBundle, LlmFinishReason } from '@openpipeline/core';

export interface ExtractedTokenUsage {
  input: number;
  output: number;
  total: number;
}

/**
 * Extract token usage from a LangChain response, recognizing both the new
 * `usage_metadata` and the legacy `response_metadata.usage` shapes.
 */
export function extractTokenUsage(response: unknown): ExtractedTokenUsage {
  if (!response || typeof response !== 'object') return { input: 0, output: 0, total: 0 };
  const r = response as {
    usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    response_metadata?: {
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
  };
  const meta = (r.usage_metadata ?? r.response_metadata?.usage ?? {}) as Record<
    string,
    number | undefined
  >;
  const input = meta.input_tokens ?? meta.prompt_tokens ?? 0;
  const output = meta.output_tokens ?? meta.completion_tokens ?? 0;
  const total = meta.total_tokens ?? input + output;
  return { input, output, total };
}

/**
 * Cost from a response. Tokens are extracted; `dollars` is left at 0 — pricing
 * tables are a host concern (provide your own by wrapping the LlmFactory or
 * post-processing the run cost). `llmCalls` is always 1.
 */
export function costFromLlmResponse(response: unknown): CostBundle {
  const { input, output, total } = extractTokenUsage(response);
  return { tokens: { input, output, total }, dollars: 0, llmCalls: 1 };
}

export function resolveFinishReason(response: unknown): LlmFinishReason {
  const r = response as {
    response_metadata?: { finish_reason?: string };
    additional_kwargs?: { finish_reason?: string };
  };
  const raw = r.response_metadata?.finish_reason ?? r.additional_kwargs?.finish_reason;
  const valid: LlmFinishReason[] = ['stop', 'length', 'tool_calls', 'content_filter'];
  return valid.includes(raw as LlmFinishReason) ? (raw as LlmFinishReason) : 'unknown';
}

export function resolveText(response: unknown): string {
  const r = response as { content?: unknown };
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) {
    return r.content
      .map((c) => (typeof c === 'string' ? c : ((c as { text?: string }).text ?? '')))
      .join('');
  }
  return '';
}
