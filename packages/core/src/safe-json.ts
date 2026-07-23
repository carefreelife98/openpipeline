export interface SafeJsonOptions {
  maxDepth?: number;
  maxStringLength?: number;
  maxKeys?: number;
}

const DEFAULTS: Required<SafeJsonOptions> = {
  maxDepth: 20,
  maxStringLength: 100_000,
  maxKeys: 1_000,
};

/**
 * Make an arbitrary runtime value safe for JSON persistence (Prisma Json
 * columns) and SSE serialization: strips functions/symbols, stringifies
 * bigints, breaks circular refs, caps depth/keys/string length.
 * Lossy conversions are marked with explicit sentinels — never silent.
 */
export function safeJson(value: unknown, opts?: SafeJsonOptions): unknown {
  const o = { ...DEFAULTS, ...opts };
  const seen = new WeakSet();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      return v.length > o.maxStringLength ? v.slice(0, o.maxStringLength) + '…[truncated]' : v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function') return '[function]';
    if (typeof v === 'symbol') return '[symbol]';
    if (depth >= o.maxDepth) return '[truncated]';
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) {
      const arr = v.slice(0, o.maxKeys).map((x) => walk(x, depth + 1));
      if (v.length > o.maxKeys) arr.push('[truncated]');
      return arr;
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, val] of Object.entries(v)) {
      if (count++ >= o.maxKeys) {
        out['[truncated]'] = true;
        break;
      }
      out[k] = walk(val, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}
