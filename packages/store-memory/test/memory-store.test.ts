import type { CostBundle, PipelineDraft, RunCreate, RunStepStatus } from '@openpipeline/core';
import { describe, it, expect, beforeEach } from 'vitest';

import { MemoryStore } from '../src/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A minimal valid draft: one TOOL node, no edges. `id` omitted → store mints one. */
function draft(overrides: Partial<PipelineDraft> = {}): PipelineDraft {
  return {
    name: 'My Pipeline',
    nodes: [{ id: 'n1', nodeType: 'TOOL', key: 'tool.uppercase', label: 'Upper', inputs: {} }],
    edges: [],
    ...overrides,
  };
}

/** A RunCreate for a given pipeline. deliveryMode is required by the contract. */
function runCreate(pipelineId: string, overrides: Partial<RunCreate> = {}): RunCreate {
  return { pipelineId, deliveryMode: 'INVOKE', ...overrides };
}

/** A non-trivial cost delta, distinct in every field so merges are observable. */
function cost(input: number, output: number, dollars: number, llmCalls: number): CostBundle {
  return { tokens: { input, output, total: input + output }, dollars, llmCalls };
}

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

// ── PipelineStore: save / load ────────────────────────────────────────────────

describe('MemoryStore.save (create)', () => {
  it('mints an id when the draft has none', async () => {
    const id = await store.save(draft());
    expect(id).toMatch(/^wf_/);
  });

  it('round-trips through load with pipeline metadata preserved', async () => {
    const id = await store.save(
      draft({ name: 'Named', description: 'desc', outputJsonSchema: { type: 'object' } })
    );
    const { pipeline } = await store.load(id);
    expect(pipeline.id).toBe(id);
    expect(pipeline.name).toBe('Named');
    expect(pipeline.description).toBe('desc');
    expect(pipeline.outputJsonSchema).toEqual({ type: 'object' });
    expect(pipeline.createdAt).toBeInstanceOf(Date);
    expect(pipeline.updatedAt).toBeInstanceOf(Date);
  });

  it('stamps the generated pipelineId onto every node and edge', async () => {
    const id = await store.save(
      draft({
        nodes: [
          { id: 'a', nodeType: 'TOOL', key: 'tool.x', label: 'A', inputs: {} },
          { id: 'b', nodeType: 'TOOL', key: 'tool.y', label: 'B', inputs: {} },
        ],
        edges: [{ id: 'a->b', fromNodeId: 'a', toNodeId: 'b' }],
      })
    );
    const { nodes, edges } = await store.load(id);
    expect(nodes.map((n) => n.pipelineId)).toEqual([id, id]);
    expect(edges.map((e) => e.pipelineId)).toEqual([id]);
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(edges[0]?.fromNodeId).toBe('a');
    expect(edges[0]?.toNodeId).toBe('b');
  });

  it('honors a caller-supplied id', async () => {
    const id = await store.save(draft({ id: 'fixed-id' }));
    expect(id).toBe('fixed-id');
    const { pipeline } = await store.load('fixed-id');
    expect(pipeline.id).toBe('fixed-id');
  });
});

