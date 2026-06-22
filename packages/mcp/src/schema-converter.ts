/**
 * MCP tool JSON Schema -> Zod conversion (single-step, no extra libraries).
 *
 * Uses Zod v4's native `z.fromJSONSchema`, with two pre-normalization passes:
 *   - dereferenceAllRefs: inline non-standard `$ref`s. The MCP SDK emits self-
 *     referential refs like `#/properties/foo/items/...`; zod's resolver only
 *     handles `#/$defs/` and `#/definitions/`, so we inline the rest at the door.
 *   - ensureRootObjectType: force `type: 'object'` at the root when a provider
 *     emits an implicit-object schema (properties without a type).
 *
 * KNOWN LIMIT (non-goal to fix): `fromJSONSchema` THROWS on external `$ref`,
 * `if/then/else`, `dependentSchemas`, `unevaluated*`, and `not`. There is no
 * fallback — the caller excludes such tools from the catalog. MCP servers using
 * those constructs will have tools silently absent; this is documented, not hidden.
 */
import { NOOP_LOGGER, type Logger } from '@openpipeline/core';
import type { z } from 'zod';
import { fromJSONSchema } from 'zod/v4';
import type { JSONSchema } from 'zod/v4/core';

export type ConversionFailureReason = {
  kind: 'fromJsonSchema_throw';
  error: string;
  offendingKeyword?: string;
};

export type McpSchemaConversionResult =
  | { success: true; zodSchema: z.ZodType }
  | { success: false; reason: ConversionFailureReason };

export interface ConvertOptions {
  providerKey: string;
  toolName: string;
}

/** Inline all `$ref`s via a full-path JSON Pointer resolver. Circular-safe via a visited set. */
function dereferenceAllRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const root = schema as Record<string, unknown>;

  const resolvePath = (path: string): unknown => {
    if (!path.startsWith('#/')) return null;
    const segments = path.slice(2).split('/');
    let cur: unknown = root;
    for (const seg of segments) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  };

  const visit = (node: unknown, visited: Set<string>): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((n) => visit(n, visited));

    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
      const refPath = obj.$ref;
      if (visited.has(refPath)) return { type: 'object' };
      const resolved = resolvePath(refPath);
      if (resolved && typeof resolved === 'object') {
        const newVisited = new Set(visited);
        newVisited.add(refPath);
        const resolvedDeref = visit(resolved, newVisited);
        // Merge sibling keywords over the resolved target, dropping the now-inlined `$ref`.
        const siblings: Record<string, unknown> = { ...obj };
        delete siblings.$ref;
        return { ...(resolvedDeref as object), ...siblings };
      }
      return obj;
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = visit(v, visited);
    return result;
  };

  return visit(root, new Set());
}

/** Force `type: 'object'` at the root when a provider omits it but supplies object-ish keywords. */
function ensureRootObjectType(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const obj = schema as Record<string, unknown>;
  if (typeof obj.type === 'string' || Array.isArray(obj.type)) return obj;
  if (obj.properties || obj.required || obj.additionalProperties !== undefined) {
    return { ...obj, type: 'object' };
  }
  return obj;
}

function extractOffendingKeyword(errMsg: string): string | undefined {
  const m =
    errMsg.match(/keyword:\s*['"]?([a-zA-Z$]+)['"]?/i) ?? errMsg.match(/Unsupported (\$?\w+)/i);
  return m?.[1];
}

/**
 * Convert a single MCP tool JSON Schema to a Zod schema. De-@Injectable'd from
 * the Mate-X original; logger is injected (defaults to no-op). On failure,
 * returns `{ success: false, reason }` — the caller excludes the tool.
 */
export class McpSchemaConverter {
  constructor(private readonly logger: Logger = NOOP_LOGGER) {}

  convert(jsonSchema: unknown, opts: ConvertOptions): McpSchemaConversionResult {
    // The normalizers operate on `unknown` arbitrary input but, by contract, this
    // method receives a tool's JSON Schema — assert to the concrete JSON Schema
    // shape so `fromJSONSchema` (which itself throws on unsupported keywords) types.
    const derefed = ensureRootObjectType(dereferenceAllRefs(jsonSchema)) as JSONSchema.JSONSchema;
    try {
      const zodSchema = fromJSONSchema(derefed);
      return { success: true, zodSchema };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const reason: ConversionFailureReason = {
        kind: 'fromJsonSchema_throw',
        error,
        offendingKeyword: extractOffendingKeyword(error),
      };
      this.logger.warn(
        `[mcp-schema-conversion] ${opts.providerKey}/${opts.toolName} → fromJsonSchema: ${error.slice(0, 120)}`
      );
      return { success: false, reason };
    }
  }
}
