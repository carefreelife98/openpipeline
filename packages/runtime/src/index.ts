import {
  ZERO_COST,
  NOOP_LOGGER,
  RUN_DELIVERY_MODE,
  PipelineAbortedError,
  type PipelineStore,
  type StepRecorder,
  type LlmFactory,
  type CatalogLoader,
  type McpNodeResolver,
  type Logger,
  type RunContext,
  type RunDeliveryMode,
  type RunStatus,
  type PipelineDraft,
  type RunSummary,
  type PipelineMeta,
  type NodeMetaMap,
  type NodeEvent,
  type PipelineOutputs,
  type CostBundle,
  type CatalogResult,
  type PipelineWithGraph,
  type NodeSpec,
  type PipelineNodeOutput,
  type PipelineEvent,
  type PipelineEventListener,
} from '@openpipeline/core';
import {
  NodeSpecRegistry,
  ValueBindingResolver,
  PipelineCompiler,
  translateEvent,
  type AutoParamResolver,
  type LangGraphStreamEvent,
} from '@openpipeline/nodes';

/**
 * Concrete shape of the LangGraph run state. Core exports `PipelineStateType`
 * as `any` on purpose — it is `typeof PipelineStateAnnotation.State`, and the
 * annotation is typed `any` to keep LangGraph's internal generics off the
 * public `.d.ts` surface. That shield is correct at the package boundary, but
 * inside the engine we know the exact shape (it mirrors the annotation in
 * core/state.ts), so we reconstruct it from the concrete building-block types
 * core does export. This gives us real type-safety for state reads/writes
 * without weakening anything to `any`.
 */
interface PipelineState {
  meta: PipelineMeta;
  outputs: PipelineOutputs;
  nodeMeta: NodeMetaMap;
  cost: CostBundle;
  events: NodeEvent[];
}

/**
 * Extract the top-level graph state from a LangGraph `on_chain_end` event's
 * `data.output` (typed `unknown` upstream). Validates the discriminating
 * `outputs` field is present before treating the payload as a `PipelineState`,
 * so the narrowing is a real runtime guard rather than a blind cast. Declared
 * once as the single typed access point into the langgraph `unknown` payload.
 */
function readFinalState(output: unknown): PipelineState | undefined {
  if (output !== null && typeof output === 'object' && 'outputs' in output) {
    return output as PipelineState;
  }
  return undefined;
}

export interface PipelineEngineOptions {
  store: PipelineStore & StepRecorder;
  llmFactory: LlmFactory;
  logger?: Logger;
  /** Optional — required only for graphs with `auto`-bound slots. */
  autoParamResolver?: AutoParamResolver;
  /** Optional — required only for graphs with `mcp:` nodes. */
  catalogLoader?: CatalogLoader;
  /** Optional — resolves `mcp:` node keys to specs. Provide with catalogLoader. */
  mcpNodeResolver?: McpNodeResolver;
  /** Optional graph validator run before compilation. Throw to reject. */
  validate?: (
    graph: PipelineWithGraph,
    ctx: { userId?: string; tenantId?: string }
  ) => Promise<void> | void;
  /** Hard per-run wall-clock timeout. Default 600_000ms. */
  runTimeoutMs?: number;
}

export interface RunOptions {
  pipelineId: string;
  deliveryMode?: RunDeliveryMode;
  triggerSource?: string;
  context?: RunContext;
  /** External abort signal; linked to the internal controller. */
  signal?: AbortSignal;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  outputs: PipelineOutputs;
  cost: CostBundle;
  error?: { kind: string; message: string };
}

export interface RunHandle {
  runId: string;
  done: Promise<RunResult>;
}

/**
 * Orchestrates a pipeline run end to end over the kernel. A plain class that
 * takes the interface bag — no NestJS, no Prisma, no lifecycle hooks. Rewritten
 * (not extracted) from Mate-X's PipelineRunnerService, preserving: per-run MCP
 * catalog load + cleanup, abort propagation, and stale-step finalization.
 */
export class PipelineEngine {
  private readonly registry: NodeSpecRegistry;
  private readonly compiler: PipelineCompiler;
  private readonly store: PipelineStore & StepRecorder;
  private readonly logger: Logger;
  private readonly runTimeoutMs: number;
  private readonly catalogLoader?: CatalogLoader;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<PipelineEventListener>>();