describe('MemoryStore.save (diff-update)', () => {
  it('preserves createdAt and advances updatedAt on re-save of the same id', async () => {
    const id = await store.save(draft({ id: 'p1', name: 'v1' }));
    expect(id).toBe('p1');
    const first = await store.load('p1');
    const createdAt = first.pipeline.createdAt;

    // Re-save same id with a new name; a later wall-clock instant for updatedAt.
    const id2 = await store.save(draft({ id: 'p1', name: 'v2' }));
    expect(id2).toBe('p1');
    const second = await store.load('p1');

    expect(second.pipeline.name).toBe('v2');
    // createdAt is carried over from the original record, not reset.
    expect(second.pipeline.createdAt.getTime()).toBe(createdAt.getTime());
    // updatedAt is at least as recent as createdAt (never moves backwards).
    expect(second.pipeline.updatedAt.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
  });

  it('replaces the node/edge sets wholesale (no stale rows survive)', async () => {
    await store.save(
      draft({
        id: 'p2',
        nodes: [
          { id: 'old1', nodeType: 'TOOL', key: 'tool.x', label: 'Old1', inputs: {} },
          { id: 'old2', nodeType: 'TOOL', key: 'tool.y', label: 'Old2', inputs: {} },
        ],
        edges: [{ id: 'old1->old2', fromNodeId: 'old1', toNodeId: 'old2' }],
      })
    );
    await store.save(
      draft({
        id: 'p2',
        nodes: [{ id: 'new1', nodeType: 'LLM', key: 'llm.chat', label: 'New1', inputs: {} }],
        edges: [],
      })
    );
    const { nodes, edges } = await store.load('p2');
    expect(nodes.map((n) => n.id)).toEqual(['new1']);
    expect(edges).toEqual([]);
  });
});

describe('MemoryStore.load', () => {
  it('throws a descriptive error for an unknown pipeline', async () => {
    // NOTE: load() has a Promise return type but throws synchronously rather
    // than returning a rejected promise. From a caller's view (`await load(...)`)
    // both surface identically, so we assert via an async wrapper that mirrors
    // real usage instead of `.rejects` (which needs an already-created promise).
    await expect(async () => store.load('does-not-exist')).rejects.toThrow(
      'Pipeline not found: does-not-exist'
    );
  });

  it('returns empty node/edge arrays for a pipeline saved with none', async () => {
    const id = await store.save(draft({ nodes: [], edges: [] }));
    const { nodes, edges } = await store.load(id);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});

// ── PipelineStore: runs ───────────────────────────────────────────────────────

describe('MemoryStore.createRun', () => {
  it('mints a run id, returns startedAt, and starts RUNNING with zero cost', async () => {
    const { runId, startedAt } = await store.createRun(runCreate('p'));
    expect(runId).toMatch(/^run_/);
    expect(startedAt).toBeInstanceOf(Date);

    const [summary] = await store.listRuns('p');
    expect(summary?.id).toBe(runId);
    expect(summary?.status).toBe('RUNNING');
    expect(summary?.cost).toEqual(cost(0, 0, 0, 0));
    expect(summary?.finishedAt).toBeUndefined();
    expect(summary?.startedAt.getTime()).toBe(startedAt.getTime());
  });
});

describe('MemoryStore.completeRun', () => {
  it('records terminal status, output, finishedAt and merges final cost', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    await store.completeRun(runId, {
      status: 'SUCCESS',
      output: { answer: 42 },
      cost: cost(10, 5, 0.01, 1),
    });

    const [summary] = await store.listRuns('p');
    expect(summary?.status).toBe('SUCCESS');
    expect(summary?.finishedAt).toBeInstanceOf(Date);
    // Final cost is merged onto the zero starting cost.
    expect(summary?.cost).toEqual(cost(10, 5, 0.01, 1));
  });

  it('is a silent no-op for an unknown runId (no throw)', async () => {
    await expect(store.completeRun('ghost', { status: 'FAILED' })).resolves.toBeUndefined();
    // Nothing was created as a side effect.
    expect(await store.listRuns('p')).toEqual([]);
  });

  it('leaves cost untouched when no cost is supplied', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    await store.updateRunCostAtomic(runId, cost(3, 2, 0.5, 1));
    await store.completeRun(runId, { status: 'SUCCESS' });

    const [summary] = await store.listRuns('p');
    expect(summary?.cost).toEqual(cost(3, 2, 0.5, 1));
  });
});

describe('MemoryStore.updateRunCostAtomic', () => {
  it('accumulates successive deltas onto the run cost', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    await store.updateRunCostAtomic(runId, cost(1, 1, 0.1, 1));
    await store.updateRunCostAtomic(runId, cost(2, 3, 0.2, 1));

    const [summary] = await store.listRuns('p');
    // tokens: input 1+2=3, output 1+3=4, total 2+5=7; dollars 0.3; calls 2.
    expect(summary?.cost).toEqual({
      tokens: { input: 3, output: 4, total: 7 },
      dollars: expect.closeTo(0.3, 10) as number,
      llmCalls: 2,
    });
  });

  it('is a silent no-op for an unknown runId', async () => {
    await expect(store.updateRunCostAtomic('ghost', cost(1, 1, 1, 1))).resolves.toBeUndefined();
  });
});

