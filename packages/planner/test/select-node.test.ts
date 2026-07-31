import { describe, expect, it } from 'vitest';

import { dedupeAgainstExisting } from '../src/nodes/select.node.js';

describe('dedupeAgainstExisting (quality-batch T4 review Minor 2)', () => {
  it('drops a candidate already present in existing', () => {
    const result = dedupeAgainstExisting(['a'], ['a', 'b']);
    expect(result).toEqual(['b']);
  });

  it('returns candidates unchanged when none overlap with existing', () => {
    const result = dedupeAgainstExisting([], ['a', 'b']);
    expect(result).toEqual(['a', 'b']);
  });

  it('dedupes an internally-duplicated candidates array, keeping only the first occurrence (the prescribed "seen accumulates accepted candidates" mechanism)', () => {
    // Every real call site in select.node.ts happens to pass an
    // already-unique candidates array today (see this function's doc
    // comment), so this exact input shape is unreachable through
    // `selectNode`'s public behavior — this test exercises the helper
    // directly to pin the mechanism regardless.
    const result = dedupeAgainstExisting([], ['dup', 'dup', 'unique']);
    expect(result).toEqual(['dup', 'unique']);
  });

  it('dedupes an internally-duplicated candidate that also collides with existing', () => {
    const result = dedupeAgainstExisting(['dup'], ['dup', 'dup', 'other']);
    expect(result).toEqual(['other']);
  });
});
