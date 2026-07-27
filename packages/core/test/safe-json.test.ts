import { describe, it, expect } from 'vitest';

import { safeJson } from '../src/safe-json.js';

describe('safeJson', () => {
  it('replaces functions, symbols, bigints and circular refs', () => {
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    const out = safeJson({
      fn: () => 1,
      sym: Symbol('x'),
      big: 10n,
      circ,
    }) as Record<string, unknown>;
    expect(out.fn).toBe('[function]');
    expect(out.sym).toBe('[symbol]');
    expect(out.big).toBe('10');
    expect((out.circ as Record<string, unknown>).self).toBe('[circular]');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('caps depth and string length', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 30; i++) deep = { d: deep };
    const out = safeJson(deep, { maxDepth: 5 });
    expect(JSON.stringify(out)).toContain('[truncated]');
    const long = safeJson('x'.repeat(200), { maxStringLength: 100 }) as string;
    expect(long.length).toBeLessThanOrEqual(100 + '…[truncated]'.length);
  });

  // #2 — a shared (non-circular) reference reached via two distinct branches
  // of the same value — a DAG, not a cycle — must serialize the real value on
  // BOTH branches. A `seen` WeakSet that is never unmarked after a subtree
  // finishes walking treats the second branch's visit as circular even though
  // it never actually revisits an ancestor.
  it('does not treat a shared (non-circular) reference reached via two branches as circular (#2)', () => {
    const shared = { v: 1 };
    const out = safeJson({ a: shared, b: shared }) as Record<string, unknown>;
    expect(out.a).toEqual({ v: 1 });
    expect(out.b).toEqual({ v: 1 });
  });

  it('still detects a genuine circular reference through a deeper ancestor chain (#2 regression guard)', () => {
    const inner: Record<string, unknown> = { name: 'inner' };
    const outer: Record<string, unknown> = { name: 'outer', inner };
    inner.backToOuter = outer;
    const out = safeJson(outer) as Record<string, unknown>;
    const walkedInner = out.inner as Record<string, unknown>;
    expect(walkedInner.backToOuter).toBe('[circular]');
  });

  it('detects a shared reference that reappears AFTER its own subtree already finished walking, later in the same object, as circular the second time only if it is truly still on the path', () => {
    // Sibling arrays reusing the same array reference are a DAG (not a
    // cycle) — both must serialize fully, exercising `seen.delete` firing
    // correctly for Array as well as plain-object subtrees.
    const sharedArr = [1, 2, 3];
    const out = safeJson({ first: sharedArr, second: sharedArr }) as Record<string, unknown>;
    expect(out.first).toEqual([1, 2, 3]);
    expect(out.second).toEqual([1, 2, 3]);
  });

  // #3 — built-ins with no OWN enumerable properties (Date/Error/Map/Set)
  // must not silently collapse to `{}` (a regression versus the base
  // JSON.stringify path, where Date already serialized via its own toJSON).
  it('serializes a Date to its ISO string via toJSON, not an empty object (#3)', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const out = safeJson({ at: date }) as Record<string, unknown>;
    expect(out.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('serializes an Error to its name/message/stack, not an empty object (#3)', () => {
    const err = new Error('boom');
    const out = safeJson({ err }) as { err: { name: string; message: string; stack?: string } };
    expect(out.err.name).toBe('Error');
    expect(out.err.message).toBe('boom');
    expect(typeof out.err.stack).toBe('string');
  });

  it('serializes a Map to an explicit, walked entries representation, not an empty object (#3)', () => {
    const map = new Map<string, unknown>([
      ['a', 1],
      ['b', { nested: true }],
    ]);
    const out = safeJson({ map }) as { map: { '[type]': string; entries: unknown[] } };
    expect(out.map['[type]']).toBe('Map');
    expect(out.map.entries).toEqual([
      ['a', 1],
      ['b', { nested: true }],
    ]);
  });

  it('serializes a Set to an explicit, walked values representation, not an empty object (#3)', () => {
    const set = new Set([1, 2, { nested: true }]);
    const out = safeJson({ set }) as { set: { '[type]': string; values: unknown[] } };
    expect(out.set['[type]']).toBe('Set');
    expect(out.set.values).toEqual([1, 2, { nested: true }]);
  });

  it('a Date does not throw JSON.stringify and round-trips through it', () => {
    const out = safeJson({ at: new Date('2026-01-01T00:00:00.000Z') });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
