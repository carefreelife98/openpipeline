import {
  ZERO_COST,
  NOOP_LOGGER,
  RUN_DELIVERY_MODE,
  WorkflowAbortedError,
  type WorkflowStore,
  type StepRecorder,
  type LlmFactory,
  type CatalogLoader,
  type McpNodeResolver,
  type Logger,
  type RunContext,
  type RunDeliveryMode,
  type RunStatus,
  type WorkflowDraft,
  type RunSummary,
  type WorkflowStateType,
  type WorkflowOutputs,
  type CostBundle,
  type CatalogResult,
  type WorkflowWithGraph,
  type NodeSpec,
  type WorkflowEvent,
  type WorkflowEventListener,
} from '@openworkflow/core';
import {
  NodeSpecRegistry,
  ValueBindingResolver,
  WorkflowCompiler,
  translateEvent,
  type AutoParamResolver,
  type LangGraphStreamEvent,
} from '@openworkflow/nodes';

export interface WorkflowEngineOptions {
  store: WorkflowStore & StepRecorder;
  llmFactory: LlmFactory;
  logger?: Logger;
  /** Optional — required only for graphs with `auto`-bound slots. */
  autoParamResolver?: AutoParamResolver;
  /** Optional — required only for graphs with `mcp:` nodes. */
  catalogLoader?: CatalogLoader;
  /** Optional — resolves `mcp:` node keys to specs. Provide with catalogLoader. */
  mcpNodeResolver?: McpNodeResolver;
  /** Optional graph validator run before compilation. Throw to reject. */
  validate?: (graph: WorkflowWithGraph, ctx: { userId?: string; tenantId?: string }) => Promise<void> | void;
  /** Hard per-run wall-clock timeout. Default 600_000ms. */
  runTimeoutMs?: number;
}

export interface RunOptions {
  workflowId: string;
  deliveryMode?: RunDeliveryMode;
  triggerSource?: string;
  context?: RunContext;
  /** External abort signal; linked to the internal controller. */
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  outputs: WorkflowOutputs;
  cost: CostBundle;
  error?: { kind: string; message: string };
}

export interface RunHandle {
  runId: string;
  done: Promise<RunResult>;
}

/**
 * Orchestrates a workflow run end to end over the kernel. A plain class that
 * takes the interface bag — no NestJS, no Prisma, no lifecycle hooks. Rewritten
 * (not extracted) from Mate-X's WorkflowRunnerService, preserving: per-run MCP
 * catalog load + cleanup, abort propagation, and stale-step finalization.
 */
export class WorkflowEngine {
  private readonly registry: NodeSpecRegistry;
  private readonly compiler: WorkflowCompiler;
  private readonly store: WorkflowStore & StepRecorder;
  private readonly logger: Logger;
  private readonly runTimeoutMs: number;
  private readonly catalogLoader?: CatalogLoader;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<WorkflowEventListener>>();

  constructor(private readonly options: WorkflowEngineOptions) {
    this.store = options.store;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.runTimeoutMs = options.runTimeoutMs ?? 600_000;
    this.catalogLoader = options.catalogLoader;
    this.registry = new NodeSpecRegistry(options.mcpNodeResolver);
    this.compiler = new WorkflowCompiler({
      registry: this.registry,
      bindingResolver: new ValueBindingResolver(this.logger),
      stepRecorder: this.store,
      llmFactory: options.llmFactory,
      logger: this.logger,
      autoParamResolver: options.autoParamResolver,
      validate: options.validate,
    });
  }

  /** Register a node spec (built-in or custom). Chainable. */
  registerNode(spec: NodeSpec): this {
    this.registry.register(spec);
    return this;
  }

  /** Persist a workflow draft; returns its id. */
  save(draft: WorkflowDraft): Promise<string> {
    return this.store.save(draft);
  }

  /** Load a workflow graph (workflow + nodes + edges). */
  load(workflowId: string): Promise<WorkflowWithGraph> {
    return this.store.load(workflowId);
  }

  listRuns(workflowId: string, opts?: { limit?: number }): Promise<RunSummary[]> {
    return this.store.listRuns(workflowId, opts);
  }

  /** Abort an in-flight run by id. No-op if the run is unknown or finished. */
  abort(runId: string): void {
    this.inFlight.get(runId)?.abort();
  }

