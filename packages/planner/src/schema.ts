import { ValueBindingSchema } from '@openpipeline/core';
import { z } from 'zod';

// D3 — the structured-output contract the design LLM fills in. Deliberately
// named `PlannerDraft*` (not `PipelineDraft*`) to keep it visually distinct
// from `@openpipeline/core`'s `PipelineDraft`: this is the short-id,
// LLM-facing shape *before* id remapping/positions/nodeType resolution; the
// final `PipelineDraft` (D9) is a different, UUID-keyed type produced by the
// design node after processing this.

export const PlannerDraftNodeSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe(
      'A short id you choose for this node, unique within this draft (e.g. "n1", "n2"). Not a UUID — the planner assigns persisted ids separately.'
    ),
  key: z
    .string()
    .min(1)
    .describe('The NodeSpec key for this node, copied exactly from the catalog above.'),
  label: z.string().min(1).describe('Short human-readable label for this node.'),
  inputs: z
    .record(z.string(), ValueBindingSchema)
    .describe(
      'Map of input slot name -> binding. Use {"kind":"literal","value":...} for constants, ' +
        '{"kind":"state","path":"outputs.<nodeId>.<field>"} to read another node\'s output ' +
        '(node id must be one of the short ids used in this draft), or {"kind":"auto"} to leave a ' +
        'slot for runtime resolution.'
    ),
});

export const PlannerDraftEdgeSchema = z.object({
  from: z.string().min(1).describe('Source node short id.'),
  to: z.string().min(1).describe('Target node short id.'),
  label: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'Required on every edge leaving an IF node: exactly one "true"-labeled and one ' +
        '"false"-labeled outgoing edge per IF node. Omit for all other edges.'
    ),
});

export const PlannerDraftSchema = z.object({
  nodes: z.array(PlannerDraftNodeSchema).min(1).describe('Every node in the pipeline.'),
  edges: z.array(PlannerDraftEdgeSchema).describe('Every edge connecting the nodes above.'),
});

export type PlannerDraftNode = z.infer<typeof PlannerDraftNodeSchema>;
export type PlannerDraftEdge = z.infer<typeof PlannerDraftEdgeSchema>;
export type PlannerDraft = z.infer<typeof PlannerDraftSchema>;

// T2 — D2's `intent` structured-output contract: `{ taskSummary, needsMcp,
// candidateProviderKeys }`. Only used on the MCP-catalog path (`intent` isn't
// wired into the no-catalog graph).

export const IntentSchema = z.object({
  taskSummary: z
    .string()
    .min(1)
    .describe("A one-sentence summary of what the user's instruction is asking for."),
  needsMcp: z
    .boolean()
    .describe(
      'True if fulfilling this instruction requires an external MCP tool (e.g. web search, a ' +
        'third-party API or integration) beyond the static node specs already available. If ' +
        'unsure, prefer true so a tool catalog can be offered.'
    ),
  candidateProviderKeys: z
    .array(z.string())
    .describe(
      'Zero or more MCP provider keys that seem relevant to this instruction, if you can guess ' +
        'any from the instruction alone (informational hint only — the actual catalog is shown ' +
        'separately in the next step). Empty array if none come to mind or needsMcp is false.'
    ),
});

export type Intent = z.infer<typeof IntentSchema>;

// T2 — D2's `select` structured-output contract: the model picks zero or
// more `mcp:<provider>:<tool>` keys copied exactly from the catalog shown to
// it. Deliberately `z.string()`, not a dynamic `z.enum(...)` built from the
// live catalog: an out-of-catalog or malformed key is filtered out by
// `selectNode` itself (fail-soft — D2), not rejected at the schema layer,
// mirroring `PlannerDraftNodeSchema.key`'s same "copied exactly, validated
// downstream" treatment.

export const SelectSchema = z.object({
  selectedKeys: z
    .array(z.string())
    .describe(
      'Zero or more "mcp:<provider>:<tool>" keys, copied EXACTLY from the catalog above, that ' +
        'are actually needed to fulfill the instruction. Return an empty array if none are needed.'
    ),
});

export type SelectDraft = z.infer<typeof SelectSchema>;
