import { StateGraph, START, END } from '@langchain/langgraph';
import {
  PipelineStateAnnotation,
  analyzeTopology,
  PipelineCompileError,
  type PipelineWithGraph,
  type CompiledNode,
  type NodeSpec,
} from '@openpipeline/core';

import { validateGraph, toCompiledNodeMap } from './graph-validator.js';
import { makeNodeRunner, type NodeRunnerDeps } from './node-runner.js';
import type { NodeSpecRegistry, NodeResolveContext } from './registry.js';

/** Deps the caller supplies; `nodeMap` is filled internally by the compiler. */
export type CompilerDeps = Omit<NodeRunnerDeps, 'nodeMap'> & {
  registry: NodeSpecRegistry;
  /** Optional graph validator. Throw or return errors to reject compilation. */
  validate?: (graph: PipelineWithGraph, ctx: NodeResolveContext) => Promise<void> | void;
};

export interface CompiledPipeline {
  pipelineId: string;
  pipelineName: string;
  // LangGraph's compiled app; typed loosely to keep its generics off the surface.
  app: {
    invoke: (input: unknown, config?: unknown) => Promise<unknown>;
    streamEvents: (input: unknown, config?: unknown) => AsyncIterable<unknown>;
  };
  entryNodeIds: readonly string[];
  exitNodeIds: readonly string[];
  nodeMap: ReadonlyMap<string, CompiledNode>;
}

interface CacheEntry {
  cacheKey: string;
  compiled: CompiledPipeline;
}

/**
 * Compiles a pipeline graph into a runnable LangGraph StateGraph. De-@Injectable
 * from the Mate-X original: a plain class. Preserves the LRU cache, the fan-in
 * `defer` semantics, and the MCP-node cache-bypass policy verbatim.
 */
export class PipelineCompiler {
  private readonly cache: CacheEntry[] = [];
  private readonly CAPACITY = 10;

  constructor(private readonly deps: CompilerDeps) {}