  /**
   * Subscribe to live events for a run (NODE_START/END/FAILED, LLM_CHUNK,
   * RUN_COMPLETE). Returns an unsubscribe function. Subscribe before the run's
   * `done` resolves to catch all events; events are fire-and-forget (no replay).
   */
  onEvent(runId: string, listener: WorkflowEventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      this.listeners.get(runId)?.delete(listener);
    };
  }

  private emit(runId: string, event: WorkflowEvent): void {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // a listener throwing must not break the run
      }
    }
  }

  /**
   * Start a run. Returns immediately with the runId and a `done` promise that
   * settles when the run finishes (success / failure / abort). Both
   * fire-and-forget (INVOKE) and await-the-result usage are supported.
   */
  async run(opts: RunOptions): Promise<RunHandle> {
    const graph = await this.store.load(opts.workflowId);
    const deliveryMode = opts.deliveryMode ?? RUN_DELIVERY_MODE.INVOKE;

    const { runId } = await this.store.createRun({
      workflowId: opts.workflowId,
      userId: opts.context?.userId,
      deliveryMode,
      triggerSource: opts.triggerSource ?? 'MANUAL',
      input: {},
    });

    const controller = new AbortController();
    this.inFlight.set(runId, controller);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const done = this.execute(graph, runId, deliveryMode, opts.context, controller).finally(() => {
      this.inFlight.delete(runId);
      // Defer listener cleanup a tick so any synchronous post-`done` reads land.
      queueMicrotask(() => this.listeners.delete(runId));
    });

    return { runId, done };
  }

  private async execute(
    graph: Awaited<ReturnType<WorkflowStore['load']>>,
    runId: string,
    deliveryMode: RunDeliveryMode,
    context: RunContext | undefined,
    controller: AbortController,
  ): Promise<RunResult> {
    const hasMcpNode = graph.nodes.some((n) => n.key.startsWith('mcp:'));
    let mcpCatalog: CatalogResult | undefined;
    const timer = setTimeout(() => controller.abort(), this.runTimeoutMs);

    try {
      if (hasMcpNode) {
        if (!this.catalogLoader) {
          throw new Error('Graph has MCP nodes but no catalogLoader was configured.');
        }
        mcpCatalog = await this.catalogLoader.load({ userId: context?.userId, tenantId: context?.tenantId });
      }

      const mcpCatalogCache = mcpCatalog?.providers as readonly unknown[] | undefined;

      this.compiler.setResolveContext({
        userId: context?.userId,
        tenantId: context?.tenantId,
        mcpCatalogCache,
      });

      const compiled = await this.compiler.compile(graph);

      const initialState: WorkflowStateType = {
        meta: {
          runId,
          workflowId: graph.workflow.id,
          workflowName: graph.workflow.name ?? '',
          workflowDescription: graph.workflow.description ?? '',
          deliveryMode,
          context,
          mcpCatalogCache,
        },
        outputs: {},
        nodeMeta: {},
        cost: ZERO_COST,
        events: [],
      };

      const knownNodeIds = new Set(graph.nodes.map((n) => n.id));

      // streamEvents drives live per-node events; we accumulate the final state
      // from the top-level on_chain_end so we still get outputs + cost.
      let final: WorkflowStateType | undefined;
      const stream = compiled.app.streamEvents(initialState, {
        version: 'v2',
        configurable: { signal: controller.signal },
        recursionLimit: 100,
        signal: controller.signal,
      });

      for await (const raw of stream) {
        const evt = raw as LangGraphStreamEvent & { data?: { output?: unknown } };
        const translated = translateEvent(evt, knownNodeIds);
        if (translated) this.emit(runId, translated);
        // Capture the top-level graph output (no langgraph_node metadata).
        if (evt.event === 'on_chain_end' && !evt.metadata?.langgraph_node) {
          const out = (evt.data as { output?: WorkflowStateType })?.output;
          if (out && typeof out === 'object' && 'outputs' in out) final = out;
        }
      }

      const outputs = final?.outputs ?? {};
      const cost = final?.cost ?? ZERO_COST;

      await this.store.completeRun(runId, { status: 'SUCCESS', output: outputs, cost, lastState: final });
      this.emit(runId, { kind: 'RUN_COMPLETE', status: 'SUCCESS' });
      return { runId, status: 'SUCCESS', outputs, cost };
    } catch (err) {
      const aborted = err instanceof WorkflowAbortedError || controller.signal.aborted;
      const status: RunStatus = aborted ? 'ABORTED' : 'FAILED';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[WorkflowEngine] run ${status}: ${message}`);

      await this.store.finalizeStaleSteps(runId);
      await this.store.completeRun(runId, {
        status,
        error: { kind: aborted ? 'ABORTED' : 'RUNTIME', code: 'RUN', message },
      });
      this.emit(runId, { kind: 'RUN_COMPLETE', status });
      return {
        runId,
        status,
        outputs: {},
        cost: ZERO_COST,
        error: { kind: aborted ? 'ABORTED' : 'RUNTIME', message },
      };
    } finally {
      clearTimeout(timer);
      if (mcpCatalog) {
        try {
          await mcpCatalog.cleanup();
        } catch (cleanupErr) {
          this.logger.warn('[WorkflowEngine] MCP catalog cleanup failed', { cleanupErr });
        }
      }
    }
  }
}

export type {
  WorkflowStore,
  StepRecorder,
  LlmFactory,
  CatalogLoader,
  RunContext,
  WorkflowEvent,
  WorkflowEventListener,
} from '@openworkflow/core';
