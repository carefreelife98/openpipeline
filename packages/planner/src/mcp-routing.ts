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
 * D2b re-selection: merges an EARLIER round's resolved `mcpSpecs` with THIS
 * round's freshly-resolved ones, keyed by `spec.key`, so a D2b re-entry into
 * `select` (a validation issue routed `correct` back to `select` — see
 * `issuesReferenceUnresolvedMcpKey` below) can never silently drop a
 * previously-resolved tool a still-valid part of the draft references.
 *
 * Same preservation semantics `select.node.ts`'s empty-reselection branch
 * already has (T2 review Minor 4 — an earlier round's specs survive an empty
 * re-selection because they're left untouched rather than reset to `[]`):
 * unifies the non-empty branch, which used to write `resolvedSpecs`
 * unconditionally and so silently dropped an earlier round's key the moment
 * this round selected ANY key at all, even a disjoint one (T2 re-review round
 * 2, Minor-4 residual, non-blocking — carried over to T3).
 *
 * "New keys win" (not "first write wins"): `current` entirely replaces any
 * `previous` entry sharing its key, since `current` reflects what was
 * actually just re-selected and re-resolved against the (possibly refreshed)
 * catalog this round — the same "freshest resolution wins" reasoning
 * `mergeSpecs` above already applies between static and mcp specs. A
 * `previous` entry whose key does NOT appear in `current` (this round simply
 * didn't re-select it) survives unchanged — that is the whole point.
 */
export function mergeResolvedMcpSpecs(
  previous: readonly NodeSpec[] | undefined,
  current: readonly NodeSpec[]
): NodeSpec[] {
  if (!previous || previous.length === 0) return [...current];
  const currentKeys = new Set(current.map((spec) => spec.key));
  const carriedOver = previous.filter((spec) => !currentKeys.has(spec.key));
  return [...carriedOver, ...current];
}

/**
 * Returns the distinct `mcp:<provider>:<tool>` keys referenced by `issues`
 * via a `NODE_TYPE_MISMATCH`-flagged node that never resolved to a spec.
 * Detected structurally from `draft.nodes` (never by parsing an issue's
 * `message` text, which is a rendering detail, not a stable signal) — every
 * `NODE_TYPE_MISMATCH` issue `validate.node.ts` produces for an unresolved
 * key carries that node's persisted id in `nodeId`, so cross-referencing
 * `draft.nodes` recovers the original `key` reliably.
 *
 * `NODE_TYPE_MISMATCH` is also reused for the unrelated "duplicate short id"
 * check (T1 review round 3, M5); if that duplicate happens to land on a node
 * whose key starts with `mcp:`, it's included here too — see
 * {@link issuesReferenceUnresolvedMcpKey}'s doc comment for why that's
 * harmless.
 *
 * Shared by `correct.node.ts` (via {@link issuesReferenceUnresolvedMcpKey}'s
 * boolean) and `select.node.ts`'s D2b re-entry prompt (T3 review
 * llm-robustness #2), which needs the actual key list — not just whether one
 * exists — to name the offending key(s) in the re-selection prompt instead of
 * re-issuing a byte-identical one.
 */
export function unresolvedMcpKeysFromIssues(
  issues: readonly GraphValidationIssue[],
  draft: PipelineDraft | undefined
): string[] {
  if (!draft) return [];
  const nodesById = new Map(draft.nodes.map((node) => [node.id, node] as const));
  const keys = new Set<string>();
  for (const issue of issues) {
    if (issue.code !== 'NODE_TYPE_MISMATCH' || issue.nodeId === undefined) continue;
    const node = nodesById.get(issue.nodeId);
    if (node !== undefined && node.key.startsWith('mcp:')) keys.add(node.key);
  }
  return [...keys];
}

/**
 * D2b's correct-routing extension: does any validation issue reference a
 * node whose `key` is an `mcp:<provider>:<tool>` key that never resolved to a
 * spec? A thin boolean wrapper over {@link unresolvedMcpKeysFromIssues} — see
 * its doc comment for the detection details.
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
  return unresolvedMcpKeysFromIssues(issues, draft).length > 0;
}
