import type { WorkflowEngine } from '@openworkflow/runtime';
import type { WorkflowDraft, RunContext, WorkflowEvent } from '@openworkflow/core';

/**
 * Transport-agnostic workflow handlers. These are plain async functions with no
 * dependency on Express/Fastify/Node http — wire them into any framework, or use
 * the bundled Node http adapter (`createNodeHttpHandler`).
 */
export interface WorkflowHandlers {
  /** Persist a workflow draft. Returns its id. */
  saveWorkflow(draft: WorkflowDraft): Promise<{ workflowId: string }>;
  /** Load a workflow graph. */
  getWorkflow(workflowId: string): Promise<unknown>;
  /** List recent runs for a workflow. */
  listRuns(workflowId: string, opts?: { limit?: number }): Promise<unknown>;
  /**
   * Start a run and stream its live events. Calls `onEvent` for each event and
   * resolves when the run finishes. Use this from an SSE endpoint.
   */
  runAndStream(
    params: { workflowId: string; context?: RunContext },
    onEvent: (event: WorkflowEvent) => void,
  ): Promise<{ runId: string; status: string }>;
  /** Start a run without streaming; resolves with the final result. */
  runWorkflow(params: { workflowId: string; context?: RunContext }): Promise<{ runId: string; status: string }>;
  /** Abort an in-flight run. */
  abortRun(runId: string): void;
}

export function createWorkflowHandlers(engine: WorkflowEngine): WorkflowHandlers {
  return {
    async saveWorkflow(draft) {
      const workflowId = await engine.save(draft);
      return { workflowId };
    },

    getWorkflow(workflowId) {
      return engine.load(workflowId);
    },

    listRuns(workflowId, opts) {
      return engine.listRuns(workflowId, opts);
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

    async runWorkflow(params) {
      const { runId, done } = await engine.run(params);
      const result = await done;
      return { runId, status: result.status };
    },

    abortRun(runId) {
      engine.abort(runId);
    },
  };
}
