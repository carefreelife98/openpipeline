import { StateGraph, START, END } from '@langchain/langgraph';
import {
  WorkflowStateAnnotation,
  analyzeTopology,
  WorkflowCompileError,
  type WorkflowWithGraph,
  type CompiledNode,
} from '@openworkflow/core';
import { NodeSpecRegistry, type NodeResolveContext } from './registry.js';
import { makeNodeRunner, type NodeRunnerDeps } from './node-runner.js';

/** Deps the caller supplies; `nodeMap` is filled internally by the compiler. */
export type CompilerDeps = Omit<NodeRunnerDeps, 'nodeMap'> & {
  registry: NodeSpecRegistry;
  /** Optional graph validator. Throw or return errors to reject compilation. */
  validate?: (graph: WorkflowWithGraph, ctx: NodeResolveContext) => Promise<void> | void;
  resolveContext?: NodeResolveContext;
};

export interface CompiledWorkflow {
  workflowId: string;
  workflowName: string;
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
  compiled: CompiledWorkflow;
}

/**
 * Compiles a workflow graph into a runnable LangGraph StateGraph. De-@Injectable
 * from the Mate-X original: a plain class. Preserves the LRU cache, the fan-in
 * `defer` semantics, and the MCP-node cache-bypass policy verbatim.
 */
export class WorkflowCompiler {
  private readonly cache: CacheEntry[] = [];
  private readonly CAPACITY = 10;

  private resolveContext: NodeResolveContext;

  constructor(private readonly deps: CompilerDeps) {
    this.resolveContext = deps.resolveContext ?? {};
  }

  /** Set the per-run resolve context (userId/tenantId/mcpCatalogCache) before compiling. */
  setResolveContext(ctx: NodeResolveContext): void {
    this.resolveContext = ctx;
  }

  async compile(graph: WorkflowWithGraph): Promise<CompiledWorkflow> {
    const ctx: NodeResolveContext = this.resolveContext;

    // MCP-node graphs bypass the cache: an MCP spec depends on user/provider
    // state, so a cache hit could serve a stale spec.
    const hasMcpNode = graph.nodes.some((n) => n.key.startsWith('mcp:'));
    const cacheKey = `${graph.workflow.id}:${new Date(graph.workflow.updatedAt).getTime()}`;

    if (!hasMcpNode) {
      const idx = this.cache.findIndex((e) => e.cacheKey === cacheKey);
      if (idx !== -1) {
        const [entry] = this.cache.splice(idx, 1);
        this.cache.unshift(entry!);
        return entry!.compiled;
      }
    }

    if (this.deps.validate) {
      await this.deps.validate(graph, ctx);
    }

    const topo = analyzeTopology(graph.nodes, graph.edges);
    if (topo.entryNodes.length < 1 || topo.exitNodes.length < 1) {
      throw new WorkflowCompileError(
        [{ scope: 'graph', kind: 'TOPOLOGY_NO_ENTRY', message: 'Expected at least one entry and one exit node' }],
        graph.workflow.name,
      );
    }

    const entryNodeIds = topo.entryNodes.map((n) => n.id);
    const exitNodeIds = topo.exitNodes.map((n) => n.id);

    // Build the node map first (resolve all specs in parallel) so runners can
    // reference the complete map. MCP nodes resolve via the registry's resolver.
    const nodeMap = new Map<string, CompiledNode>();
    const resolved = await Promise.all(
      graph.nodes.map(async (wfNode) => ({ wfNode, spec: await this.deps.registry.get(wfNode.key, ctx) })),
    );
    for (const { wfNode, spec } of resolved) {
      nodeMap.set(wfNode.id, {
        node: wfNode,
        spec,
        predecessors: topo.predecessorsByNode.get(wfNode.id) ?? [],
        successors: topo.successorsByNode.get(wfNode.id) ?? [],
      });
    }

    const stateGraph = new StateGraph(WorkflowStateAnnotation);
    const runnerDeps: NodeRunnerDeps = {
      bindingResolver: this.deps.bindingResolver,
      stepRecorder: this.deps.stepRecorder,
      llmFactory: this.deps.llmFactory,
      logger: this.deps.logger,
      autoParamResolver: this.deps.autoParamResolver,
      nodeMap,
    };

    for (const wfNode of graph.nodes) {
      const compiledNode = nodeMap.get(wfNode.id)!;
      const runner = makeNodeRunner(wfNode, compiledNode.spec, runnerDeps);
      // Fan-in barrier: in-degree >= 2 nodes are deferred so they run once, after
      // all reachable parents complete (asymmetric fan-in would otherwise double-run).
      // `defer` also skips an unreached IF branch without deadlock.
      const isFanIn = compiledNode.predecessors.length >= 2;
      stateGraph.addNode(wfNode.id as never, runner as never, isFanIn ? { defer: true } : undefined);
    }

    const ifBranches: Record<string, { true?: string; false?: string }> = {};
    for (const wfEdge of graph.edges) {
      const fromNode = nodeMap.get(wfEdge.fromNodeId);
      if (fromNode?.node.nodeType === 'IF') {
        ifBranches[wfEdge.fromNodeId] ??= {};
        const label = wfEdge.label;
        if (label === 'true' || label === 'false') {
          ifBranches[wfEdge.fromNodeId]![label] = wfEdge.toNodeId;
        }
      } else {
        stateGraph.addEdge(wfEdge.fromNodeId as never, wfEdge.toNodeId as never);
      }
    }

    for (const [ifId, branches] of Object.entries(ifBranches)) {
      if (!branches.true || !branches.false) {
        const ifNodeKey = nodeMap.get(ifId)?.node.key ?? ifId;
        throw new WorkflowCompileError(
          [
            {
              scope: 'node',
              kind: 'IF_MISSING_BRANCH',
              nodeId: ifId,
              nodeKey: ifNodeKey,
              message: `IF node "${ifId}" is missing a true/false branch`,
            },
          ],
          graph.workflow.name,
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
        { true: trueTarget as never, false: falseTarget as never },
      );
    }

    for (const entryId of entryNodeIds) stateGraph.addEdge(START, entryId as never);
    for (const exitId of exitNodeIds) stateGraph.addEdge(exitId as never, END);

    const app = stateGraph.compile();

    const compiled: CompiledWorkflow = {
      workflowId: graph.workflow.id,
      workflowName: graph.workflow.name,
      app: app as unknown as CompiledWorkflow['app'],
      entryNodeIds,
      exitNodeIds,
      nodeMap: nodeMap as ReadonlyMap<string, CompiledNode>,
    };

    if (!hasMcpNode) {
      this.cache.unshift({ cacheKey, compiled });
      if (this.cache.length > this.CAPACITY) this.cache.pop();
    }

    return compiled;
  }
}