  constructor(private readonly options: PipelineEngineOptions) {
    this.store = options.store;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.runTimeoutMs = options.runTimeoutMs ?? 600_000;
    this.catalogLoader = options.catalogLoader;
    this.registry = new NodeSpecRegistry(options.mcpNodeResolver);
    this.compiler = new PipelineCompiler({
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
  registerNode<TInput, TOutput extends PipelineNodeOutput>(spec: NodeSpec<TInput, TOutput>): this {
    this.registry.register(spec);
    return this;
  }

  /** Persist a pipeline draft; returns its id. */
  save(draft: PipelineDraft): Promise<string> {
    return this.store.save(draft);
  }

  /** Load a pipeline graph (pipeline + nodes + edges). */
  load(pipelineId: string): Promise<PipelineWithGraph> {
    return this.store.load(pipelineId);
  }

  listRuns(pipelineId: string, opts?: { limit?: number }): Promise<RunSummary[]> {
    return this.store.listRuns(pipelineId, opts);
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
  onEvent(runId: string, listener: PipelineEventListener): () => void {
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

  private emit(runId: string, event: PipelineEvent): void {
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
    const graph = await this.store.load(opts.pipelineId);
    const deliveryMode = opts.deliveryMode ?? RUN_DELIVERY_MODE.INVOKE;

    const { runId } = await this.store.createRun({
      pipelineId: opts.pipelineId,
      userId: opts.context?.userId,
      deliveryMode,
      triggerSource: opts.triggerSource ?? 'MANUAL',
      input: {},
    });

    const controller = new AbortController();
    this.inFlight.set(runId, controller);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else
        opts.signal.addEventListener(
          'abort',
          () => {
            controller.abort();
          },
          { once: true }
        );
    }

    const done = this.execute(graph, runId, deliveryMode, opts.context, controller).finally(() => {
      this.inFlight.delete(runId);
      // Defer listener cleanup a tick so any synchronous post-`done` reads land.
      queueMicrotask(() => this.listeners.delete(runId));
    });

    return { runId, done };
  }

  private async execute(
    graph: Awaited<ReturnType<PipelineStore['load']>>,
    runId: string,
    deliveryMode: RunDeliveryMode,
    context: RunContext | undefined,
    controller: AbortController
  ): Promise<RunResult> {
    const hasMcpNode = graph.nodes.some((n) => n.key.startsWith('mcp:'));
    let mcpCatalog: CatalogResult | undefined;
    const timer = setTimeout(() => {
      controller.abort();
    }, this.runTimeoutMs);

    try {
      if (hasMcpNode) {
        if (!this.catalogLoader) {
          throw new Error('Graph has MCP nodes but no catalogLoader was configured.');
        }
        mcpCatalog = await this.catalogLoader.load({
          userId: context?.userId,
          tenantId: context?.tenantId,
        });
      }

      const mcpCatalogCache = mcpCatalog?.providers as readonly unknown[] | undefined;

      this.compiler.setResolveContext({
        userId: context?.userId,
        tenantId: context?.tenantId,
        mcpCatalogCache,
      });

      const compiled = await this.compiler.compile(graph);

      const initialState: PipelineState = {
        meta: {
          runId,
          pipelineId: graph.pipeline.id,
          pipelineName: graph.pipeline.name,
          pipelineDescription: graph.pipeline.description ?? '',
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
      let final: PipelineState | undefined;
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
          final = readFinalState(evt.data?.output) ?? final;
        }
      }

      const outputs = final?.outputs ?? {};
      const cost = final?.cost ?? ZERO_COST;

      await this.store.completeRun(runId, {
        status: 'SUCCESS',
        output: outputs,
        cost,
        lastState: final,
      });
      this.emit(runId, { kind: 'RUN_COMPLETE', status: 'SUCCESS' });
      return { runId, status: 'SUCCESS', outputs, cost };
    } catch (err) {
      const aborted = err instanceof PipelineAbortedError || controller.signal.aborted;
      const status: RunStatus = aborted ? 'ABORTED' : 'FAILED';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[PipelineEngine] run ${status}: ${message}`);

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
          this.logger.warn('[PipelineEngine] MCP catalog cleanup failed', { cleanupErr });
        }
      }
    }
  }
}

export type {
  PipelineStore,
  StepRecorder,
  LlmFactory,
  CatalogLoader,
  RunContext,
  PipelineEvent,
  PipelineEventListener,
} from '@openpipeline/core';
