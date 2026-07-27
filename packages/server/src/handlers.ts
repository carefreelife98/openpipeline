import type {
  PipelineDraft,
  RunContext,
  PipelineEvent,
  PipelineEventListener,
  PipelineWithGraph,
  RunSummary,
} from '@openpipeline/core';
import type { RunHandle, RunOptions } from '@openpipeline/runtime';

/**
 * The slice of `PipelineEngine` these handlers depend on — small enough to
 * stub in tests without wiring a full engine (store + LangGraph + LLM
 * factory). The real `PipelineEngine` class satisfies this structurally.
 */
export interface EnginePort {
  save(draft: PipelineDraft): Promise<string>;
  load(pipelineId: string): Promise<PipelineWithGraph>;
  listRuns(pipelineId: string, opts?: { limit?: number }): Promise<RunSummary[]>;
  run(opts: RunOptions): Promise<RunHandle>;
  /** `true` if the run was in flight (now aborting); `false` for unknown/finished runs. */
  abort(runId: string): boolean;
  isInFlight(runId: string): boolean;
  onEvent(runId: string, listener: PipelineEventListener): () => void;
}

/**
 * Transport-agnostic pipeline handlers. These are plain async functions with no
 * dependency on Express/Fastify/Node http — wire them into any framework, or use
 * the bundled Node http adapter (`createNodeHttpHandler`).
 */
export interface PipelineHandlers {
  /** Persist a pipeline draft. Returns its id. */
  savePipeline(draft: PipelineDraft): Promise<{ pipelineId: string }>;
  /** Load a pipeline graph. */
  getPipeline(pipelineId: string): Promise<unknown>;
  /** List recent runs for a pipeline. */
  listRuns(pipelineId: string, opts?: { limit?: number }): Promise<unknown>;
  /**
   * Start a run and stream its live events. Calls `onEvent` for each event and
   * resolves when the run finishes. `onEvent` is registered via `RunOptions`
   * before the run's execution starts — no subscribe gap (#S11b). Use this
   * from an SSE endpoint that itself starts the run.
   */
  runAndStream(
    params: { pipelineId: string; context?: RunContext },
    onEvent: (event: PipelineEvent) => void
  ): Promise<{ runId: string; status: string }>;
  /** Start a run without streaming; resolves with the final result. */
  runPipeline(params: {
    pipelineId: string;
    context?: RunContext;
  }): Promise<{ runId: string; status: string }>;
  /**
   * Start a run WITHOUT subscribing to its events — resolves as soon as the
   * run has genuinely started (pipeline loaded, run row created, execution
   * kicked off), unlike `runAndStream`/`runPipeline`, which don't resolve
   * until the run finishes. This is what lets a caller validate `pipelineId`
   * BEFORE committing to a response — a missing/nonexistent pipeline rejects
   * HERE, not after headers are already sent (#8). Pair with
   * `streamRun(runId, onEvent, opts)` right after to attach and stream.
   */
  startRun(params: { pipelineId: string; context?: RunContext }): Promise<{ runId: string }>;
  /**
   * Attach to an already-running (in-flight) run's live events. Resolves
   * `{ found: true }` once `RUN_COMPLETE` fires (or `opts.signal` aborts —
   * #9), having unsubscribed itself either way. Resolves immediately with
   * `{ found: false }` — without subscribing — for an unknown or
   * already-finished run, so callers (e.g. an HTTP route) can 404 instead of
   * hanging or silently replaying a run that never happened (#S11a/#E1).
   *
   * `opts.signal` (#9): without a way to cancel the subscription, a client
   * that disconnects mid-stream leaves its listener registered in the
   * engine's per-run `Set` (and the HTTP handler's SSE frame alive) until the
   * run naturally reaches `RUN_COMPLETE` — up to the run's full timeout
   * (default 10 minutes) — so a client that reconnects repeatedly (e.g. a
   * browser `EventSource`'s automatic ~3s retry) accumulates one dead
   * listener per reconnect. Pass an `AbortSignal` tied to the transport's
   * disconnect event to unsubscribe and resolve promptly instead.
   */
  streamRun(
    runId: string,
    onEvent: (event: PipelineEvent) => void,
    opts?: { signal?: AbortSignal }
  ): Promise<{ found: boolean }>;
  /**
   * Whether a run is currently in flight. A synchronous, side-effect-free
   * read — the gate an HTTP route checks *before* writing response headers,
   * so a 404 for an unknown/finished run is always sent with headers still
   * unsent (never a body-less 200 followed by an empty stream).
   */
  isInFlight(runId: string): boolean;
  /** Abort an in-flight run. Returns `false` for an unknown/finished run (#S11d). */
  abortRun(runId: string): boolean;
}

export function createPipelineHandlers(engine: EnginePort): PipelineHandlers {
  return {
    async savePipeline(draft) {
      const pipelineId = await engine.save(draft);
      return { pipelineId };
    },

    getPipeline(pipelineId) {
      return engine.load(pipelineId);
    },

    listRuns(pipelineId, opts) {
      return engine.listRuns(pipelineId, opts);
    },

    async runAndStream(params, onEvent) {
      const { runId, done } = await engine.run({ ...params, onEvent });
      const result = await done;
      return { runId, status: result.status };
    },

    async runPipeline(params) {
      const { runId, done } = await engine.run(params);
      const result = await done;
      return { runId, status: result.status };
    },

    async startRun(params) {
      const { runId } = await engine.run(params);
      return { runId };
    },

    isInFlight(runId) {
      return engine.isInFlight(runId);
    },

    async streamRun(runId, onEvent, opts) {
      if (!engine.isInFlight(runId)) return { found: false };
      await new Promise<void>((resolve) => {
        // #9 — `unsubscribe` must exist before `onAbort` can reference it:
        // declared first (assigned immediately below, still synchronously,
        // before `opts.signal` is ever consulted) so an ALREADY-aborted
        // signal can call `onAbort()` right away without a TDZ error.
        let unsubscribe: () => void = () => {};
        const onAbort = (): void => {
          unsubscribe();
          resolve();
        };
        unsubscribe = engine.onEvent(runId, (event) => {
          onEvent(event);
          if (event.kind === 'RUN_COMPLETE') {
            opts?.signal?.removeEventListener('abort', onAbort);
            unsubscribe();
            resolve();
          }
        });
        if (opts?.signal) {
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      return { found: true };
    },

    abortRun(runId) {
      return engine.abort(runId);
    },
  };
}