  /**
   * Compile a pipeline graph. `ctx` (userId/tenantId/mcpCatalogCache) is a
   * per-call parameter, not shared mutable state — concurrent `compile()`
   * calls (e.g. two users running different MCP-enabled pipelines at once)
   * each see only their own `ctx` (#E5 — was a shared-field race before).
   */
  async compile(graph: PipelineWithGraph, ctx: NodeResolveContext = {}): Promise<CompiledPipeline> {
    // MCP-node graphs bypass the cache: an MCP spec depends on user/provider
    // state, so a cache hit could serve a stale spec.
    const hasMcpNode = graph.nodes.some((n) => n.key.startsWith('mcp:'));
    const cacheKey = `${graph.pipeline.id}:${String(new Date(graph.pipeline.updatedAt).getTime())}`;

    if (!hasMcpNode) {
      const idx = this.cache.findIndex((e) => e.cacheKey === cacheKey);
      const entry = idx === -1 ? undefined : this.cache[idx];
      if (entry) {
        this.cache.splice(idx, 1);
        this.cache.unshift(entry);
        return entry.compiled;
      }
    }

    if (this.deps.validate) {
      await this.deps.validate(graph, ctx);
    }

    const topo = analyzeTopology(graph.nodes, graph.edges);
    if (topo.entryNodes.length < 1 || topo.exitNodes.length < 1) {
      throw new PipelineCompileError(
        [
          {
            scope: 'graph',
            kind: 'TOPOLOGY_NO_ENTRY',
            message: 'Expected at least one entry and one exit node',
          },
        ],
        graph.pipeline.name
      );
    }

    const entryNodeIds = topo.entryNodes.map((n) => n.id);
    const exitNodeIds = topo.exitNodes.map((n) => n.id);

    // Resolve every node's spec in parallel first (MCP nodes resolve via the
    // registry's resolver). `specByNodeId` is keyed by nodeId (not by `key`) —
    // an `mcp:` node's spec depends on the per-run catalog cache, so two nodes
    // sharing a key could resolve to different specs.
    const resolved = await Promise.all(
      graph.nodes.map(async (wfNode) => ({
        wfNode,
        spec: await this.deps.registry.get(wfNode.key, ctx),
      }))
    );
    const specByNodeId = new Map<string, NodeSpec>(
      resolved.map(({ wfNode, spec }) => [wfNode.id, spec])
    );

    // Default-ON compile-time validation: downstream cycles, unreachable
    // nodes, persisted nodeType vs. resolved spec mismatches, required input
    // slots with no binding, and dead/non-ancestor state references
    // (#K6,#K7,#K8,#K14). Same compile-failure pathway as TOPOLOGY_NO_ENTRY /
    // IF_MISSING_BRANCH below — the engine's run() catch treats any thrown
    // Error here as a FAILED compile, no new error class needed. The consumer
    // `validate` hook above runs as *additional* validation, not a replacement.
    const issues = validateGraph(graph, specByNodeId);
    if (issues.length > 0) {
      throw new Error(
        `Pipeline graph validation failed (${String(issues.length)}): ` +
          issues.map((i) => `[${i.code}] ${i.message}`).join('; ')
      );
    }

    // Build the node map runners reference, reusing the same construction
    // `validateGraph` uses internally for ancestor checks (DRY) — pass the
    // already-computed `topo` so it isn't recomputed a second time here.
    const nodeMap: Map<string, CompiledNode> = toCompiledNodeMap(graph, specByNodeId, topo);

    const stateGraph = new StateGraph(PipelineStateAnnotation);
    const runnerDeps: NodeRunnerDeps = {
      bindingResolver: this.deps.bindingResolver,
      stepRecorder: this.deps.stepRecorder,
      llmFactory: this.deps.llmFactory,
      logger: this.deps.logger,
      autoParamResolver: this.deps.autoParamResolver,
      nodeMap,
    };

    for (const wfNode of graph.nodes) {
      const compiledNode = nodeMap.get(wfNode.id);
      if (!compiledNode) {
        throw new Error(`[PipelineCompiler] missing resolved node for "${wfNode.id}"`);
      }
      const runner = makeNodeRunner(wfNode, compiledNode.spec, runnerDeps);
      // Fan-in barrier: in-degree >= 2 nodes are deferred so they run once, after
      // all reachable parents complete (asymmetric fan-in would otherwise double-run).
      // `defer` also skips an unreached IF branch without deadlock.
      const isFanIn = compiledNode.predecessors.length >= 2;
      stateGraph.addNode(
        wfNode.id as never,
        runner as never,
        isFanIn ? { defer: true } : undefined
      );
    }

    const ifBranches: Record<string, { true?: string; false?: string }> = {};
    for (const wfEdge of graph.edges) {
      const fromNode = nodeMap.get(wfEdge.fromNodeId);
      if (fromNode?.node.nodeType === 'IF') {
        const branches = (ifBranches[wfEdge.fromNodeId] ??= {});
        const label = wfEdge.label;
        if (label === 'true' || label === 'false') {
          branches[label] = wfEdge.toNodeId;
        }
      } else {
        stateGraph.addEdge(wfEdge.fromNodeId as never, wfEdge.toNodeId as never);
      }
    }

    for (const [ifId, branches] of Object.entries(ifBranches)) {
      if (!branches.true || !branches.false) {
        const ifNodeKey = nodeMap.get(ifId)?.node.key ?? ifId;
        throw new PipelineCompileError(
          [
            {
              scope: 'node',
              kind: 'IF_MISSING_BRANCH',
              nodeId: ifId,
              nodeKey: ifNodeKey,
              message: `IF node "${ifId}" is missing a true/false branch`,
            },
          ],
          graph.pipeline.name
        );
      }
      const trueTarget = branches.true;
      const falseTarget = branches.false;
      stateGraph.addConditionalEdges(
        ifId as never,
        (state: { outputs?: Record<string, { branch?: string }> }) => {
          const output = state.outputs?.[ifId];
          if (!output || output.branch === undefined) {
            throw new Error(`IF router: branch field missing in outputs for node "${ifId}"`);
          }
          return output.branch as 'true' | 'false';
        },
        { true: trueTarget as never, false: falseTarget as never }
      );
    }

    for (const entryId of entryNodeIds) stateGraph.addEdge(START, entryId as never);
    for (const exitId of exitNodeIds) stateGraph.addEdge(exitId as never, END);

    const app = stateGraph.compile();

    const compiled: CompiledPipeline = {
      pipelineId: graph.pipeline.id,
      pipelineName: graph.pipeline.name,
      app: app as unknown as CompiledPipeline['app'],
      entryNodeIds,
      exitNodeIds,
      nodeMap,
    };

    if (!hasMcpNode) {
      this.cache.unshift({ cacheKey, compiled });
      if (this.cache.length > this.CAPACITY) this.cache.pop();
    }

    return compiled;
  }
}
