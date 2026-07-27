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
 * Real runtime narrowing guard (not an `any`-cast) for "does this object
 * define a callable `toJSON`?" — the same shape-detection `JSON.stringify`
 * itself uses to decide whether to serialize a value via its own
 * representation (this is precisely what makes `Date` serialize to an ISO
 * string instead of `{}`).
 */
function hasToJSON(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

/**
 * Make an arbitrary runtime value safe for JSON persistence (Prisma Json
 * columns) and SSE serialization: strips functions/symbols, stringifies
 * bigints, breaks circular refs, caps depth/keys/string length.
 * Lossy conversions are marked with explicit sentinels — never silent.
 */
export function safeJson(value: unknown, opts?: SafeJsonOptions): unknown {
  const o = { ...DEFAULTS, ...opts };
  // Tracks only the CURRENT walk path (ancestors of the node being visited),
  // not every object seen anywhere in the value — see the `finally` block
  // below, which removes each object the instant its own subtree finishes.
  // Two DISTINCT branches sharing the same non-circular reference (a DAG,
  // e.g. `{ a: shared, b: shared }`) must both serialize the real value; only
  // an object that references ITSELF via its own ancestor chain is circular.
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

    // Everything below is a genuine object/array — the only kind of value
    // that can recurse, and therefore the only kind circular-reference
    // tracking applies to.
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    try {
      // Built-ins with no OWN enumerable properties (Date, Error, Map, Set)
      // silently collapsed to `{}` via the generic Object.entries() branch
      // below — a data-loss regression versus the base JSON.stringify path
      // (where Date already serialized to its ISO string via its own
      // `toJSON`) that this file's own contract ("never silent") forbids.
      // `toJSON` — checked first, matching native JSON.stringify semantics —
      // covers Date and any other object that defines one; Map/Set have no
      // `toJSON` and are converted explicitly below.
      if (hasToJSON(v)) {
        return walk(v.toJSON(), depth + 1);
      }
      if (v instanceof Error) {
        // Error's message/stack/name are non-enumerable own properties (or
        // inherited), so Object.entries() sees none of them — extract the
        // fields explicitly instead of losing the error entirely.
        return walk({ name: v.name, message: v.message, stack: v.stack }, depth + 1);
      }
      if (v instanceof Map) {
        const entries: unknown[] = [];
        let count = 0;
        for (const [k, val] of v) {
          if (count++ >= o.maxKeys) {
            entries.push('[truncated]');
            break;
          }
          entries.push([walk(k, depth + 1), walk(val, depth + 1)]);
        }
        return { '[type]': 'Map', entries };
      }
      if (v instanceof Set) {
        const values: unknown[] = [];
        let count = 0;
        for (const val of v) {
          if (count++ >= o.maxKeys) {
            values.push('[truncated]');
            break;
          }
          values.push(walk(val, depth + 1));
        }
        return { '[type]': 'Set', values };
      }
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
    } finally {
      // Path-based circular tracking (#2): un-mark `v` the instant its own
      // subtree finishes walking, so it only ever reads as "seen" while an
      // ancestor frame for it is still on the call stack — not for the rest
      // of the traversal.
      seen.delete(v);
    }
  };

  return walk(value, 0);
}
