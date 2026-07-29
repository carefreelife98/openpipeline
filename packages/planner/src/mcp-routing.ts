import type { NodeSpec, PipelineDraft } from '@openpipeline/core';
import type { GraphValidationIssue } from '@openpipeline/nodes';

/**
 * T2 — combines the planner's static `NodeSpec`s with the ones `select`
 * resolved via `mcpNodeResolver.resolveSpec` for THIS round, so `design`'s
 * key -> spec lookup and `validate`'s key -> spec lookup both recognize the
 * selected MCP tools exactly like a static spec (D2). `mcpSpecs` comes after
 * `staticSpecs` so an (extremely unlikely, but not impossible — a static spec
 * could theoretically be keyed `mcp:...` by a host) key collision resolves to
 * the freshly-resolved MCP spec, since that one reflects what was actually
 * selected and offered to the model this round.
 */
export function mergeSpecs(
  staticSpecs: readonly NodeSpec[],
  mcpSpecs: readonly NodeSpec[] | undefined
): NodeSpec[] {
  if (!mcpSpecs || mcpSpecs.length === 0) return [...staticSpecs];
  return [...staticSpecs, ...mcpSpecs];
}

/**
 * D2b's correct-routing extension: does any validation issue reference a
 * node whose `key` is an `mcp:<provider>:<tool>` key that never resolved to a
 * spec? Detected structurally from `draft.nodes` (never by parsing an issue's
 * `message` text, which is a rendering detail, not a stable signal) — every
 * `NODE_TYPE_MISMATCH` issue `validate.node.ts` produces for an unresolved
 * key carries that node's persisted id in `nodeId`, so cross-referencing
 * `draft.nodes` recovers the original `key` reliably.
 *
 * `NODE_TYPE_MISMATCH` is also reused for the unrelated "duplicate short id"
 * check (T1 review round 3, M5); if that duplicate happens to land on a node
 * whose key starts with `mcp:`, this still (harmlessly) routes back to
 * `select` — re-selecting cannot fix a duplicate-id defect, but `select`
 * unconditionally hands off to `design` again afterward (D2), so the run
 * still makes forward progress on the next attempt rather than looping
 * uncorrected.
 */
export function issuesReferenceUnresolvedMcpKey(
  issues: readonly GraphValidationIssue[],
  draft: PipelineDraft | undefined
): boolean {
  if (!draft) return false;
  const nodesById = new Map(draft.nodes.map((node) => [node.id, node] as const));
  return issues.some((issue) => {
    if (issue.code !== 'NODE_TYPE_MISMATCH' || issue.nodeId === undefined) return false;
    const node = nodesById.get(issue.nodeId);
    return node !== undefined && node.key.startsWith('mcp:');
  });
}
