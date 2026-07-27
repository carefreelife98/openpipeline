import {
  analyzeTopology,
  computeAncestors,
  type CompiledNode,
  type NodeSpec,
  type PipelineWithGraph,
  type TopologyAnalysis,
} from '@openpipeline/core';
import { z } from 'zod';

export interface GraphValidationIssue {
  code:
    | 'TOPOLOGY_CYCLE'
    | 'TOPOLOGY_UNREACHABLE'
    | 'NODE_TYPE_MISMATCH'
    | 'INPUTS_REQUIRED_MISSING'
    | 'REF_SOURCE_MISSING'
    | 'REF_NOT_PREDECESSOR';
  nodeId?: string;
  slot?: string;
  message: string;
}

/**
 * Build the same `CompiledNode` map the compiler assembles for
 * `computeAncestors` — predecessors/successors from `analyzeTopology`, `spec`
 * from the resolved `specs` map (keyed by nodeId). Shared by the compiler and
 * `validateGraph` so the map is only ever built one way (no duplicate
 * implementation). Pass an already-computed `topo` to skip recomputing it (the
 * compiler already has one); `validateGraph` computes its own lazily.
 *
 * Nodes with no resolved spec are omitted: an unresolved spec is the
 * compiler's registry-lookup failure to report, not this validator's.
 */
export function toCompiledNodeMap(
  graph: PipelineWithGraph,
  specs: ReadonlyMap<string, NodeSpec>,
  topo: TopologyAnalysis = analyzeTopology(graph.nodes, graph.edges)
): Map<string, CompiledNode> {
  const nodeMap = new Map<string, CompiledNode>();
  for (const wfNode of graph.nodes) {
    const spec = specs.get(wfNode.id);
    if (!spec) continue;
    nodeMap.set(wfNode.id, {
      node: wfNode,
      spec,
      predecessors: topo.predecessorsByNode.get(wfNode.id) ?? [],
      successors: topo.successorsByNode.get(wfNode.id) ?? [],
    });
  }
  return nodeMap;
}

/**
 * Is `field` required — i.e. would `parentSchema.parse({...})` fail if the key
 * were simply absent? True when the field neither accepts `undefined` (no
 * `.optional()`) nor supplies a default for a missing key (`.default()`).
 *
 * `ZodType.isOptional()` is deprecated in zod v4 in favor of exactly this
 * safe-parse check (its own deprecation notice recommends it verbatim) — using
 * it directly keeps this in step with the currently-installed zod major
 * version instead of calling a method that trips `@typescript-eslint/no-deprecated`.
 */
function isOptionalField(field: z.ZodType): boolean {
  return field.safeParse(undefined).success;
}

/**
 * `ZodObject.shape` types its values as `Record<string, any>` in zod v4 (its
 * declared `$ZodLooseShape` is `any`-valued), so `Object.entries(...)` gives
 * back `any` fields with no cast able to narrow them safely — an `as`
 * assertion from an `any`-typed source is flagged as unnecessary (`any` is
 * trivially assignable to anything) while a bare assignment is unsafe. A real
 * runtime narrowing guard is the actual fix, not a workaround: every shape
 * value genuinely is a `ZodType` instance at runtime.
 */
