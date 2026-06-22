import type { PipelineEngine } from '@openpipeline/runtime';
import type { PipelineDraft, RunContext, PipelineEvent } from '@openpipeline/core';

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
   * resolves when the run finishes. Use this from an SSE endpoint.
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
  /** Abort an in-flight run. */
  abortRun(runId: string): void;
}

export function createPipelineHandlers(engine: PipelineEngine): PipelineHandlers {
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
      const { runId, done } = await engine.run(params);
      const unsubscribe = engine.onEvent(runId, onEvent);
      try {
        const result = await done;
        return { runId, status: result.status };
      } finally {
        unsubscribe();
      }
    },

    async runPipeline(params) {
      const { runId, done } = await engine.run(params);
      const result = await done;
      return { runId, status: result.status };
    },

    abortRun(runId) {
      engine.abort(runId);
    },
  };
}
