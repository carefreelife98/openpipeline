import type { BaseMessage } from '@langchain/core/messages';
import type { LlmFactory } from '@openpipeline/core';
import type { z } from 'zod';

export interface StructuredCallRecord {
  method?: string;
  messages: BaseMessage[];
}

/**
 * Minimal, deterministic, self-contained fake for `withStructuredOutput`
 * (per the task: "@langchain/core 의 FakeListChatModel 또는 자체 minimal fake" —
 * a hand-rolled fake here rather than `FakeListChatModel`, since the tests
 * need to (a) return a DIFFERENT canned object on each successive call within
 * a single `plan()` run — one per correction attempt — and (b) capture
 * exactly what `withStructuredOutput` was called with (the `method` option,
 * and the messages/prompt content), neither of which
 * `@langchain/core`'s `FakeListChatModel.withStructuredOutput` is built to
 * do). Never touches a real model.
 */
export class FakeChatModel {
  readonly calls: StructuredCallRecord[] = [];
  private callIndex = 0;

  /**
   * One canned response per expected `design` call, in order. A run that
   * calls `withStructuredOutput().invoke()` more times than there are
   * responses repeats the LAST response (handy for an "always invalid"
   * exhaustion scenario without padding out a response per attempt).
   */
  constructor(private readonly responses: readonly unknown[]) {
    if (responses.length === 0) {
      throw new Error('FakeChatModel requires at least one canned response');
    }
  }

  withStructuredOutput(
    _schema: z.ZodType,
    config?: { method?: string }
  ): { invoke(input: unknown): Promise<unknown> } {
    return {
      invoke: (input: unknown): Promise<unknown> => {
        const index = Math.min(this.callIndex, this.responses.length - 1);
        this.callIndex += 1;
        this.calls.push({ method: config?.method, messages: input as BaseMessage[] });
        return Promise.resolve(this.responses[index]);
      },
    };
  }
}

export function makeLlmFactory(model: FakeChatModel): LlmFactory {
  return {
    createModel: () => model,
  };
}
