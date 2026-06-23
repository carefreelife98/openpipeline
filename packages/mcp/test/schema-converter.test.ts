import type { Logger } from '@openpipeline/core';
import { describe, it, expect } from 'vitest';

import { McpSchemaConverter } from '../src/schema-converter.js';

const OPTS = { providerKey: 'prov', toolName: 'tool' } as const;

/**
 * A minimal capturing Logger (implements the real core contract). Lets us assert
 * the converter logs a warning on conversion failure without mocking the thing
 * under test — the converter is real, only this external boundary is recorded.
 */
class CapturingLogger implements Logger {
  readonly warnings: string[] = [];
  info(): void {}
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(): void {}
  debug(): void {}
}

describe('McpSchemaConverter — successful conversions', () => {
  const converter = new McpSchemaConverter();

  it('converts a basic object schema and validates a conforming value', () => {
    const result = converter.convert(
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      OPTS
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.zodSchema.safeParse({ a: 'hello' });
    expect(parsed.success).toBe(true);
  });

  it('produces a schema that rejects a value missing a required field', () => {
    const result = converter.convert(
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      OPTS
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse({}).success).toBe(false);
  });

  it('forces an object type at the root when type is omitted (implicit object)', () => {
    // ensureRootObjectType: properties present but no `type` → treated as object.
    const result = converter.convert({ properties: { n: { type: 'number' } } }, OPTS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.zodSchema.safeParse({ n: 5 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ n: 5 });
  });

  it('converts an array schema with typed items', () => {
    const result = converter.convert({ type: 'array', items: { type: 'number' } }, OPTS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse([1, 2, 3]).success).toBe(true);
    expect(result.zodSchema.safeParse(['x']).success).toBe(false);
  });

  it('converts a string enum and rejects out-of-set values', () => {
    const result = converter.convert({ type: 'string', enum: ['a', 'b'] }, OPTS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse('a').success).toBe(true);
    expect(result.zodSchema.safeParse('z').success).toBe(false);
  });

  it('converts a primitive (non-object) root schema', () => {
    const result = converter.convert({ type: 'string' }, OPTS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse('hi').success).toBe(true);
    expect(result.zodSchema.safeParse(42).success).toBe(false);
  });

  it('treats an empty schema as accept-anything', () => {
    const result = converter.convert({}, OPTS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse({ whatever: true }).success).toBe(true);
  });

  it('applies additionalProperties:false as a strict object (rejects unknown keys)', () => {
    const result = converter.convert(
      { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      OPTS
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse({ a: 'x' }).success).toBe(true);
    expect(result.zodSchema.safeParse({ a: 'x', extra: 1 }).success).toBe(false);
  });

  it('applies a declared default value', () => {
    const result = converter.convert(
      { type: 'object', properties: { a: { type: 'string', default: 'D' } } },
      OPTS
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.zodSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ a: 'D' });
  });
});

describe('McpSchemaConverter — $ref dereferencing', () => {
  const converter = new McpSchemaConverter();

  it('inlines an internal full-path JSON Pointer $ref', () => {
    const result = converter.convert(
      {
        type: 'object',
        properties: { x: { $ref: '#/properties/y' }, y: { type: 'string' } },
      },
      OPTS
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.zodSchema.safeParse({ x: 'a', y: 'b' });
    expect(parsed.success).toBe(true);
    // x was a $ref to y (string) → a number must be rejected.
    expect(result.zodSchema.safeParse({ x: 1, y: 'b' }).success).toBe(false);
  });

  it('resolves a $defs reference (zod-native local ref)', () => {
    const result = converter.convert(
      {
        type: 'object',
        properties: { n: { $ref: '#/$defs/Num' } },
        $defs: { Num: { type: 'integer' } },
      },
      OPTS
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse({ n: 3 }).success).toBe(true);
    expect(result.zodSchema.safeParse({ n: 1.5 }).success).toBe(false);
  });

  it('survives a self-referential ($ref to #) schema without infinite recursion', () => {
    // dereferenceAllRefs is circular-safe via a visited set; the cycle collapses
    // to { type: 'object' }. The contract is "does not hang / does not throw".
    const result = converter.convert({ type: 'object', properties: { self: { $ref: '#' } } }, OPTS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse({ self: {} }).success).toBe(true);
  });

  it('merges sibling keywords over a resolved $ref target', () => {
    const result = converter.convert(
      {
        type: 'object',
        properties: { x: { $ref: '#/$defs/N', description: 'overridden' } },
        $defs: { N: { type: 'number' } },
      },
      OPTS
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.zodSchema.safeParse({ x: 7 }).success).toBe(true);
  });
});

describe('McpSchemaConverter — rejected schemas (documented KNOWN LIMIT)', () => {
  const converter = new McpSchemaConverter();

  // fromJSONSchema THROWS on these constructs; the converter must turn the throw
  // into a typed failure result (never an uncaught exception) so the caller can
  // exclude the tool.
  const rejected: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['not', { type: 'object', not: { type: 'string' } }],
    [
      'if/then/else',
      { type: 'object', if: { properties: { a: { const: 1 } } }, then: { required: ['b'] } },
    ],
    [
      'external $ref',
      { type: 'object', properties: { x: { $ref: 'https://example.com/foo.json' } } },
    ],
    ['dependentSchemas', { type: 'object', dependentSchemas: { a: { required: ['b'] } } }],
  ];

  for (const [label, schema] of rejected) {
    it(`returns a typed failure (not a throw) for ${label}`, () => {
      const result = converter.convert(schema, OPTS);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.reason.kind).toBe('fromJsonSchema_throw');
      expect(result.reason.error.length).toBeGreaterThan(0);
    });
  }

  it('does not throw for a non-object input; returns a failure result', () => {
    // dereferenceAllRefs/ensureRootObjectType pass primitives through unchanged,
    // so fromJSONSchema throws internally and convert() catches it.
    const result = converter.convert('not-a-schema', OPTS);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason.kind).toBe('fromJsonSchema_throw');
  });

  it('does not throw for a null input; returns a failure result', () => {
    const result = converter.convert(null, OPTS);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.reason.kind).toBe('fromJsonSchema_throw');
  });
});

describe('McpSchemaConverter — logging side effect', () => {
  it('warns through the injected logger on a conversion failure', () => {
    const logger = new CapturingLogger();
    const converter = new McpSchemaConverter(logger);
    const result = converter.convert({ type: 'object', not: { type: 'string' } }, OPTS);
    expect(result.success).toBe(false);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('mcp-schema-conversion');
    // The warning carries the provider/tool identity for diagnosis.
    expect(logger.warnings[0]).toContain('prov/tool');
  });

  it('does not warn on a successful conversion', () => {
    const logger = new CapturingLogger();
    const converter = new McpSchemaConverter(logger);
    const result = converter.convert(
      { type: 'object', properties: { a: { type: 'string' } } },
      OPTS
    );
    expect(result.success).toBe(true);
    expect(logger.warnings).toHaveLength(0);
  });
});
