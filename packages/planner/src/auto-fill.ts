import type { NodeSpec, PipelineEdgeRow, PipelineNodeRow } from '@openpipeline/core';
import { z } from 'zod';

type DraftNode = Omit<PipelineNodeRow, 'pipelineId'>;
type DraftEdge = Omit<PipelineEdgeRow, 'pipelineId'>;

/**
 * `ZodObject.shape` types its values as `any` in zod v4 (`graph-validator.ts`
 * in `@openpipeline/nodes` documents the same fact) — narrowed the same way
 * that file does: a runtime `instanceof` guard, not an `as` cast from `any`.
 */
function isZodTypeField(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/** Same "would `parse({...})` fail if the key were absent" check `@openpipeline/nodes`'s graph-validator uses. */
function isOptionalField(field: z.ZodType): boolean {
  return field.safeParse(undefined).success;
}

function getObjectShapeField(schema: z.ZodType, field: string): z.ZodType | undefined {
  if (!(schema instanceof z.ZodObject)) return undefined;
  for (const [key, value] of Object.entries(schema.shape)) {
    if (key === field && isZodTypeField(value)) return value;
  }
  return undefined;
}

/**
 * D5 — detects the generic MCP tool output schema (`{ kind, providerKey,
 * toolName, output: z.unknown() }`, `@openpipeline/mcp`'s
 * `GenericMcpOutputSchema`) *structurally*, without depending on
 * `@openpipeline/mcp` (out of scope for the planner's kernel-purity
 * constraint — its only runtime deps are core/nodes/langgraph). A spec only
 * qualifies when it BOTH carries `meta.mcp` (an `McpNodeSpecMeta`, i.e. it
 * genuinely originates from MCP resolution) AND its `outputSchema` has an
 * `output` field typed `z.unknown()` — the exact shape the generic schema
 * produces. A hand-authored static spec that merely happens to have an
 * `output: z.unknown()` field but no `meta.mcp` is NOT treated as
 * auto-fillable (D5 is specifically about the MCP resolver's "tool declared
 * no output schema" fallback, not an general escape hatch).
 */
export function isGenericUnknownOutputSpec(spec: NodeSpec): boolean {
  if (spec.meta?.['mcp'] === undefined) return false;
  const outputField = getObjectShapeField(spec.outputSchema, 'output');
  return outputField instanceof z.ZodUnknown;
}

/**
 * D5 — deterministic auto-fill: for every edge whose source node's resolved
 * spec is a generic-unknown-output MCP spec ({@link isGenericUnknownOutputSpec}),
 * fill the target node's empty REQUIRED input slots with `{ kind: "auto" }`.
 * "Required" uses the exact same detection graph-validator.ts uses
 * (`safeParse(undefined)` fails and it isn't `.default()`-ed) so this stays
 * in lockstep with what would otherwise fail `INPUTS_REQUIRED_MISSING`.
 *
 * Idempotent and non-destructive: a slot that already has ANY binding
 * (author-provided or LLM-provided, of any kind) is never touched, and running
 * this twice over its own output is a no-op. `specsByNodeId` only needs
 * entries for nodes whose spec actually resolved — an edge whose source or
 * target has no entry is simply skipped (an unresolved-key node is reported
 * as its own validation issue elsewhere, not auto-fill's concern).
 */
export function applyAutoFill(
  nodes: readonly DraftNode[],
  edges: readonly DraftEdge[],
  specsByNodeId: ReadonlyMap<string, NodeSpec>
): DraftNode[] {
  const nodesById = new Map(nodes.map((n) => [n.id, n] as const));
  const additionsByNodeId = new Map<string, Record<string, { kind: 'auto' }>>();

  for (const edge of edges) {
    const sourceSpec = specsByNodeId.get(edge.fromNodeId);
    if (!sourceSpec || !isGenericUnknownOutputSpec(sourceSpec)) continue;

    const targetSpec = specsByNodeId.get(edge.toNodeId);
    const targetNode = nodesById.get(edge.toNodeId);
    if (!targetSpec || !targetNode || !(targetSpec.inputSchema instanceof z.ZodObject)) continue;

    const additions = additionsByNodeId.get(edge.toNodeId) ?? {};
    for (const [slot, field] of Object.entries(targetSpec.inputSchema.shape)) {
      if (!isZodTypeField(field)) continue;
      const required = !isOptionalField(field) && !(field instanceof z.ZodDefault);
      if (!required) continue;
      if (targetNode.inputs[slot] !== undefined) continue; // never overwrite an existing binding
      additions[slot] = { kind: 'auto' };
    }
    if (Object.keys(additions).length > 0) additionsByNodeId.set(edge.toNodeId, additions);
  }

  return nodes.map((n) => {
    const additions = additionsByNodeId.get(n.id);
    if (!additions) return n;
    return { ...n, inputs: { ...n.inputs, ...additions } };
  });
}