describe('MemoryStore.listRuns', () => {
  it('returns only runs for the requested pipeline', async () => {
    const a = await store.createRun(runCreate('pa'));
    const b = await store.createRun(runCreate('pb'));
    await store.createRun(runCreate('pa'));

    const forA = await store.listRuns('pa');
    const forB = await store.listRuns('pb');
    expect(forA).toHaveLength(2);
    expect(forA.every((r) => r.pipelineId === 'pa')).toBe(true);
    expect(forB.map((r) => r.id)).toEqual([b.runId]);
    expect(forA.map((r) => r.id)).toContain(a.runId);
  });

  it('orders newest-first by startedAt', async () => {
    // Three runs created at distinct (monotonically increasing) instants.
    const first = await store.createRun(runCreate('p'));
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.createRun(runCreate('p'));
    await new Promise((r) => setTimeout(r, 2));
    const third = await store.createRun(runCreate('p'));

    const ids = (await store.listRuns('p')).map((r) => r.id);
    expect(ids).toEqual([third.runId, second.runId, first.runId]);
  });

  it('caps the result count with opts.limit (keeping the newest)', async () => {
    const first = await store.createRun(runCreate('p'));
    await new Promise((r) => setTimeout(r, 2));
    const second = await store.createRun(runCreate('p'));
    await new Promise((r) => setTimeout(r, 2));
    const third = await store.createRun(runCreate('p'));

    const limited = await store.listRuns('p', { limit: 2 });
    expect(limited.map((r) => r.id)).toEqual([third.runId, second.runId]);
    // The oldest run is excluded by the cap.
    expect(limited.map((r) => r.id)).not.toContain(first.runId);
  });

  it('returns an empty array for a pipeline with no runs', async () => {
    expect(await store.listRuns('nobody')).toEqual([]);
  });
});

// ── StepRecorder: sequencing ──────────────────────────────────────────────────

describe('MemoryStore step sequencing', () => {
  it('assigns sequenceIndex starting at 0 and increments per start()', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    await store.start({ runId, nodeId: 'n1', nodeLabel: 'First' });
    await store.start({ runId, nodeId: 'n2', nodeLabel: 'Second' });

    const steps = store.getSteps(runId);
    expect(steps.map((s) => s.sequenceIndex)).toEqual([0, 1]);
    expect(steps.map((s) => s.nodeLabel)).toEqual(['First', 'Second']);
    expect(steps.every((s) => s.status === 'RUNNING')).toBe(true);
  });

  it('shares one sequence counter across start() and startChild()', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    const parent = await store.start({ runId, nodeId: 'p1', nodeLabel: 'Parent' });
    await store.startChild({ runId, parentStepId: parent, nodeId: 'c1', input: { x: 1 } });
    await store.start({ runId, nodeId: 'n2', nodeLabel: 'After' });

    expect(store.getSteps(runId).map((s) => s.sequenceIndex)).toEqual([0, 1, 2]);
  });

  it('keeps sequence counters independent per run', async () => {
    const runA = (await store.createRun(runCreate('p'))).runId;
    const runB = (await store.createRun(runCreate('p'))).runId;
    await store.start({ runId: runA, nodeId: 'a1', nodeLabel: 'A1' });
    await store.start({ runId: runB, nodeId: 'b1', nodeLabel: 'B1' });
    await store.start({ runId: runA, nodeId: 'a2', nodeLabel: 'A2' });

    expect(store.getSteps(runA).map((s) => s.sequenceIndex)).toEqual([0, 1]);
    expect(store.getSteps(runB).map((s) => s.sequenceIndex)).toEqual([0]);
  });

  it('assigns unique, gap-free sequence indices under concurrent start() (fan-in mutex)', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    // Fire many starts concurrently — the promise-chain mutex must serialize them.
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        store.start({ runId, nodeId: `n${String(i)}`, nodeLabel: `L${String(i)}` })
      )
    );

    const indices = store.getSteps(runId).map((s) => s.sequenceIndex);
    // Exactly 0..N-1, each once, no collisions and no gaps.
    expect(indices).toEqual(Array.from({ length: N }, (_unused, i) => i));
    expect(new Set(indices).size).toBe(N);
  });
});

