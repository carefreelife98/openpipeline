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
  type NodeLifecycleEvent,
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
 *
 * #6 — scans EVERY error in `underlyingErrors(err)` (a native `AggregateError`
 * from a same-superstep multi-node failure yields more than one candidate),
 * so a COST_CAP/RECURSION_LIMIT buried alongside another node's plain
 * failure in the same `AggregateError` is still classified correctly instead
 * of silently falling through to generic RUNTIME/RUN.
 */
export function classifyRunFailure(
  err: unknown,
  aborted: boolean
): { kind: 'ABORTED' | 'COST_CAP' | 'RUNTIME'; code: string } {
  const candidates = underlyingErrors(err);
  // GraphRecursionError is LangGraph's own class; matched by name (not
  // `instanceof`) to avoid an import-time coupling on its exact export
  // shape — `name` is the stable, documented signal (#K2/#25).
  const isRecursion =
    !aborted && candidates.some((e) => e instanceof Error && e.name === 'GraphRecursionError');
  const isCostCap =
    !aborted &&
    candidates.some(
      (e) =>
        e instanceof PipelineCostCapError ||
        (e instanceof PipelineNodeExecutionError && e.pipelineError.kind === 'COST_CAP')
    );
  const kind = aborted ? 'ABORTED' : isCostCap ? 'COST_CAP' : 'RUNTIME';
  const code = isRecursion ? 'RECURSION_LIMIT' : isCostCap ? 'COST_CAP' : 'RUN';
  return { kind, code };
}

/**
 * LangGraph 1.4.4 throws a native `AggregateError` (not a single error)
 * instead of the first failure alone when TWO OR MORE nodes fail in the SAME
 * superstep before the first failure is consumed — `pregel/runner.js`'s
 * `nodeErrors.size > 1` branch, confirmed directly in the installed LangGraph
 * source. Both `classifyRunFailure` and `nodeFailureEvent` need to look
 * inside `.errors` instead of assuming a single underlying error, or a
 * concurrent-failure fan-out silently loses everything past the first error
 * (#6/#K15 fan-out gap). A non-`AggregateError` is treated as its own
 * one-element list so the single-error path is unchanged.
 */
function underlyingErrors(err: unknown): unknown[] {
  return err instanceof AggregateError ? err.errors : [err];
}

/**
 * Pure construction of the NODE_FAILED/NODE_ABORTED event(s) to emit for a
 * run-ending error — extracted out of `execute()`'s catch block for the same
 * reason as `classifyRunFailure` right above it: reproducing
 * `aborted === true` together with a `PipelineNodeExecutionError` reaching
 * `execute()`'s catch through the full LangGraph stack is not reliable to
 * pin in a test. Empirically, once an abort signal actually fires, LangGraph's
 * own signal handling on `streamEvents` wins the race against node-runner's
 * wrapped error every time — the error `execute()` observes is a generic
 * "operation was aborted" rejection, not the `PipelineNodeExecutionError`
 * node-runner independently constructs. So this is verified directly against
 * its own inputs instead (#K15).
 *
 * `PipelineNodeExecutionError` is the only run-ending error carrying a
 * `nodeId` (thrown by node-runner.ts, wrapping both handler failures and a
 * `checkAbort()` trip inside a node) — the only case a NODE_FAILED/
 * NODE_ABORTED event can be attributed to a specific node. Any other error
 * (graph compile failure, `GraphRecursionError`, a bare `PipelineCostCapError`,
 * an abort that never reached a running node, ...) contributes no
 * node-lifecycle event — `RUN_COMPLETE` alone still reports the terminal
 * status. Returns an ARRAY (#6): a native `AggregateError` (see
 * `underlyingErrors` above) can wrap MULTIPLE `PipelineNodeExecutionError`s —
 * every one of them gets its own NODE_FAILED/NODE_ABORTED event, not just the
 * first.
 */
