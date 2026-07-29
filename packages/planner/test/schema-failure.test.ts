import { OutputParserException } from '@langchain/core/output_parsers';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  classifyStructuredOutputError,
  describeStructuredOutputFailure,
  summarizeZodIssues,
} from '../src/schema-failure.js';

/** A real `z.ZodError`, produced the same way `<Schema>.parse()` produces one in the nodes. */
function makeZodError(): z.ZodError {
  try {
    z.object({ text: z.string() }).parse({ text: 42 });
    throw new Error('test fixture bug: expected .parse() to throw');
  } catch (err) {
    if (!(err instanceof z.ZodError)) throw err;
    return err;
  }
}

describe('classifyStructuredOutputError (T3 review llm-robustness #1)', () => {
  it('classifies a z.ZodError as { kind: "zod" }', () => {
    const zodError = makeZodError();
    expect(classifyStructuredOutputError(zodError)).toEqual({ kind: 'zod', error: zodError });
  });

  it('classifies an OutputParserException as { kind: "output-parser" } — the shape a provider functionCalling adapter (e.g. ChatOpenAI) rejects `invoke()` with', () => {
    const outputParserError = new OutputParserException('Failed to parse. Text: "{}"');
    expect(classifyStructuredOutputError(outputParserError)).toEqual({
      kind: 'output-parser',
      error: outputParserError,
    });
  });

  it('returns undefined for a genuine (non-schema) Error — the caller must rethrow it, not degrade fail-soft', () => {
    expect(classifyStructuredOutputError(new Error('simulated network failure'))).toBeUndefined();
  });

  it('returns undefined for a non-Error thrown value', () => {
    expect(classifyStructuredOutputError('not an error at all')).toBeUndefined();
    expect(classifyStructuredOutputError(undefined)).toBeUndefined();
  });
});

describe('describeStructuredOutputFailure (T3 review llm-robustness #1)', () => {
  it('delegates the "zod" case to summarizeZodIssues', () => {
    const zodError = makeZodError();
    expect(describeStructuredOutputFailure({ kind: 'zod', error: zodError })).toBe(
      summarizeZodIssues(zodError)
    );
  });

  it('returns the OutputParserException\'s own .message for the "output-parser" case (it has no .issues tree to summarize)', () => {
    const outputParserError = new OutputParserException('Failed to parse. Text: "{}"');
    // `OutputParserException`'s constructor appends a troubleshooting URL to
    // `.message` (`addLangChainErrorFields`) — assert equality with the
    // error's own `.message` (not a hardcoded string) so this doesn't
    // silently drift from whatever `@langchain/core` actually produces.
    expect(
      describeStructuredOutputFailure({ kind: 'output-parser', error: outputParserError })
    ).toBe(outputParserError.message);
    expect(
      describeStructuredOutputFailure({ kind: 'output-parser', error: outputParserError })
    ).toContain('Failed to parse. Text: "{}"');
  });
});
