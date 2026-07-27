import {
  ZERO_COST,
  NOOP_LOGGER,
  RUN_DELIVERY_MODE,
  PipelineAbortedError,
  PipelineNodeExecutionError,
  PipelineCostCapError,
  createCostGuard,
  safeJson,
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
  /** Hard per-run wall-clock timeout. Default 600_000ms. Pass `0` to disable it entirely. */
  runTimeoutMs?: number;
  /**
   * Optional per-run USD spend cap, checked at node boundaries (after each
   * node's SUCCESS step finishes) — not a mid-handler preemption, so the node
   * that crosses the cap has already billed (#K9). Default `undefined` =
   * unlimited. A conservative starting point for most single-user pipelines
   * is 1–5 USD/run; tune to your nodes' actual LLM cost.
   */
  costCapUsd?: number;
  /**
   * Max LangGraph super-steps per run before it throws `GraphRecursionError`
   * (surfaced as a FAILED run with `error.code: 'RECURSION_LIMIT'`). Default
   * `100`, matching LangGraph's compiled-graph default.
   */
  recursionLimit?: number;
}

export interface RunOptions {
  pipelineId: string;
  deliveryMode?: RunDeliveryMode;
  triggerSource?: string;
  context?: RunContext;
  /** External abort signal; linked to the internal controller. */
  signal?: AbortSignal;
  /**
   * Registered *before* `execute()` starts (synchronously, inside `run()`),
   * so it structurally cannot miss the run's first events — no subscribe gap
   * between `run()` resolving and a caller separately calling `onEvent()`
   * (#S11b). Prefer this over the standalone `onEvent()` method when you need
   * every event from the very start of the run.
   */
  onEvent?: PipelineEventListener;
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
 * Pure classification of a run-ending error into the `{kind, code}` pair
 * persisted on the run and returned to the caller. Extracted out of
 * `execute()`'s catch block (rather than left inline) specifically so this
 * logic is unit-testable in isolation — the real race it exists to prevent
 * (a `costGuard.check()`/`GraphRecursionError` trip landing in the same
 * super-step as a wall-clock timeout or `engine.abort(runId)`) only
 * reproduces through the full LangGraph stack inside an extremely narrow,
 * LangGraph-internals-dependent microtask window (confirmed empirically —
 * not a window a test can pin without coupling to undocumented library
 * internals), so the fix is verified directly against its own inputs (#I1).
 *
 * `aborted` always wins: `isRecursion`/`isCostCap` are gated on `!aborted`
 * so a self-contradictory pair like `{kind:'ABORTED', code:'COST_CAP'}` can
 * never be produced, regardless of what the underlying node/graph error was.
 */
export function classifyRunFailure(
  err: unknown,
  aborted: boolean
): { kind: 'ABORTED' | 'COST_CAP' | 'RUNTIME'; code: string } {
  // GraphRecursionError is LangGraph's own class; matched by name (not
  // `instanceof`) to avoid an import-time coupling on its exact export
  // shape — `name` is the stable, documented signal (#K2/#25).
  const isRecursion = !aborted && err instanceof Error && err.name === 'GraphRecursionError';
  const isCostCap =
    !aborted &&
    (err instanceof PipelineCostCapError ||
      (err instanceof PipelineNodeExecutionError && err.pipelineError.kind === 'COST_CAP'));
  const kind = aborted ? 'ABORTED' : isCostCap ? 'COST_CAP' : 'RUNTIME';
  const code = isRecursion ? 'RECURSION_LIMIT' : isCostCap ? 'COST_CAP' : 'RUN';
  return { kind, code };
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
  private readonly costCapUsd?: number;
  private readonly recursionLimit: number;
  private readonly catalogLoader?: CatalogLoader;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<PipelineEventListener>>();

  constructor(private readonly options: PipelineEngineOptions) {
    this.store = options.store;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.runTimeoutMs = options.runTimeoutMs ?? 600_000; // 0 = disabled, see execute()
    this.costCapUsd = options.costCapUsd;
    this.recursionLimit = options.recursionLimit ?? 100;
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

  /**
   * Abort an in-flight run by id. Returns `true` if the run was in flight (and
   * is now being aborted), `false` if the runId is unknown or already
   * finished — honest signal for callers (e.g. an HTTP abort route) that need
   * to distinguish "aborted" from "nothing to abort" (#S11d).
   */
  abort(runId: string): boolean {
    const controller = this.inFlight.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** Whether a run is currently in flight (started, not yet finished). */
  isInFlight(runId: string): boolean {
    return this.inFlight.has(runId);
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
    // Named handler (not an inline closure) so it can be un-registered again
    // on the happy path below — an inline `() => {}` passed to
    // addEventListener can never be removed because nothing keeps a reference
    // to it. `{ once: true }` only self-removes if 'abort' actually fires; a
    // run that completes normally never fires it, so without an explicit
    // `removeEventListener` the listener leaks for the lifetime of the
    // external signal (#K4).
    let externalAbortHandler: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else {
        externalAbortHandler = () => {
          controller.abort();
        };
        opts.signal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }

    // Register onEvent *before* execute() starts (still synchronous here) so
    // the run's very first emitted event structurally cannot be missed — no
    // subscribe gap (#S11b). Any listener added later via `onEvent()` shares
    // the same underlying Set and can still miss earlier events.
    if (opts.onEvent) {
      let set = this.listeners.get(runId);
      if (!set) {
        set = new Set();
        this.listeners.set(runId, set);
      }
      set.add(opts.onEvent);
    }

    const done = this.execute(graph, runId, deliveryMode, opts.context, controller).finally(() => {
      if (externalAbortHandler) opts.signal?.removeEventListener('abort', externalAbortHandler);
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
    // `runTimeoutMs: 0` disables the wall-clock timeout entirely — the timer
    // is simply never armed. (Previously `0 ?? 600_000` still evaluated to
    // `0` since `??` only falls through on null/undefined, so a caller
    // passing `0` got an immediate `setTimeout(abort, 0)` instead of "no
    // timeout" (#E1).)
    const timer =
      this.runTimeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
          }, this.runTimeoutMs)
        : undefined;

    // Per-run cost guard, created fresh here (never baked into the compiler's
    // cached deps — see node-runner.ts's NodeRunnerConfig doc) and flowed
    // through streamEvents' `configurable`, the same channel as the per-run
    // AbortSignal.
    const costGuard = createCostGuard(this.costCapUsd);

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

      // Passed per-call (not stashed as shared mutable state on the compiler)
      // so concurrent runs never leak each other's userId/tenantId/catalog (#E5).
      const resolveCtx = {
        userId: context?.userId,
        tenantId: context?.tenantId,
        mcpCatalogCache,
      };

      const compiled = await this.compiler.compile(graph, resolveCtx);

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
        configurable: { signal: controller.signal, costGuard },
        recursionLimit: this.recursionLimit,
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
      if (!final) {
        this.logger.warn(
          `[PipelineEngine] run ${runId}: no top-level final state captured — completing SUCCESS with empty outputs`
        );
      }

      await this.store.completeRun(runId, {
        status: 'SUCCESS',
        output: safeJson(outputs),
        cost,
        lastState: safeJson(final),
      });
      this.emit(runId, { kind: 'RUN_COMPLETE', status: 'SUCCESS' });
      return { runId, status: 'SUCCESS', outputs, cost };
    } catch (err) {
      const aborted = err instanceof PipelineAbortedError || controller.signal.aborted;
      const status: RunStatus = aborted ? 'ABORTED' : 'FAILED';
      // I1 — `kind`/`code` must never disagree with `aborted`: see
      // classifyRunFailure's own doc for why this is gated there, not here.
      const { kind, code } = classifyRunFailure(err, aborted);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[PipelineEngine] run ${status}: ${message}`);

      // E2 — `done` must never reject because the store failed on the way out
      // (crash-recovery finalize + terminal write are individually guarded).
      try {
        await this.store.finalizeStaleSteps(runId);
      } catch (storeErr) {
        this.logger.error(
          `[PipelineEngine] finalizeStaleSteps failed for ${runId}: ${String(storeErr)}`
        );
      }
      try {
        await this.store.completeRun(runId, {
          status,
          error: { kind, code, message },
        });
      } catch (storeErr) {
        this.logger.error(`[PipelineEngine] completeRun failed for ${runId}: ${String(storeErr)}`);
      }
      this.emit(runId, { kind: 'RUN_COMPLETE', status });
      return {
        runId,
        status,
        outputs: {},
        cost: ZERO_COST,
        error: { kind, message },
      };
    } finally {
      if (timer) clearTimeout(timer);
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
