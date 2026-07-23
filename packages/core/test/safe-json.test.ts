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
});
