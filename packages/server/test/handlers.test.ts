import type {
  PipelineDraft,
  PipelineEvent,
  PipelineEventListener,
  PipelineWithGraph,
  RunStatus,
  RunSummary,
} from '@openpipeline/core';
import { ZERO_COST } from '@openpipeline/core';
import type { RunHandle, RunOptions, RunResult } from '@openpipeline/runtime';
import { describe, it, expect, vi } from 'vitest';

import type { EnginePort } from '../src/handlers.js';
import { createPipelineHandlers } from '../src/handlers.js';

// A hand-built stub of the exact engine slice the handlers depend on
// (`EnginePort`). It is NOT a mock of the handlers themselves — the real
// handler functions run against it, so these tests exercise the real delegation
// and orchestration logic (subscribe-before-await, status extraction,
// unsubscribe-on-finish) while standing in only for the genuine external
// boundary (a fully wired PipelineEngine + store + LangGraph).

interface RunInvocation {
  runId: string;
  /** Manually settle the run's `done` promise. */
  finish: (result: RunResult) => void;
  /** Emit a live event to every current subscriber for this run. */
  emit: (event: PipelineEvent) => void;
  /** Current subscriber count (asserts subscribe/unsubscribe lifecycle). */
  listenerCount: () => number;
}

class StubEngine implements EnginePort {
  readonly saved: PipelineDraft[] = [];
  readonly loaded: string[] = [];
  readonly listRunsCalls: { pipelineId: string; opts?: { limit?: number } }[] = [];
  readonly aborted: string[] = [];
  readonly runCalls: RunOptions[] = [];

  private runIdSeq = 0;
  /** runId -> live listeners (mirrors the real engine's per-run listener set). */
  private readonly listeners = new Map<string, Set<PipelineEventListener>>();
  /** runId -> the resolver for that run's `done` promise. */
  private readonly resolvers = new Map<string, (result: RunResult) => void>();
  /** Mirrors the real engine's `inFlight` map — set in `run()`, cleared once `finish()` settles. */
  private readonly inFlightIds = new Set<string>();

  save(draft: PipelineDraft): Promise<string> {
    this.saved.push(draft);
    return Promise.resolve(draft.id ?? 'generated-id');
  }