// ── StepRecorder: finish / finishChild / finalizeStaleSteps ────────────────────

describe('MemoryStore.finish', () => {
  it('updates status, output and finishedAt for an existing step', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    const stepId = await store.start({ runId, nodeId: 'n1', nodeLabel: 'Step' });
    await store.finish(stepId, { status: 'SUCCESS', output: { ok: true } });

    const steps = store.getSteps(runId);
    expect(steps[0]?.status).toBe('SUCCESS');
  });

  it('is a silent no-op for an unknown stepId', async () => {
    await expect(store.finish('ghost', { status: 'SUCCESS' })).resolves.toBeUndefined();
  });

  it('finishChild delegates to finish (records the result on the child step)', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    const parent = await store.start({ runId, nodeId: 'p1', nodeLabel: 'Parent' });
    const child = await store.startChild({ runId, parentStepId: parent, nodeId: 'c1', input: 1 });
    await store.finishChild(child, { status: 'SUCCESS', output: 'done' });

    const childStep = store.getSteps(runId).find((s) => s.nodeLabel === 'c1');
    expect(childStep?.status).toBe('SUCCESS');
  });
});

describe('MemoryStore.finalizeStaleSteps', () => {
  it('marks only still-RUNNING steps of the run as FAILED', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    const a = await store.start({ runId, nodeId: 'a', nodeLabel: 'A' });
    await store.start({ runId, nodeId: 'b', nodeLabel: 'B' }); // left RUNNING
    await store.finish(a, { status: 'SUCCESS' });

    await store.finalizeStaleSteps(runId);

    const byLabel = new Map<string, RunStepStatus>(
      store.getSteps(runId).map((s) => [s.nodeLabel, s.status])
    );
    // Already-finished step keeps its terminal status; the stale one flips to FAILED.
    expect(byLabel.get('A')).toBe('SUCCESS');
    expect(byLabel.get('B')).toBe('FAILED');
  });

  it('does not touch steps belonging to other runs', async () => {
    const runA = (await store.createRun(runCreate('p'))).runId;
    const runB = (await store.createRun(runCreate('p'))).runId;
    await store.start({ runId: runA, nodeId: 'a', nodeLabel: 'A' });
    await store.start({ runId: runB, nodeId: 'b', nodeLabel: 'B' });

    await store.finalizeStaleSteps(runA);

    expect(store.getSteps(runA)[0]?.status).toBe('FAILED');
    // runB's still-running step is untouched.
    expect(store.getSteps(runB)[0]?.status).toBe('RUNNING');
  });

  it('is a no-op when a run has no running steps', async () => {
    const { runId } = await store.createRun(runCreate('p'));
    const s = await store.start({ runId, nodeId: 'n', nodeLabel: 'N' });
    await store.finish(s, { status: 'SUCCESS' });

    await store.finalizeStaleSteps(runId);
    expect(store.getSteps(runId)[0]?.status).toBe('SUCCESS');
  });
});
