import type { NodeSpec, PipelineWithGraph } from '@openpipeline/core';
import { validateGraph, type GraphValidationIssue } from '@openpipeline/nodes';

import { checkAbort } from '../abort.js';
import { mergeSpecs } from '../mcp-routing.js';
import type { PlannerRuntime } from '../runtime.js';
import type { PlannerState } from '../state.js';

/**
 * D2's "IF-branch rule ... mirror the compiler check" — reimplemented locally
 * (not by invoking `PipelineCompiler`, which needs a full `NodeRunnerDeps`
 * bag the planner has no business assembling just to check branch labels).
 * Stricter than the compiler's own runtime check on purpose, per this task's
 * literal wording ("exactly one true + one false"): the compiler's
 * `ifBranches[label] = wfEdge.toNodeId` silently keeps only the LAST
 * same-labeled edge on a duplicate, where this flags the duplicate as an
 * error instead — worth surfacing to a self-correcting LLM even though the
 * compiler would currently tolerate it.
 *
 * `GraphValidationIssue.code` is a closed union owned by `@openpipeline/nodes`
 * with no "IF branch" member; touching that package is out of this task's
 * scope, so this reuses `INPUTS_REQUIRED_MISSING` (closest fit: a required
 * structural element — here an edge, not an input slot — is missing) with
 * `slot` set to `"true"`/`"false"` to disambiguate from an actual input slot
 * of that name.
 */
export function validateIfBranches(
  graph: PipelineWithGraph,
  specsByNodeId: ReadonlyMap<string, NodeSpec>
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const ifNodeIds = new Set(
    graph.nodes.filter((n) => specsByNodeId.get(n.id)?.nodeType === 'IF').map((n) => n.id)
  );
  if (ifNodeIds.size === 0) return issues;

  const trueCount = new Map<string, number>();
  const falseCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!ifNodeIds.has(edge.fromNodeId)) continue;
    if (edge.label === 'true') {
      trueCount.set(edge.fromNodeId, (trueCount.get(edge.fromNodeId) ?? 0) + 1);
    } else if (edge.label === 'false') {
      falseCount.set(edge.fromNodeId, (falseCount.get(edge.fromNodeId) ?? 0) + 1);
    }
  }

  for (const nodeId of ifNodeIds) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const label = node?.label ?? nodeId;
    const trues = trueCount.get(nodeId) ?? 0;
    const falses = falseCount.get(nodeId) ?? 0;
    if (trues !== 1) {
      issues.push({
        code: 'INPUTS_REQUIRED_MISSING',
        nodeId,
        slot: 'true',
        message: `IF node "${label}" (${nodeId}) must have exactly one "true"-labeled outgoing edge (found ${String(trues)})`,
      });
    }
    if (falses !== 1) {
      issues.push({
        code: 'INPUTS_REQUIRED_MISSING',
        nodeId,
        slot: 'false',
        message: `IF node "${label}" (${nodeId}) must have exactly one "false"-labeled outgoing edge (found ${String(falses)})`,
      });
    }
  }
  return issues;
}

/**
 * D2's validate node: draft -> `PipelineWithGraph` conversion, plus three
 * planner-specific structural checks that a well-formed compiled pipeline
 * would never need (an LLM-authored draft can reference a node key that
 * doesn't exist, an edge endpoint that names no declared node, or reuse the
 * same short id for two different nodes — none of these is possible via the
 * normal graph-builder UI, so `validateGraph` itself has no check for them),
 * then `@openpipeline/nodes`'s `validateGraph` and the IF-branch rule above.
 *
 * All three structural checks reuse existing `GraphValidationIssue.code`
 * values for the same reason `validateIfBranches` does (closed union, package
 * out of scope): an unresolved node key reuses `NODE_TYPE_MISMATCH` ("this
 * node's type/kind cannot be determined"); a dangling edge endpoint reuses
 * `REF_SOURCE_MISSING` ("a reference points at something that doesn't
 * exist"); a duplicate node id also reuses `NODE_TYPE_MISMATCH` ("this
 * persisted id no longer uniquely identifies one node" — T1 review round 3,
 * M5) — every message spells out plainly what actually went wrong so the
 * reused code never obscures the real defect in the design feedback.
 */