  load(pipelineId: string): Promise<PipelineWithGraph> {
    this.loaded.push(pipelineId);
    const graph: PipelineWithGraph = {
      pipeline: {
        id: pipelineId,
        name: 'stub',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      nodes: [],
      edges: [],
    };
    return Promise.resolve(graph);
  }

  listRuns(pipelineId: string, opts?: { limit?: number }): Promise<RunSummary[]> {
    this.listRunsCalls.push({ pipelineId, opts });
    const summary: RunSummary = {
      id: 'run-1',
      pipelineId,
      status: 'SUCCESS',
      startedAt: new Date(0),
    };
    return Promise.resolve([summary]);
  }

  /** Mirrors the real engine: false for unknown/finished runs, true (and marks aborted) for in-flight ones. */
  abort(runId: string): boolean {
    if (!this.inFlightIds.has(runId)) return false;
    this.aborted.push(runId);
    return true;
  }

  isInFlight(runId: string): boolean {
    return this.inFlightIds.has(runId);
  }

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

  run(opts: RunOptions): Promise<RunHandle> {
    this.runCalls.push(opts);
    this.runIdSeq += 1;
    const runId = `run-${String(this.runIdSeq)}`;
    this.inFlightIds.add(runId);
    // Mirrors the real engine: onEvent (if supplied) is registered
    // synchronously here, before `run()` returns — no subscribe gap.
    if (opts.onEvent) {
      let set = this.listeners.get(runId);
      if (!set) {
        set = new Set();
        this.listeners.set(runId, set);
      }
      set.add(opts.onEvent);
    }
    const done = new Promise<RunResult>((resolve) => {
      this.resolvers.set(runId, (result) => {
        this.inFlightIds.delete(runId);
        this.listeners.delete(runId);
        resolve(result);
      });
    });
    return Promise.resolve({ runId, done });
  }

  /** Drive a started run: emit events, settle it, inspect listeners. */
  invocation(runId: string): RunInvocation {
    return {
      runId,
      finish: (result) => {
        const resolve = this.resolvers.get(runId);
        if (!resolve) throw new Error(`no pending run ${runId}`);
        resolve(result);
      },
      emit: (event) => {
        for (const l of this.listeners.get(runId) ?? []) l(event);
      },
      listenerCount: () => this.listeners.get(runId)?.size ?? 0,
    };
  }
}

function makeRunResult(runId: string, status: RunStatus): RunResult {
  return { runId, status, outputs: {}, cost: ZERO_COST };
}

describe('createPipelineHandlers', () => {
  describe('savePipeline', () => {
    it('delegates the draft to engine.save and wraps the id as { pipelineId }', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);
      const draft: PipelineDraft = { id: 'p1', name: 'My Pipeline', nodes: [], edges: [] };

      const result = await handlers.savePipeline(draft);

      expect(result).toEqual({ pipelineId: 'p1' });
      expect(engine.saved).toEqual([draft]);
    });

    it('returns whatever id the engine generates for a draft without one', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const result = await handlers.savePipeline({ name: 'no-id', nodes: [], edges: [] });

      expect(result).toEqual({ pipelineId: 'generated-id' });
    });
  });

  describe('getPipeline', () => {
    it('returns the loaded graph straight through from engine.load', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const graph = (await handlers.getPipeline('p1')) as PipelineWithGraph;

      expect(engine.loaded).toEqual(['p1']);
      expect(graph.pipeline.id).toBe('p1');
    });
  });

  describe('listRuns', () => {
    it('forwards the pipelineId and passes through the engine result', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const runs = (await handlers.listRuns('p1')) as RunSummary[];

      expect(runs).toHaveLength(1);
      expect(engine.listRunsCalls).toEqual([{ pipelineId: 'p1', opts: undefined }]);
    });

    it('forwards the optional limit option verbatim', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      await handlers.listRuns('p1', { limit: 5 });

      expect(engine.listRunsCalls).toEqual([{ pipelineId: 'p1', opts: { limit: 5 } }]);
    });
  });

  describe('abortRun', () => {
    it('returns false and does not delegate for an unknown/not-in-flight run (#S11d)', () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const result = handlers.abortRun('run-42');

      expect(result).toBe(false);
      expect(engine.aborted).toEqual([]);
    });

    it('delegates to engine.abort and returns true for an in-flight run', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);
      const promise = handlers.runPipeline({ pipelineId: 'p1' });
      const inv = engine.invocation('run-1');

      const result = handlers.abortRun('run-1');

      expect(result).toBe(true);
      expect(engine.aborted).toEqual(['run-1']);
      inv.finish(makeRunResult('run-1', 'ABORTED'));
      await promise;
    });
  });

  describe('runPipeline (non-streaming)', () => {
    it('starts the run and resolves with the final runId + status', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const promise = handlers.runPipeline({ pipelineId: 'p1' });
      // The run was started; settle its `done` promise.
      engine.invocation('run-1').finish(makeRunResult('run-1', 'SUCCESS'));

      await expect(promise).resolves.toEqual({ runId: 'run-1', status: 'SUCCESS' });
      expect(engine.runCalls).toEqual([{ pipelineId: 'p1' }]);
    });

    it('surfaces a FAILED status from the run result (does not throw)', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const promise = handlers.runPipeline({ pipelineId: 'p1' });
      engine.invocation('run-1').finish(makeRunResult('run-1', 'FAILED'));

      await expect(promise).resolves.toEqual({ runId: 'run-1', status: 'FAILED' });
    });

    it('does NOT subscribe to events (non-streaming path)', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const promise = handlers.runPipeline({ pipelineId: 'p1' });
      const inv = engine.invocation('run-1');
      expect(inv.listenerCount()).toBe(0);
      inv.finish(makeRunResult('run-1', 'SUCCESS'));
      await promise;
    });
  });

  describe('runAndStream', () => {
    it('passes onEvent through RunOptions to engine.run — registered before run() returns, no subscribe gap (#S11b)', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);
      const received: PipelineEvent[] = [];

      const promise = handlers.runAndStream({ pipelineId: 'p1' }, (e) => received.push(e));
      const inv = engine.invocation('run-1');

      // No polling: registration happens synchronously inside engine.run(),
      // which has already been called by the time this line runs.
      expect(inv.listenerCount()).toBe(1);
      expect(engine.runCalls).toHaveLength(1);
      expect(engine.runCalls[0]).toMatchObject({ pipelineId: 'p1' });
      expect(typeof engine.runCalls[0]?.onEvent).toBe('function');

      inv.emit({ kind: 'NODE_START', nodeId: 'a' });
      inv.emit({ kind: 'NODE_END', nodeId: 'a', output: { ok: true } });
      inv.emit({ kind: 'RUN_COMPLETE', status: 'SUCCESS' });
      inv.finish(makeRunResult('run-1', 'SUCCESS'));

      await expect(promise).resolves.toEqual({ runId: 'run-1', status: 'SUCCESS' });
      expect(received).toEqual([
        { kind: 'NODE_START', nodeId: 'a' },
        { kind: 'NODE_END', nodeId: 'a', output: { ok: true } },
        { kind: 'RUN_COMPLETE', status: 'SUCCESS' },
      ]);
    });

    it("no longer leaks a listener once the run finishes (cleanup is the engine's job now, not a handler-side unsubscribe)", async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const promise = handlers.runAndStream({ pipelineId: 'p1' }, () => undefined);
      const inv = engine.invocation('run-1');
      expect(inv.listenerCount()).toBe(1);

      inv.finish(makeRunResult('run-1', 'SUCCESS'));
      await promise;

      expect(inv.listenerCount()).toBe(0);
    });

    it("propagates a rejection from engine.run's done promise (does not swallow it)", async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);
      const rejecting = vi.spyOn(engine, 'run').mockImplementation((opts: RunOptions) => {
        engine.runCalls.push(opts);
        return Promise.resolve({
          runId: 'run-x',
          done: Promise.reject(new Error('boom')),
        });
      });

      const promise = handlers.runAndStream({ pipelineId: 'p1' }, () => undefined);

      await expect(promise).rejects.toThrow('boom');
      rejecting.mockRestore();
    });

    it('passes the run context through to engine.run', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const promise = handlers.runAndStream(
        { pipelineId: 'p1', context: { userId: 'auditor-1' } },
        () => undefined
      );
      engine.invocation('run-1').finish(makeRunResult('run-1', 'SUCCESS'));
      await promise;

      expect(engine.runCalls).toHaveLength(1);
      expect(engine.runCalls[0]).toMatchObject({
        pipelineId: 'p1',
        context: { userId: 'auditor-1' },
      });
      expect(typeof engine.runCalls[0]?.onEvent).toBe('function');
    });
  });

  describe('isInFlight', () => {
    it('delegates straight through to engine.isInFlight — the pre-writeHead 404 gate for the GET attach route', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      expect(handlers.isInFlight('nonexistent')).toBe(false);

      const runPromise = handlers.runPipeline({ pipelineId: 'p1' });
      expect(handlers.isInFlight('run-1')).toBe(true);

      engine.invocation('run-1').finish(makeRunResult('run-1', 'SUCCESS'));
      await runPromise;
      expect(handlers.isInFlight('run-1')).toBe(false);
    });
  });

  describe('streamRun (attach to an in-flight run)', () => {
    it('returns { found: false } without subscribing, for a run that is not in flight (#S11a/#E1)', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);

      const result = await handlers.streamRun('nonexistent', () => undefined);

      expect(result).toEqual({ found: false });
      expect(engine.invocation('nonexistent').listenerCount()).toBe(0);
    });

    it('attaches to an in-flight run, forwards events, and resolves { found: true } on RUN_COMPLETE, then unsubscribes', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);
      // Start a run out of band (as runPipeline/runAndStream would) so it is in flight.
      const runPromise = handlers.runPipeline({ pipelineId: 'p1' });
      const inv = engine.invocation('run-1');
      const received: PipelineEvent[] = [];

      const streamPromise = handlers.streamRun('run-1', (e) => received.push(e));
      expect(inv.listenerCount()).toBe(1);

      inv.emit({ kind: 'NODE_START', nodeId: 'a' });
      inv.emit({ kind: 'RUN_COMPLETE', status: 'SUCCESS' });

      await expect(streamPromise).resolves.toEqual({ found: true });
      expect(received).toEqual([
        { kind: 'NODE_START', nodeId: 'a' },
        { kind: 'RUN_COMPLETE', status: 'SUCCESS' },
      ]);
      expect(inv.listenerCount()).toBe(0); // unsubscribed itself on RUN_COMPLETE

      inv.finish(makeRunResult('run-1', 'SUCCESS'));
      await runPromise;
    });

    it('does not call engine.run — attaching never starts a new run', async () => {
      const engine = new StubEngine();
      const handlers = createPipelineHandlers(engine);
      const runPromise = handlers.runPipeline({ pipelineId: 'p1' });
      const inv = engine.invocation('run-1');

      const streamPromise = handlers.streamRun('run-1', () => undefined);
      inv.emit({ kind: 'RUN_COMPLETE', status: 'SUCCESS' });
      await streamPromise;

      inv.finish(makeRunResult('run-1', 'SUCCESS'));
      await runPromise;

      expect(engine.runCalls).toHaveLength(1); // only the original runPipeline() call
    });
  });
});