function isZodTypeField(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/**
 * Default-ON compile-time validation pass, run by the compiler right after it
 * resolves every node's spec and before it builds the LangGraph. Catches
 * structural defects that would otherwise slip through to a confusing runtime
 * failure:
 *
 *   - TOPOLOGY_CYCLE: a downstream cycle that Kahn's algorithm can't fully
 *     drain, even though the graph has a valid entry elsewhere. `analyzeTopology`
 *     alone only requires >=1 zero-indegree node SOMEWHERE in the graph, so a
 *     rogue cycle downstream of a legitimate entry sails past it and only dies
 *     later at LangGraph's `recursionLimit` as an opaque RUNTIME failure (K8).
 *   - TOPOLOGY_UNREACHABLE: a node no entry's forward edges ever reach. Given
 *     that every zero-indegree node counts as an entry (so a genuinely
 *     isolated, zero-edge node is its own entry and is never flagged — see
 *     `analyzeTopology`'s "isolated node is both entry and exit" contract),
 *     this only fires for a cyclic island with no legitimate external entry
 *     into it (K14).
 *   - NODE_TYPE_MISMATCH: the persisted `node.nodeType` disagrees with the
 *     resolved spec's `nodeType` — e.g. a forged IF node pointed at a TOOL
 *     spec would otherwise bypass the compiler's true/false branch wiring
 *     entirely (K6/#9).
 *   - INPUTS_REQUIRED_MISSING: a required input slot (no `.optional()`, no
 *     `.default()`) has no binding at all — literal, state, or auto. Left
 *     unchecked, the node runner's `inputSchema.parse()` throws a raw
 *     `ZodError` mid-run instead of failing compilation (K7).
 *   - REF_SOURCE_MISSING / REF_NOT_PREDECESSOR: a `state` binding's
 *     `outputs.<nodeId>...` path points at a node that doesn't exist, or one
 *     that isn't an ancestor of the referencing node — a dead or
 *     out-of-order reference that would silently read `undefined` at runtime
 *     instead of failing compilation (K14).
 *
 * `specs` is keyed by **nodeId**, not by node `key` — the compiler resolves
 * each node's spec individually (an `mcp:` node's spec depends on which
 * provider/tool the per-run catalog cache resolves it to), so two nodes
 * sharing the same `key` could in principle resolve to different specs;
 * nodeId keeps this validator's lookups 1:1 with the compiler's own
 * `Promise.all` resolution, reconstructed into a Map before this is called.
 *
 * This is the default-ON pass; the consumer-supplied `validate` hook
 * (`CompilerDeps.validate`) still runs separately as *additional* validation,
 * not a replacement for this one.
 */
export function validateGraph(
  graph: PipelineWithGraph,
  specs: ReadonlyMap<string, NodeSpec>
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  // 1) Kahn's algorithm — any node left with residual in-degree after the
  // queue drains is part of (or strictly downstream of) a cycle.
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) indeg.set(n.id, 0);
  for (const e of graph.edges) {
    adj.set(e.fromNodeId, [...(adj.get(e.fromNodeId) ?? []), e.toNodeId]);
    indeg.set(e.toNodeId, (indeg.get(e.toNodeId) ?? 0) + 1);
  }
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  const entries = [...queue];
  let visited = 0;
  while (queue.length) {
    const id = queue.shift() as string;
    visited++;
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited < graph.nodes.length) {
    issues.push({
      code: 'TOPOLOGY_CYCLE',
      message: `cycle detected among ${String(graph.nodes.length - visited)} node(s)`,
    });
  }

  // 2) Reachability — BFS forward from every zero-indegree node. A genuinely
  // isolated zero-edge node has indegree 0, so it is trivially its own entry
  // and is never flagged here.
  const reachable = new Set<string>(entries);
  const stack = [...entries];
  while (stack.length) {
    const id = stack.pop() as string;
    for (const next of adj.get(id) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }
  for (const n of graph.nodes) {
    if (!reachable.has(n.id)) {
      issues.push({
        code: 'TOPOLOGY_UNREACHABLE',
        nodeId: n.id,
        message: `node "${n.label}" unreachable from any entry`,
      });
    }
  }

  // 3) nodeType<->spec mismatch, 4) required-slot bindings, 5) state-ref
  // liveness/ancestry — one pass per node covers all three. The ancestor map
  // is only built lazily (once), the first time a `state` binding actually
  // needs it, since not every graph has one.
  let compiledNodeMap: Map<string, CompiledNode> | undefined;
  const ancestorsOf = (id: string): string[] => {
    compiledNodeMap ??= toCompiledNodeMap(graph, specs);
    return computeAncestors(id, compiledNodeMap);
  };

  for (const n of graph.nodes) {
    const spec = specs.get(n.id);
    if (!spec) continue; // unresolved spec is the compiler's registry-lookup error to raise

    if (spec.nodeType !== n.nodeType) {
      issues.push({
        code: 'NODE_TYPE_MISMATCH',
        nodeId: n.id,
        message: `persisted nodeType "${n.nodeType}" does not match spec "${spec.key}" (${spec.nodeType})`,
      });
    }

    if (spec.inputSchema instanceof z.ZodObject) {
      for (const [key, field] of Object.entries(spec.inputSchema.shape)) {
        if (!isZodTypeField(field)) continue; // defensive: shape values are always ZodType at runtime
        const required = !isOptionalField(field) && !(field instanceof z.ZodDefault);
        if (required && n.inputs[key] === undefined) {
          issues.push({
            code: 'INPUTS_REQUIRED_MISSING',
            nodeId: n.id,
            slot: key,
            message: `required slot "${key}" on "${n.label}" has no binding (literal/state/auto)`,
          });
        }
      }
    }

    for (const [slot, binding] of Object.entries(n.inputs)) {
      if (binding.kind !== 'state') continue;
      const m = /^outputs\.([^.[]+)/.exec(binding.path);
      if (!m) continue; // meta.* / input.* etc. are out of scope for this check
      const sourceId = m[1] as string;
      if (!nodeIds.has(sourceId)) {
        issues.push({
          code: 'REF_SOURCE_MISSING',
          nodeId: n.id,
          slot,
          message: `slot "${slot}" references outputs of unknown node "${sourceId}"`,
        });
      } else if (!ancestorsOf(n.id).includes(sourceId)) {
        issues.push({
          code: 'REF_NOT_PREDECESSOR',
          nodeId: n.id,
          slot,
          message: `slot "${slot}" references "${sourceId}" which is not an ancestor of "${n.label}"`,
        });
      }
    }
  }

  return issues;
}
