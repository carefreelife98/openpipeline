import { HumanMessage } from '@langchain/core/messages';

/**
 * Extracts the plain-string content of the single `HumanMessage` inside a
 * captured `withStructuredOutput().invoke(messages)` call — every prompt
 * builder in this package (`buildDesignPrompt`/`buildIntentPrompt`/
 * `buildSelectPrompt`) returns a plain string, and every node sends it as
 * exactly one `HumanMessage` alongside one `SystemMessage`. Shared by every
 * test file that asserts on prompt CONTENT (as opposed to just call count) —
 * e.g. "the previous attempt's dangling edge is named by its short id" or "a
 * tool description longer than 240 chars is truncated".
 */
export function findHumanMessageText(messages: readonly unknown[]): string {
  const human = messages.find((m) => m instanceof HumanMessage);
  if (!human) throw new Error('test fixture bug: no HumanMessage found in captured call');
  const { content } = human as HumanMessage;
  if (typeof content !== 'string') {
    throw new Error('test fixture bug: expected HumanMessage content to be a plain string');
  }
  return content;
}
