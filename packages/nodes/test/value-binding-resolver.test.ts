import type { PipelineStateType, ValueBinding } from '@openpipeline/core';
import { describe, it, expect } from 'vitest';

import { ValueBindingResolver } from '../src/value-binding-resolver.js';

// The resolver only reads the state via path traversal, so a plain object cast
// to the state type is a faithful stand-in for these unit tests.
const state = {
  outputs: {
    nodeA: { out: 'HELLO', nonEmpty: true, nested: { deep: 42 } },
    list: { items: ['zero', 'one', 'two'] },
    nullish: null,
  },
} as unknown as PipelineStateType;

describe('ValueBindingResolver.resolveOne', () => {
  const resolver = new ValueBindingResolver();

  it('returns a literal value verbatim', () => {
    expect(resolver.resolveOne({ kind: 'literal', value: 123 }, state)).toBe(123);
  });

  it('returns literal objects without cloning', () => {
    const value = { a: 1 };
    expect(resolver.resolveOne({ kind: 'literal', value }, state)).toBe(value);
  });

  it('resolves a state path to a scalar', () => {
    expect(resolver.resolveOne({ kind: 'state', path: 'outputs.nodeA.out' }, state)).toBe('HELLO');
  });

  it('resolves a deeply nested state path', () => {
    expect(resolver.resolveOne({ kind: 'state', path: 'outputs.nodeA.nested.deep' }, state)).toBe(
      42
    );
  });

  it('resolves a bracket array index', () => {
    expect(resolver.resolveOne({ kind: 'state', path: 'outputs.list.items[1]' }, state)).toBe(
      'one'
    );
  });

  it('resolves the dot-bracket index variant', () => {
    expect(resolver.resolveOne({ kind: 'state', path: 'outputs.list.items.[2]' }, state)).toBe(
      'two'
    );
  });

  it('returns undefined for a missing key (no throw)', () => {
    expect(
      resolver.resolveOne({ kind: 'state', path: 'outputs.nodeA.absent' }, state)
    ).toBeUndefined();
  });

  it('returns undefined when traversing through null (no throw)', () => {
    expect(
      resolver.resolveOne({ kind: 'state', path: 'outputs.nullish.whatever' }, state)
    ).toBeUndefined();
  });

  it('throws on an invalid state path (prototype pollution)', () => {
    expect(() =>
      resolver.resolveOne({ kind: 'state', path: 'outputs.__proto__.x' }, state)
    ).toThrow(/invalid state\.path/);
  });

  it('throws when asked to resolve an auto binding', () => {
    expect(() => resolver.resolveOne({ kind: 'auto' }, state)).toThrow(/AutoParamResolver/);
  });
});

describe('ValueBindingResolver.resolveExplicit', () => {
  const resolver = new ValueBindingResolver();

  it('resolves every non-auto binding into a flat record', () => {
    const inputs: Record<string, ValueBinding> = {
      text: { kind: 'literal', value: 'hi' },
      ref: { kind: 'state', path: 'outputs.nodeA.out' },
    };
    expect(resolver.resolveExplicit(inputs, state)).toEqual({ text: 'hi', ref: 'HELLO' });
  });

  it('skips auto bindings, leaving them for the AutoParamResolver', () => {
    const inputs: Record<string, ValueBinding> = {
      text: { kind: 'literal', value: 'hi' },
      filled: { kind: 'auto' },
    };
    const result = resolver.resolveExplicit(inputs, state);
    expect(result).toEqual({ text: 'hi' });
    expect('filled' in result).toBe(false);
  });

  it('returns an empty record when all bindings are auto', () => {
    const inputs: Record<string, ValueBinding> = { a: { kind: 'auto' }, b: { kind: 'auto' } };
    expect(resolver.resolveExplicit(inputs, state)).toEqual({});
  });
});
