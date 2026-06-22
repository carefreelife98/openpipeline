import { z } from 'zod';
import type { PipelineError } from './state.js';

/** Normalize any thrown value into a structured PipelineError. */
export function toPipelineError(err: unknown): PipelineError {
  if (err instanceof z.ZodError) {
    return { kind: 'VALIDATION', code: 'ZOD_PARSE', message: err.message };
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError' || /aborted/i.test(err.message)) {
      return { kind: 'ABORTED', code: err.name, message: err.message };
    }
    return { kind: 'RUNTIME', code: err.name, message: err.message, stack: err.stack };
  }
  return { kind: 'RUNTIME', code: 'UNKNOWN', message: String(err) };
}

/**
 * Compute the residual input schema for the auto-param resolver: the input
 * schema with all non-auto keys omitted. Requires a ZodObject input schema.
 */
export function computeRemainingSchema(
  inputSchema: z.ZodType,
  keysToOmit: readonly string[]
): z.ZodType {
  if (!(inputSchema instanceof z.ZodObject)) {
    throw new Error(
      '[computeRemainingSchema] inputSchema must be a ZodObject for auto-param resolution'
    );
  }
  if (keysToOmit.length === 0) return inputSchema;
  const omitMask: Record<string, true> = {};
  for (const k of keysToOmit) omitMask[k] = true;
  return inputSchema.omit(omitMask as never);
}
