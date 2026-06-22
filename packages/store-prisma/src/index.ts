import {
  ZERO_COST,
  mergeCost,
  type WorkflowStore,
  type StepRecorder,
  type WorkflowWithGraph,
  type WorkflowDraft,
  type RunCreate,
  type RunComplete,
  type RunSummary,
  type StepStart,
  type StepFinish,
  type WorkflowRow,
  type WorkflowNodeRow,
  type WorkflowEdgeRow,
  type CostBundle,
  type RunStatus,
} from '@openworkflow/core';
import type { PrismaClientLike } from './prisma-types.js';

export type { PrismaClientLike } from './prisma-types.js';

/**
 * Postgres-backed WorkflowStore + StepRecorder (Prisma). Faithful port of the
 * Mate-X repositories with all multi-tenancy removed:
 *   - the atomic cost JSONB update (raw SQL, race-free)
 *   - the fan-in-safe step sequencing (findFirst desc -> create, serialized)
 *   - the diff-based save (update/create/soft-delete nodes, recreate edges)
 *
 * Pass a PrismaClient generated from this package's `prisma/schema.prisma`.
 */
export class PrismaWorkflowStore implements WorkflowStore, StepRecorder {
  // Per-run mutex so concurrent fan-in `start()` calls don't race on sequenceIndex.
  private readonly startQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly prisma: PrismaClientLike) {}

  // ── WorkflowStore ─────────────────────────────────────────────────────────

  async load(workflowId: string): Promise<WorkflowWithGraph> {
    const wf = (await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      include: { nodes: { where: { isDeleted: false } }, edges: true },
    })) as (Record<string, unknown> & { nodes: unknown[]; edges: unknown[] }) | null;
    if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

    const { nodes, edges, ...row } = wf;
    return {
      workflow: row as unknown as WorkflowRow,
      nodes: (nodes as WorkflowNodeRow[]).map((n) => ({ ...n, inputs: n.inputs ?? {} })),
      edges: edges as WorkflowEdgeRow[],
    };
  }

  async save(draft: WorkflowDraft): Promise<string> {
    if (draft.id) return this.updateWorkflow(draft.id, draft);
    return this.createWorkflow(draft);
  }

  private async createWorkflow(draft: WorkflowDraft): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.create({
        data: {
          name: draft.name,
          description: draft.description ?? null,
          outputJsonSchema: (draft.outputJsonSchema ?? null) as never,
        },
      });
      const workflowId = workflow.id;

      if (draft.nodes.length > 0) {
        await tx.workflowNode.createMany({
          data: draft.nodes.map((n) => ({
            id: n.id,
            workflowId,
            nodeType: n.nodeType,
            key: n.key,
            label: n.label,
            inputs: n.inputs as never,
            positionX: n.positionX ?? null,
            positionY: n.positionY ?? null,
          })),
        });
      }
      if (draft.edges.length > 0) {
        await tx.workflowEdge.createMany({
          data: draft.edges.map((e) => ({
            id: e.id,
            workflowId,
            fromNodeId: e.fromNodeId,
            toNodeId: e.toNodeId,
            label: e.label ?? null,
          })),
        });
      }
      return workflowId;
    });
  }

  /** Diff update — no data loss. Update/create draft nodes, soft-delete missing ones, recreate edges. */
  private async updateWorkflow(id: string, draft: WorkflowDraft): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.workflow.update({
        where: { id },
        data: {
          name: draft.name,
          description: draft.description ?? null,
          outputJsonSchema: (draft.outputJsonSchema ?? null) as never,
        },
      });

      await tx.workflowEdge.deleteMany({ where: { workflowId: id } });

      const existing = (await tx.workflowNode.findMany({
        where: { workflowId: id },
        select: { id: true, isDeleted: true },
      })) as Array<{ id: string; isDeleted: boolean }>;
      const existingIds = new Set(existing.map((n) => n.id));
      const draftIds = new Set(draft.nodes.map((n) => n.id));

      const toSoftDelete = existing.filter((n) => !draftIds.has(n.id) && !n.isDeleted).map((n) => n.id);
      if (toSoftDelete.length > 0) {
        await tx.workflowNode.updateMany({
          where: { id: { in: toSoftDelete } },
          data: { isDeleted: true, deletedAt: new Date() },
        });
      }

      for (const n of draft.nodes) {
        const nodeData = {
          workflowId: id,
          nodeType: n.nodeType,
          key: n.key,
          label: n.label,
          inputs: n.inputs as never,
          positionX: n.positionX ?? null,
          positionY: n.positionY ?? null,
          isDeleted: false,
          deletedAt: null,
        };
        if (existingIds.has(n.id)) {
          await tx.workflowNode.update({ where: { id: n.id }, data: nodeData });
        } else {
          await tx.workflowNode.create({ data: { id: n.id, ...nodeData } });
        }
      }

      if (draft.edges.length > 0) {
        await tx.workflowEdge.createMany({
          data: draft.edges.map((e) => ({
            workflowId: id,
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
    const row = await this.prisma.workflowRun.create({
      data: {
        workflowId: run.workflowId,
        userId: run.userId ?? null,
        deliveryMode: run.deliveryMode,
        triggerSource: run.triggerSource ?? 'MANUAL',
        input: (run.input ?? {}) as never,
        status: 'RUNNING',
        cost: ZERO_COST as never,
      },
    });
    return { runId: row.id, startedAt: (row.startedAt as Date) ?? new Date() };
  }

  async completeRun(runId: string, result: RunComplete): Promise<void> {
    const isFailure = result.status === 'FAILED' || result.status === 'ABORTED';
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: result.status,
        finishedAt: new Date(),
        ...(result.status === 'SUCCESS' && result.output !== undefined
          ? { output: result.output as never }
          : {}),
        ...(isFailure
          ? { error: (result.error ?? null) as never, lastState: (result.lastState ?? null) as never }
          : {}),
        ...(result.cost ? { cost: result.cost as never } : {}),
      },
    });
  }

  /** Atomic cost increment via parameterized raw SQL — race-free read-modify-write. */
  async updateRunCostAtomic(runId: string, delta: CostBundle): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE workflow_run
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
      runId,
    );
  }

  async listRuns(workflowId: string, opts?: { limit?: number }): Promise<RunSummary[]> {
    const rows = (await this.prisma.workflowRun.findMany({
      where: { workflowId },
      orderBy: { startedAt: 'desc' },
      ...(opts?.limit ? { take: opts.limit } : {}),
      select: { id: true, workflowId: true, status: true, startedAt: true, finishedAt: true, cost: true },
    })) as Array<{
      id: string;
      workflowId: string;
      status: RunStatus;
      startedAt: Date;
      finishedAt: Date | null;
      cost: unknown;
    }>;
    return rows.map((r) => ({
      id: r.id,
      workflowId: r.workflowId,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? undefined,
      cost: (r.cost as CostBundle) ?? mergeCost(undefined, undefined),
    }));
  }

  // ── StepRecorder ──────────────────────────────────────────────────────────

  async start(step: StepStart): Promise<string> {
    return this.serializeByRun(step.runId, () => this.startInternal(step));
  }

  private async startInternal(step: StepStart, parentStepId?: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const last = (await tx.workflowRunStep.findFirst({
        where: { runId: step.runId },
        orderBy: { sequenceIndex: 'desc' },
        select: { sequenceIndex: true },
      })) as { sequenceIndex: number } | null;
      const nextIndex = (last?.sequenceIndex ?? -1) + 1;

      const created = await tx.workflowRunStep.create({
        data: {
          runId: step.runId,
          nodeId: step.nodeId,
          nodeLabel: step.nodeLabel ?? null,
          parentStepId: parentStepId ?? null,
          status: 'RUNNING',
          sequenceIndex: nextIndex,
          input: {} as never,
          cost: ZERO_COST as never,
        },
      });
      return created.id;
    });
  }

  async finish(stepId: string, result: StepFinish): Promise<void> {
    await this.prisma.workflowRunStep.update({
      where: { id: stepId },
      data: {
        status: result.status,
        input: (result.input ?? undefined) as never,
        output: (result.output ?? null) as never,
        error: (result.error ?? null) as never,
        cost: (result.cost ?? ZERO_COST) as never,
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
      this.startInternal({ runId: params.runId, nodeId: params.nodeId, nodeLabel: params.nodeId }, params.parentStepId),
    );
  }

  async finishChild(childStepId: string, result: StepFinish): Promise<void> {
    return this.finish(childStepId, result);
  }

  async finalizeStaleSteps(runId: string): Promise<void> {
    await this.prisma.workflowRunStep.updateMany({
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
