import {
  PipelineNotFoundError,
  mergeCost,
  type PipelineStore,
  type StepRecorder,
  type PipelineWithGraph,
  type PipelineDraft,
  type RunCreate,
  type RunComplete,
  type RunSummary,
  type StepStart,
  type StepFinish,
  type PipelineRow,
  type PipelineNodeRow,
  type PipelineEdgeRow,
  type CostBundle,
  type RunStatus,
  type RunStepStatus,
} from '@openpipeline/core';

interface StoredRun {
  id: string;
  pipelineId: string;
  userId?: string;
  status: RunStatus;
  cost: CostBundle;
  input?: unknown;
  output?: unknown;
  startedAt: Date;
  finishedAt?: Date;
}

interface StoredStep {
  id: string;
  runId: string;
  nodeId: string;
  nodeLabel: string;
  parentStepId?: string;
  sequenceIndex: number;
  status: RunStepStatus;
  input?: unknown;
  output?: unknown;
  cost?: CostBundle;
  startedAt: Date;
  finishedAt?: Date;
}

let counter = 0;
function genId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}_${Math.floor(performance.now()).toString(36)}`;
}

/**
 * In-memory reference implementation of PipelineStore + StepRecorder. Makes
 * "install + run a pipeline" work with zero database. Proves the persistence
 * interfaces are real.
 *
 * Step sequencing is guarded by a promise-chain mutex: LangGraph fan-in can call
 * `start()` concurrently, and `sequenceIndex` must be assigned atomically or
 * parallel branches collide on sequence numbers.
 */
export class MemoryStore implements PipelineStore, StepRecorder {
  private readonly pipelines = new Map<string, PipelineRow>();
  private readonly nodes = new Map<string, PipelineNodeRow[]>();
  private readonly edges = new Map<string, PipelineEdgeRow[]>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly steps = new Map<string, StoredStep>();

  // Mutex: serialize sequenceIndex assignment, one lock per run (not one
  // global lock across every run) — a global lock meant `start()`/
  // `startChild()` calls for an unrelated run B queued behind run A's chain
  // for no reason, and it also never shrinks: nothing ever removed a run's
  // place in a single shared promise chain (S5). Keyed by runId so each
  // run's serialization is independent, and cleaned up in `completeRun`
  // alongside `seqByRun` once the run reaches a terminal state.
  private readonly seqLocks = new Map<string, Promise<unknown>>();
  private readonly seqByRun = new Map<string, number>();

  // ── PipelineStore ─────────────────────────────────────────────────────────

  load(pipelineId: string): Promise<PipelineWithGraph> {
    const pipeline = this.pipelines.get(pipelineId);
    if (!pipeline) throw new PipelineNotFoundError(pipelineId);
    return Promise.resolve({
      pipeline,
      nodes: this.nodes.get(pipelineId) ?? [],
      edges: this.edges.get(pipelineId) ?? [],
    });
  }

  save(draft: PipelineDraft): Promise<string> {
    const id = draft.id ?? genId('wf');
    const existing = this.pipelines.get(id);
    // S3 — monotonic updatedAt: two saves landing in the same wall-clock
    // millisecond (real, on a fast machine or coarse OS clock resolution;
    // deterministic under frozen/fake timers) must still produce a strictly
    // later updatedAt than the previous save. A naive `new Date()` here would
    // let a same-millisecond re-save keep the old updatedAt, so a cache keyed
    // on it would wrongly treat the change as a stale hit.
    const now = new Date(Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1));
    const pipeline: PipelineRow = {
      id,
      name: draft.name,
      description: draft.description,
      // Attribution is sticky: an update that omits userId keeps the existing
      // value instead of clobbering it (see PipelineDraft.userId).
      userId: draft.userId !== undefined ? draft.userId : existing?.userId,
      outputJsonSchema: draft.outputJsonSchema,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.pipelines.set(id, pipeline);
    this.nodes.set(
      id,
      draft.nodes.map((n) => ({ ...n, pipelineId: id }))
    );
    this.edges.set(
      id,
      draft.edges.map((e) => ({ ...e, pipelineId: id }))
    );
    return Promise.resolve(id);
  }

  createRun(run: RunCreate): Promise<{ runId: string; startedAt: Date }> {
    const runId = genId('run');
    const startedAt = new Date();
    this.runs.set(runId, {
      id: runId,
      pipelineId: run.pipelineId,
      userId: run.userId,
      status: 'RUNNING',
      cost: { tokens: { input: 0, output: 0, total: 0 }, dollars: 0, llmCalls: 0 },
      input: run.input,
      startedAt,
    });
    this.seqByRun.set(runId, 0);
    return Promise.resolve({ runId, startedAt });
  }

  completeRun(runId: string, result: RunComplete): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'RUNNING') return Promise.resolve(false);
    run.status = result.status;
    run.output = result.output;
    run.finishedAt = new Date();
    if (result.cost) run.cost = mergeCost(run.cost, result.cost);
    // S5 — clear both this run's sequence counter and its lock chain so a
    // finished run leaves nothing behind in either map. Only reached once,
    // guarded by the `status !== 'RUNNING'` check above (first-terminal-
    // wins), so this is inherently idempotent — a second completeRun on the
    // same run returns `false` before ever reaching here.
    this.seqByRun.delete(runId);
    this.seqLocks.delete(runId);
    return Promise.resolve(true);
  }

  updateRunCostAtomic(runId: string, delta: CostBundle): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve();
    run.cost = mergeCost(run.cost, delta);
    return Promise.resolve();
  }

  listRuns(pipelineId: string, opts?: { limit?: number }): Promise<RunSummary[]> {
    const all = Array.from(this.runs.values())
      .filter((r) => r.pipelineId === pipelineId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const limited = opts?.limit ? all.slice(0, opts.limit) : all;
    return Promise.resolve(
      limited.map((r) => ({
        id: r.id,
        pipelineId: r.pipelineId,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        cost: r.cost,
      }))
    );
  }

  // ── StepRecorder ──────────────────────────────────────────────────────────

  async start(step: StepStart): Promise<string> {
    const seq = await this.nextSeq(step.runId);
    const id = genId('step');
    this.steps.set(id, {
      id,
      runId: step.runId,
      nodeId: step.nodeId,
      nodeLabel: step.nodeLabel,
      sequenceIndex: seq,
      status: 'RUNNING',
      startedAt: new Date(),
    });
    return id;
  }

  finish(stepId: string, result: StepFinish): Promise<void> {
    const step = this.steps.get(stepId);
    if (!step) return Promise.resolve();
    step.status = result.status;
    step.input = result.input;
    step.output = result.output;
    step.cost = result.cost;
    step.finishedAt = new Date();
    return Promise.resolve();
  }

  async startChild(params: {
    runId: string;
    parentStepId: string;
    nodeId: string;
    input: unknown;
  }): Promise<string> {
    const seq = await this.nextSeq(params.runId);
    const id = genId('step');
    this.steps.set(id, {
      id,
      runId: params.runId,
      nodeId: params.nodeId,
      nodeLabel: params.nodeId,
      parentStepId: params.parentStepId,
      sequenceIndex: seq,
      status: 'RUNNING',
      input: params.input,
      startedAt: new Date(),
    });
    return id;
  }

  async finishChild(childStepId: string, result: StepFinish): Promise<void> {
    return this.finish(childStepId, result);
  }

  finalizeStaleSteps(runId: string): Promise<void> {
    for (const step of this.steps.values()) {
      if (step.runId === runId && step.status === 'RUNNING') {
        step.status = 'FAILED';
        step.finishedAt = new Date();
      }
    }
    return Promise.resolve();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Atomically assign the next sequence index for a run (fan-in safe, per-run). */
  private nextSeq(runId: string): Promise<number> {
    const prev = this.seqLocks.get(runId) ?? Promise.resolve();
    const next = prev.then(() => {
      const current = this.seqByRun.get(runId) ?? 0;
      this.seqByRun.set(runId, current + 1);
      return current;
    });
    // Keep this run's chain alive even if a caller's continuation rejects.
    this.seqLocks.set(
      runId,
      next.catch(() => undefined)
    );
    return next;
  }

  // ── Test/inspection helpers ─────────────────────────────────────────────────

  getSteps(
    runId: string
  ): ReadonlyArray<{ nodeLabel: string; status: RunStepStatus; sequenceIndex: number }> {
    return Array.from(this.steps.values())
      .filter((s) => s.runId === runId)
      .sort((a, b) => a.sequenceIndex - b.sequenceIndex)
      .map((s) => ({ nodeLabel: s.nodeLabel, status: s.status, sequenceIndex: s.sequenceIndex }));
  }
}
