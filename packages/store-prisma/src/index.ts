import {
  ZERO_COST,
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
  type NodeType,
  type RunStatus,
  type NodeInputs,
} from '@openpipeline/core';

import type { PrismaClientLike } from './prisma-types.js';

export type { PrismaClientLike } from './prisma-types.js';

// ── DB row shapes ─────────────────────────────────────────────────────────────
// The concrete column shapes returned by the Prisma delegates, matching
// prisma/schema.prisma. JSON columns surface as `unknown` (arbitrary JSON);
// each read declares exactly the projection it requests so results are fully
// typed without `as`-casts at the access sites.

interface DbPipelineNode {
  id: string;
  pipelineId: string;
  nodeType: NodeType;
  key: string;
  label: string;
  inputs: unknown;
  positionX: number | null;
  positionY: number | null;
}

interface DbPipelineEdge {
  id: string;
  pipelineId: string;
  fromNodeId: string;
  toNodeId: string;
  label: string | null;
}

interface DbPipelineWithGraph {
  id: string;
  name: string;
  description: string | null;
  outputJsonSchema: unknown;
  createdAt: Date;
  updatedAt: Date;
  nodes: DbPipelineNode[];
  edges: DbPipelineEdge[];
}

/**
 * Postgres-backed PipelineStore + StepRecorder (Prisma). Faithful port of the
 * Mate-X repositories with all multi-tenancy removed:
 *   - the atomic cost JSONB update (raw SQL, race-free)
 *   - the fan-in-safe step sequencing (findFirst desc -> create, serialized)
 *   - the diff-based save (update/create/soft-delete nodes, recreate edges)
 *
 * Pass a PrismaClient generated from this package's `prisma/schema.prisma`.
 */