export function nodeFailureEvent(err: unknown, aborted: boolean): NodeLifecycleEvent[] {
  const events: NodeLifecycleEvent[] = [];
  for (const candidate of underlyingErrors(err)) {
    if (candidate instanceof PipelineNodeExecutionError) {
      events.push({ kind: aborted ? 'NODE_ABORTED' : 'NODE_FAILED', nodeId: candidate.nodeId });
    }
  }
  return events;
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
   *
   * A run that is not in flight (unknown id, or already finished) can never
   * fire `listener` — there is no execute() left to emit into it. Without
   * this check, calling `onEvent` on such a run would still allocate a Set in
   * `listeners` and register the listener into it, and nothing would ever
   * remove that Set again (the removal path lives in `run()`'s `.finally()`,
   * which already ran for this runId) — a permanent per-runId leak for every
   * late/mistaken subscribe (#K16). Guarded here instead of by trusting every
   * caller: `handlers.streamRun` in @openpipeline/server already checks
   * `isInFlight` before subscribing, so this only ever fires for a genuinely
   * late subscriber reaching the engine directly.
   */
  onEvent(runId: string, listener: PipelineEventListener): () => void {
    if (!this.inFlight.has(runId)) {
      this.logger.warn(
        `[PipelineEngine] onEvent(${runId}): run is not in flight — listener will never fire`
      );
      return () => {};
    }
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

      // #4 — the SUCCESS terminal write is guarded individually (mirroring
      // the FAILED path's already-guarded `completeRun`/`finalizeStaleSteps`
      // calls in the catch block below, #E2). Without this, a store failure
      // on the way OUT of an otherwise-successful run (including `safeJson`
      // itself throwing) falls through to the outer `catch`, which
      // reclassifies a run that genuinely succeeded as FAILED — discarding
      // the real `outputs`/`cost` in favor of `{}`/`ZERO_COST` and emitting a
      // RUN_COMPLETE the node graph never actually produced.
      try {
        // #5 — `completeRun` is `Promise<boolean>` (first-terminal-wins,
        // contracts.ts): `false` means some other writer (a racing
        // `completeRun`, or an external sweeper) already moved this run to a
        // terminal state first. This run still succeeded from the engine's
        // own point of view — SUCCESS is still emitted/returned below — but
        // the persisted row may now disagree with that; surfaced as an
        // explicit warning (never silently assumed consistent) rather than a
        // discarded return value.
        const completed = await this.store.completeRun(runId, {
          status: 'SUCCESS',
          output: safeJson(outputs),
          cost,
          lastState: safeJson(final),
        });
        if (!completed) {
          this.logger.warn(
            `[PipelineEngine] run ${runId}: completeRun(SUCCESS) lost the terminal-write race — ` +
              `the persisted row's status may not match the RUN_COMPLETE/SUCCESS being emitted now`
          );
        }
      } catch (persistErr) {
        this.logger.error(
          `[PipelineEngine] completeRun(SUCCESS) failed for ${runId}: ${String(persistErr)}`
        );
      }
      this.emit(runId, { kind: 'RUN_COMPLETE', status: 'SUCCESS' });
      return { runId, status: 'SUCCESS', outputs, cost };
    } catch (err) {
      const aborted = err instanceof PipelineAbortedError || controller.signal.aborted;
      // #7 — a run-ending failure (a node throwing, or a COST_CAP/
      // RECURSION_LIMIT trip) must cancel any STILL-RUNNING sibling branches
      // too, not just this run's own bookkeeping below. `controller.signal`
      // is exactly what flows into `streamEvents`' `configurable.signal` —
      // the same AbortSignal node-runner's `checkAbort()` polls and handlers
      // receive as `ctx.signal` to cancel in-flight LLM calls — so without
      // this, a sibling branch's already-started LLM call keeps running (and
      // billing) to completion even after the run itself has failed,
      // defeating `costCapUsd`'s purpose. Computed AFTER `aborted` is
      // captured (never before) so calling it here can never flip a
      // RUNTIME/COST_CAP classification into ABORTED — a no-op if the run was
      // already aborted.
      controller.abort();
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
        // #5 — see the SUCCESS-path comment above: consume the boolean and
        // warn (don't silently drop it) when this run lost the terminal-write
        // race too.
        const completed = await this.store.completeRun(runId, {
          status,
          error: { kind, code, message },
        });
        if (!completed) {
          this.logger.warn(
            `[PipelineEngine] run ${runId}: completeRun(${status}) lost the terminal-write race — ` +
              `the persisted row's status may not match the RUN_COMPLETE/${status} being emitted now`
          );
        }
      } catch (storeErr) {
        this.logger.error(`[PipelineEngine] completeRun failed for ${runId}: ${String(storeErr)}`);
      }
      // K15/#6 — a node failure/abort must not silently "evaporate" for a
      // live subscriber: translateEvent only ever emits NODE_START/NODE_END
      // (from LangGraph's own on_chain_start/on_chain_end), so a node that
      // throws never gets an on_chain_end and no NODE_END is emitted for it
      // either. See nodeFailureEvent's own doc for why this is delegated to a
      // pure, separately-tested helper (now returning an ARRAY — a native
      // `AggregateError` from >=2 nodes failing in the same superstep can
      // carry more than one attributable node failure) rather than inlined
      // here.
      const nodeEvents = nodeFailureEvent(err, aborted);
      for (const nodeEvent of nodeEvents) this.emit(runId, nodeEvent);
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
