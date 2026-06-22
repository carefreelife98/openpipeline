import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { toPipelineError, computeRemainingSchema } from '../src/error-mapping.js';

describe('toPipelineError', () => {
  it('maps a ZodError to a VALIDATION error', () => {
    const parsed = z.object({ n: z.number() }).safeParse({ n: 'nope' });
    if (parsed.success) throw new Error('expected the parse to fail');
    const result = toPipelineError(parsed.error);
    expect(result.kind).toBe('VALIDATION');
    expect(result.code).toBe('ZOD_PARSE');
    expect(typeof result.message).toBe('string');
  });

  it('maps an AbortError (by name) to an ABORTED error', () => {
    const err = new Error('the operation was cancelled');
    err.name = 'AbortError';
    const result = toPipelineError(err);
    expect(result.kind).toBe('ABORTED');
    expect(result.code).toBe('AbortError');
  });

  it('maps an error whose message mentions "aborted" to ABORTED (case-insensitive)', () => {
    const result = toPipelineError(new Error('Request was ABORTED by user'));
    expect(result.kind).toBe('ABORTED');
  });

  it('maps a generic Error to a RUNTIME error preserving name and stack', () => {
    const err = new TypeError('boom');
    const result = toPipelineError(err);
    expect(result.kind).toBe('RUNTIME');
    expect(result.code).toBe('TypeError');
    expect(result.message).toBe('boom');
    expect(result.stack).toBeDefined();
  });

  it('maps a thrown string to a RUNTIME UNKNOWN error', () => {
    const result = toPipelineError('plain string failure');
    expect(result.kind).toBe('RUNTIME');
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toBe('plain string failure');
  });

  it('maps a thrown null to a RUNTIME UNKNOWN error', () => {
    const result = toPipelineError(null);
    expect(result.kind).toBe('RUNTIME');
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toBe('null');
  });
});

describe('computeRemainingSchema', () => {
  const base = z.object({ a: z.string(), b: z.number(), c: z.boolean() });

  it('returns the same schema when no keys are omitted', () => {
    expect(computeRemainingSchema(base, [])).toBe(base);
  });

  it('omits the requested keys, leaving only the rest required', () => {
    const remaining = computeRemainingSchema(base, ['a', 'b']);
    // Only `c` should remain required; `a`/`b` are gone from the shape.
    expect(remaining.safeParse({ c: true }).success).toBe(true);
    // Missing the still-required `c` must fail.
    expect(remaining.safeParse({}).success).toBe(false);
    // Zod objects are non-strict by default: an omitted key passed in is
    // stripped from the parsed output rather than rejected.
    const parsed = remaining.safeParse({ a: 'x', c: true });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ c: true });
  });

  it('the omitted keys are no longer required', () => {
    const remaining = computeRemainingSchema(base, ['a', 'b', 'c']);
    expect(remaining.safeParse({}).success).toBe(true);
  });

  it('throws when given a non-ZodObject schema', () => {
    expect(() => computeRemainingSchema(z.string(), ['a'])).toThrow(/ZodObject/);
  });
});