export class PrismaPipelineStore implements PipelineStore, StepRecorder {
  // Per-run mutex so concurrent fan-in `start()` calls don't race on sequenceIndex.
  private readonly startQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly prisma: PrismaClientLike) {}

  // ── PipelineStore ─────────────────────────────────────────────────────────

  async load(pipelineId: string): Promise<PipelineWithGraph> {
    const wf = await this.prisma.pipeline.findUnique<DbPipelineWithGraph>({
      where: { id: pipelineId },
      include: { nodes: { where: { isDeleted: false } }, edges: true },
    });
    if (!wf) throw new Error(`Pipeline not found: ${pipelineId}`);

    const { nodes, edges, ...row } = wf;
    const pipeline: PipelineRow = {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      outputJsonSchema: row.outputJsonSchema,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return {
      pipeline,
      nodes: nodes.map<PipelineNodeRow>((n) => ({
        id: n.id,
        pipelineId: n.pipelineId,
        nodeType: n.nodeType,
        key: n.key,
        label: n.label,
        inputs: (n.inputs ?? {}) as NodeInputs,
        positionX: n.positionX ?? undefined,
        positionY: n.positionY ?? undefined,
      })),
      edges: edges.map<PipelineEdgeRow>((e) => ({
        id: e.id,
        pipelineId: e.pipelineId,
        fromNodeId: e.fromNodeId,
        toNodeId: e.toNodeId,
        label: e.label,
      })),
    };
  }

  async save(draft: PipelineDraft): Promise<string> {
    if (draft.id) return this.updatePipeline(draft.id, draft);
    return this.createPipeline(draft);
  }

  /**
   * `pipelineNode.id` is a global primary key in schema.prisma — not scoped
   * per pipeline. A client-supplied node id that already belongs to ANOTHER
   * pipeline collides on that PK; without this guard the collision surfaces
   * only once `create`/`createMany` actually runs, as a bare Prisma P2002
   * unique-constraint violation that gives no hint about *whose* id it is.
   * Checked up front (inside the caller's transaction, via `tx`) so both the
   * create and update paths reject with the same clear, attributable error
   * before ever attempting the write (S4/#10). A no-op when `candidateIds`
   * is empty (no genuinely-new node ids to check).
   */
  private async assertNodeIdsBelongToPipeline(
    tx: PrismaClientLike,
    pipelineId: string,
    candidateIds: string[]
  ): Promise<void> {
    if (candidateIds.length === 0) return;
    const clashes = await tx.pipelineNode.findMany<{ id: string; pipelineId: string }>({
      where: { id: { in: candidateIds } },
      select: { id: true, pipelineId: true },
    });
    const foreign = clashes.filter((c) => c.pipelineId !== pipelineId);
    if (foreign.length > 0) {
      throw new Error(
        `node id(s) ${foreign.map((f) => f.id).join(', ')} belong to another pipeline — ` +
          `client-provided ids must be fresh UUIDs or ids of this pipeline`
      );
    }
  }

  private async createPipeline(draft: PipelineDraft): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const pipeline = await tx.pipeline.create<{ id: string }>({
        data: {
          name: draft.name,
          description: draft.description ?? null,
          outputJsonSchema: draft.outputJsonSchema ?? null,
        },
      });
      const pipelineId = pipeline.id;

      // Every node in a brand-new pipeline is, from this pipeline's own
      // perspective, "new" — check all of them against the global PK.
      await this.assertNodeIdsBelongToPipeline(
        tx,
        pipelineId,
        draft.nodes.map((n) => n.id)
      );

      if (draft.nodes.length > 0) {
        await tx.pipelineNode.createMany({
          data: draft.nodes.map((n) => ({
            id: n.id,
            pipelineId,
            nodeType: n.nodeType,
            key: n.key,
            label: n.label,
            inputs: n.inputs,
            positionX: n.positionX ?? null,
            positionY: n.positionY ?? null,
          })),
        });
      }
      if (draft.edges.length > 0) {
        await tx.pipelineEdge.createMany({
          data: draft.edges.map((e) => ({
            id: e.id,
            pipelineId,
            fromNodeId: e.fromNodeId,
            toNodeId: e.toNodeId,
            label: e.label ?? null,
          })),
        });
      }
      return pipelineId;
    });
  }

  /** Diff update — no data loss. Update/create draft nodes, soft-delete missing ones, recreate edges. */
  private async updatePipeline(id: string, draft: PipelineDraft): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.pipeline.update<{ id: string }>({
        where: { id },
        data: {
          name: draft.name,
          description: draft.description ?? null,
          outputJsonSchema: draft.outputJsonSchema ?? null,
        },
      });

      await tx.pipelineEdge.deleteMany({ where: { pipelineId: id } });

      const existing = await tx.pipelineNode.findMany<{ id: string; isDeleted: boolean }>({
        where: { pipelineId: id },
        select: { id: true, isDeleted: true },
      });
      const existingIds = new Set(existing.map((n) => n.id));
      const draftIds = new Set(draft.nodes.map((n) => n.id));

      // Only ids genuinely new to THIS pipeline can possibly clash with
      // another pipeline's PK — an id already among `existingIds` is this
      // pipeline's own and goes through `update()` below, never `create()`.
      await this.assertNodeIdsBelongToPipeline(
        tx,
        id,
        draft.nodes.map((n) => n.id).filter((nid) => !existingIds.has(nid))
      );

      const toSoftDelete = existing
        .filter((n) => !draftIds.has(n.id) && !n.isDeleted)
        .map((n) => n.id);
      if (toSoftDelete.length > 0) {
        await tx.pipelineNode.updateMany({
          where: { id: { in: toSoftDelete } },
          data: { isDeleted: true, deletedAt: new Date() },
        });
      }

      for (const n of draft.nodes) {
        const nodeData = {
          pipelineId: id,
          nodeType: n.nodeType,
          key: n.key,
          label: n.label,
          inputs: n.inputs,
          positionX: n.positionX ?? null,
          positionY: n.positionY ?? null,
          isDeleted: false,
          deletedAt: null,
        };
        if (existingIds.has(n.id)) {
          await tx.pipelineNode.update({ where: { id: n.id }, data: nodeData });
        } else {
          await tx.pipelineNode.create({ data: { id: n.id, ...nodeData } });
        }
      }

      if (draft.edges.length > 0) {
        await tx.pipelineEdge.createMany({
          data: draft.edges.map((e) => ({
            pipelineId: id,
            fromNodeId: e.fromNodeId,
            toNodeId: e.toNodeId,
            label: e.label ?? null,
          })),
          skipDuplicates: true,
        });
      }
      return id;
    });
  }

  async createRun(run: RunCreate): Promise<{ runId: string; startedAt: Date }> {
    const status: RunStatus = 'RUNNING';
    const row = await this.prisma.pipelineRun.create<{ id: string; startedAt: Date | null }>({
      data: {
        pipelineId: run.pipelineId,
        userId: run.userId ?? null,
        deliveryMode: run.deliveryMode,
        triggerSource: run.triggerSource ?? 'MANUAL',
        input: run.input ?? {},
        status,
        cost: ZERO_COST,
      },
    });
    return { runId: row.id, startedAt: row.startedAt ?? new Date() };
  }

  /**
   * Terminal transition. First-terminal-wins: the `where.status: 'RUNNING'`
   * guard means only the call that observes the run still RUNNING performs the
   * write — a second completeRun (double-complete) is a no-op, so a completed
   * SUCCESS can never be overwritten by a later FAILED (S1/K5).
   */
  async completeRun(runId: string, result: RunComplete): Promise<boolean> {
    const isFailure = result.status === 'FAILED' || result.status === 'ABORTED';
    const res = await this.prisma.pipelineRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status: result.status,
        finishedAt: new Date(),
        ...(result.status === 'SUCCESS' && result.output !== undefined
          ? { output: result.output }
          : {}),
        ...(isFailure ? { error: result.error ?? null, lastState: result.lastState ?? null } : {}),
        ...(result.cost ? { cost: result.cost } : {}),
      },
    });
    return res.count > 0;
  }

  /** Atomic cost increment via parameterized raw SQL — race-free read-modify-write. */
  async updateRunCostAtomic(runId: string, delta: CostBundle): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE pipeline_run
       SET cost = jsonb_build_object(
         'tokens', jsonb_build_object(
           'input',  (cost->'tokens'->>'input')::int  + $1,
           'output', (cost->'tokens'->>'output')::int + $2,
           'total',  (cost->'tokens'->>'total')::int  + $3
         ),
         'dollars',  (cost->>'dollars')::float + $4,
         'llmCalls', (cost->>'llmCalls')::int  + $5
       )
       WHERE id = $6`,
      delta.tokens.input,
      delta.tokens.output,
      delta.tokens.total,
      delta.dollars,
      delta.llmCalls,
      runId
    );
  }

  async listRuns(pipelineId: string, opts?: { limit?: number }): Promise<RunSummary[]> {
    const rows = await this.prisma.pipelineRun.findMany<{
      id: string;
      pipelineId: string;
      status: RunStatus;
      startedAt: Date;
      finishedAt: Date | null;
      cost: unknown;
    }>({
      where: { pipelineId },
      orderBy: { startedAt: 'desc' },
      ...(opts?.limit ? { take: opts.limit } : {}),
      select: {
        id: true,
        pipelineId: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        cost: true,
      },
    });
    return rows.map<RunSummary>((r) => ({
      id: r.id,
      pipelineId: r.pipelineId,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? undefined,
      // `cost` is a non-null JSON column; deserialize the opaque value to its
      // domain type, falling back to a zero bundle if a legacy row stored null.
      cost: (r.cost as CostBundle | null) ?? mergeCost(undefined, undefined),
    }));
  }

  // ── StepRecorder ──────────────────────────────────────────────────────────

  async start(step: StepStart): Promise<string> {
    return this.serializeByRun(step.runId, () => this.startInternal(step));
  }

  private async startInternal(step: StepStart, parentStepId?: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.pipelineRunStep.findFirst<{ sequenceIndex: number }>({
        where: { runId: step.runId },
        orderBy: { sequenceIndex: 'desc' },
        select: { sequenceIndex: true },
      });
      const nextIndex = (last?.sequenceIndex ?? -1) + 1;

      const status: RunStatus = 'RUNNING';
      const created = await tx.pipelineRunStep.create<{ id: string }>({
        data: {
          runId: step.runId,
          nodeId: step.nodeId,
          // StepStart.nodeLabel is a required string per the StepRecorder contract;
          // the DB column is nullable but a value is always supplied here.
          nodeLabel: step.nodeLabel,
          parentStepId: parentStepId ?? null,
          status,
          sequenceIndex: nextIndex,
          input: {},
          cost: ZERO_COST,
        },
      });
      return created.id;
    });
  }

  async finish(stepId: string, result: StepFinish): Promise<void> {
    await this.prisma.pipelineRunStep.update<{ id: string }>({
      where: { id: stepId },
      data: {
        status: result.status,
        input: result.input ?? undefined,
        output: result.output ?? null,
        error: result.error ?? null,
        cost: result.cost ?? ZERO_COST,
        finishedAt: new Date(),
      },
    });
  }

  async startChild(params: {
    runId: string;
    parentStepId: string;
    nodeId: string;
    input: unknown;
  }): Promise<string> {
    return this.serializeByRun(params.runId, () =>
      this.startInternal(
        { runId: params.runId, nodeId: params.nodeId, nodeLabel: params.nodeId },
        params.parentStepId
      )
    );
  }

  async finishChild(childStepId: string, result: StepFinish): Promise<void> {
    return this.finish(childStepId, result);
  }

  async finalizeStaleSteps(runId: string): Promise<void> {
    await this.prisma.pipelineRunStep.updateMany({
      where: { runId, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Serialize an operation behind the per-run queue (sequenceIndex safety). */
  private serializeByRun<T>(runId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.startQueues.get(runId) ?? Promise.resolve();
    const next = previous.then(op, op);
    const tracked = next.finally(() => {
      if (this.startQueues.get(runId) === tracked) this.startQueues.delete(runId);
    });
    this.startQueues.set(runId, tracked);
    return next;
  }
}