export function validateNode(
  state: PlannerState,
  runtime: PlannerRuntime
): Promise<Partial<PlannerState>> {
  checkAbort(runtime.signal);
  runtime.logger.debug(`[PipelinePlanner] validate attempt=${String(state.attempts)}`);
  runtime.onProgress?.({ phase: 'validate', attempt: state.attempts });

  const draft = state.draft;
  if (!draft) {
    // Structurally unreachable: the graph always wires design -> validate, so
    // design has already set `draft` by the time this runs. A thrown Error
    // (not a validation issue fed back to the LLM) because this is a planner
    // wiring bug, not something a correction round could ever fix.
    throw new Error('[PipelinePlanner] validate node reached with no draft in state');
  }

  // T2: mirrors `design.node.ts`'s own `mergeSpecs(runtime.specs,
  // state.mcpSpecs)` — a node whose key `select` resolved this round (D2)
  // must be recognized here too, or EVERY MCP-resolved node would always
  // fail as an "unknown node key" the instant it reached `validate`, even
  // though `design` itself resolved it correctly just one step earlier.
  const specsByKey = new Map(
    mergeSpecs(runtime.specs, state.mcpSpecs).map((spec) => [spec.key, spec] as const)
  );
  const nodeIds = new Set(draft.nodes.map((n) => n.id));

  const issues: GraphValidationIssue[] = [];

  // Duplicate short ids from the LLM (two authored nodes both "n1") collapse
  // onto the SAME persisted id here: `buildIdAssignment.resolve()`
  // deliberately returns the same UUID for a repeated short id — that's what
  // keeps a *correction round's* reused id stable across attempts (D4). When
  // the collapse instead happens *within a single draft* (an authoring
  // mistake, not a correction-round reuse), `validateGraph`'s own topology
  // check sees one node id appearing twice in `draft.nodes` and reports a
  // misleading `TOPOLOGY_CYCLE` ("cycle detected among 1 node(s)") that gives
  // the model no actionable signal about what actually went wrong (T1 review
  // round 3, M5). Detected here structurally, for the same reason the
  // unknown-key and dangling-edge checks are: `validateGraph` has no
  // dedicated check for it. Reuses `NODE_TYPE_MISMATCH` (closest fit: this
  // persisted id no longer uniquely identifies one authored node) — same
  // closed-union rationale as the other reused codes in this file. Left in
  // the issue list ALONGSIDE whatever `validateGraph` itself reports below
  // (redundant, but never wrong) rather than skipped, matching how the
  // unknown-key/dangling-edge checks above don't suppress `validateGraph`
  // either.
  const idOccurrences = new Map<string, number>();
  for (const node of draft.nodes) {
    idOccurrences.set(node.id, (idOccurrences.get(node.id) ?? 0) + 1);
  }
  for (const [id, count] of idOccurrences) {
    if (count > 1) {
      issues.push({
        code: 'NODE_TYPE_MISMATCH',
        nodeId: id,
        message:
          `${String(count)} nodes in this draft share id "${id}" — two or more of your nodes ` +
          `were given the same short id; every node's short id must be unique within one draft`,
      });
    }
  }

  const specsByNodeId = new Map<string, NodeSpec>();
  for (const node of draft.nodes) {
    const spec = specsByKey.get(node.key);
    if (!spec) {
      issues.push({
        code: 'NODE_TYPE_MISMATCH',
        nodeId: node.id,
        message: `node "${node.label}" (${node.id}) references unknown node key "${node.key}" — no matching NodeSpec was provided to the planner`,
      });
      continue;
    }
    specsByNodeId.set(node.id, spec);
  }

  for (const edge of draft.edges) {
    // Identify the edge by its endpoints, never by `edge.id`: that id is a
    // fresh `crypto.randomUUID()` minted in design.node.ts that is never
    // registered in `idMap` (only node/edge *endpoint* short ids are), so
    // `buildDesignFeedback` has no reverse mapping for it and it would leak
    // into the design prompt as a raw, LLM-meaningless UUID (D4; T1 review
    // I1). `fromNodeId`/`toNodeId` are themselves always idMap-resolved
    // (including for a dangling endpoint — see `buildIdAssignment`), so they
    // rewrite back to their short ids exactly like any other node reference.
    if (!nodeIds.has(edge.fromNodeId)) {
      issues.push({
        code: 'REF_SOURCE_MISSING',
        nodeId: edge.fromNodeId,
        message: `edge ${edge.fromNodeId} -> ${edge.toNodeId} references unknown source node "${edge.fromNodeId}" — no node with that id exists in this draft`,
      });
    }
    if (!nodeIds.has(edge.toNodeId)) {
      issues.push({
        code: 'REF_SOURCE_MISSING',
        nodeId: edge.toNodeId,
        message: `edge ${edge.fromNodeId} -> ${edge.toNodeId} references unknown target node "${edge.toNodeId}" — no node with that id exists in this draft`,
      });
    }
  }

  const graph: PipelineWithGraph = {
    pipeline: {
      id: draft.id ?? 'draft',
      name: draft.name,
      description: draft.description,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    nodes: draft.nodes.map((node) => ({ ...node, pipelineId: 'draft' })),
    edges: draft.edges.map((edge) => ({ ...edge, pipelineId: 'draft' })),
  };

  issues.push(...validateGraph(graph, specsByNodeId));
  issues.push(...validateIfBranches(graph, specsByNodeId));

  return Promise.resolve({ validationIssues: issues });
}
