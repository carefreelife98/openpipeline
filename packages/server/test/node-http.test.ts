import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
  PipelineDraft,
  PipelineEvent,
  PipelineEventListener,
  PipelineWithGraph,
  RunSummary,
} from '@openpipeline/core';
import { ZERO_COST } from '@openpipeline/core';
import type { RunHandle, RunOptions, RunResult } from '@openpipeline/runtime';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { EnginePort, PipelineHandlers } from '../src/handlers.js';
import { createPipelineHandlers } from '../src/handlers.js';
import { createNodeHttpHandler } from '../src/node-http.js';

// The node-http adapter is exercised against a REAL Node http server with REAL
// requests — the most faithful way to assert its URL/method routing, body
// parsing, status codes, and SSE streaming. The only stub is the engine
// boundary (EnginePort), which also lets us drive streaming deterministically.

interface RunController {
  emit: (event: PipelineEvent) => void;
  finish: (status: RunResult['status']) => void;
}

class StubEngine implements EnginePort {
  saved: PipelineDraft[] = [];
  loaded: string[] = [];
  listRunsCalls: { pipelineId: string; opts?: { limit?: number } }[] = [];
  aborted: string[] = [];
  runCalls: RunOptions[] = [];

  private readonly listeners = new Map<string, Set<PipelineEventListener>>();
  private readonly resolvers = new Map<string, (r: RunResult) => void>();
  private seq = 0;

  /** Auto-finish runs synchronously (used by the non-streaming path). */
  autoFinish = true;

  save(draft: PipelineDraft): Promise<string> {
    this.saved.push(draft);
    return Promise.resolve(draft.id ?? 'new-id');
  }

  load(pipelineId: string): Promise<PipelineWithGraph> {
    this.loaded.push(pipelineId);
    return Promise.resolve({
      pipeline: { id: pipelineId, name: 'g', createdAt: new Date(0), updatedAt: new Date(0) },
      nodes: [],
      edges: [],
    });
  }

  listRuns(pipelineId: string, opts?: { limit?: number }): Promise<RunSummary[]> {
    this.listRunsCalls.push({ pipelineId, opts });
    const s: RunSummary = { id: 'r1', pipelineId, status: 'SUCCESS', startedAt: new Date(0) };
    return Promise.resolve([s]);
  }

  abort(runId: string): void {
    this.aborted.push(runId);
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
    this.seq += 1;
    const runId = `run-${String(this.seq)}`;
    const done = new Promise<RunResult>((resolve) => {
      this.resolvers.set(runId, resolve);
    });
    if (this.autoFinish)
      this.resolvers.get(runId)?.({ runId, status: 'SUCCESS', outputs: {}, cost: ZERO_COST });
    return Promise.resolve({ runId, done });
  }

  controller(runId: string): RunController {
    return {
      emit: (event) => {
        for (const l of this.listeners.get(runId) ?? []) l(event);
      },
      finish: (status) => {
        this.resolvers.get(runId)?.({ runId, status, outputs: {}, cost: ZERO_COST });
      },
    };
  }

  /** Number of live SSE subscribers for a run (used to await server-side setup). */
  listenerCount(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }
}

/**
 * The SSE handler subscribes only after `res.writeHead` flushes the response
 * headers, i.e. after `fetch` resolves. Poll until the server-side subscription
 * exists before driving the run — deterministic, no fixed sleep.
 */
async function waitForSubscriber(engine: StubEngine, runId: string): Promise<void> {
  for (let i = 0; i < 200 && engine.listenerCount(runId) === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

interface TestServer {
  base: string;
  engine: StubEngine;
  handlers: PipelineHandlers;
  server: Server;
}

let current: TestServer | undefined;

function start(opts: { basePath?: string } = {}): Promise<TestServer> {
  const engine = new StubEngine();
  const handlers = createPipelineHandlers(engine);
  const server = createServer(createNodeHttpHandler(handlers, opts));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${String(addr.port)}`, engine, handlers, server });
    });
  });
}

beforeEach(async () => {
  current = await start();
});

afterEach(() => {
  current?.server.close();
  current = undefined;
});

function ctx(): TestServer {
  if (!current) throw new Error('server not started');
  return current;
}

describe('createNodeHttpHandler routing', () => {
  it('POST /pipeline saves a draft and returns { pipelineId }', async () => {
    const { base, engine } = ctx();
    const draft: PipelineDraft = { id: 'p9', name: 'n', nodes: [], edges: [] };

    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      body: JSON.stringify(draft),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pipelineId: 'p9' });
    expect(engine.saved).toHaveLength(1);
    expect(engine.saved[0]?.name).toBe('n');
  });

  it('POST /pipeline with an empty body parses to {} (readJson empty-string branch)', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline`, { method: 'POST' });

    expect(res.status).toBe(200);
    // No id in the (empty) draft -> engine generates one.
    expect(await res.json()).toEqual({ pipelineId: 'new-id' });
    expect(engine.saved).toEqual([{}]);
  });

  it('GET /pipeline/:id loads that pipeline', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline/abc`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as PipelineWithGraph;
    expect(body.pipeline.id).toBe('abc');
    expect(engine.loaded).toEqual(['abc']);
  });

  it('GET /pipeline/:id/runs lists runs for that pipeline', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline/abc/runs`);

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
    expect(engine.listRunsCalls).toEqual([{ pipelineId: 'abc', opts: undefined }]);
  });

  it('GET /pipeline/:id/runs?limit=3 forwards a numeric limit', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline/abc/runs?limit=3`);

    expect(res.status).toBe(200);
    expect(engine.listRunsCalls).toEqual([{ pipelineId: 'abc', opts: { limit: 3 } }]);
  });

  it('POST /pipeline/run runs non-streaming and returns runId + status', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline/run`, {
      method: 'POST',
      body: JSON.stringify({ pipelineId: 'p1' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'run-1', status: 'SUCCESS' });
    expect(engine.runCalls).toEqual([{ pipelineId: 'p1' }]);
  });

  it('POST /pipeline/run/:runId/abort aborts that run', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline/run/run-77/abort`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(engine.aborted).toEqual(['run-77']);
  });

  it('GET /pipeline/runs/:runId/stream without pipelineId returns 400', async () => {
    const { base } = ctx();

    const res = await fetch(`${base}/pipeline/runs/run-1/stream`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'pipelineId query param required' });
  });

  it('GET /pipeline/runs/:runId/stream streams SSE frames then closes', async () => {
    const { base, engine } = ctx();
    engine.autoFinish = false; // drive the stream manually

    // Issue the request and drive the run concurrently: the server processes the
    // request independently of when `fetch` resolves, so we wait on the engine's
    // own subscription state (set after `res.writeHead`) before emitting.
    const responsePromise = fetch(`${base}/pipeline/runs/ignored/stream?pipelineId=p1`);

    // The handler calls engine.run -> runId 'run-1'.
    await waitForSubscriber(engine, 'run-1');
    const c = engine.controller('run-1');
    c.emit({ kind: 'NODE_START', nodeId: 'a' });
    c.emit({ kind: 'RUN_COMPLETE', status: 'SUCCESS' });
    c.finish('SUCCESS');

    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');

    const text = await res.text(); // resolves once the server ends the response
    expect(text).toContain('event: NODE_START\ndata: {"kind":"NODE_START","nodeId":"a"}\n\n');
    expect(text).toContain(
      'event: RUN_COMPLETE\ndata: {"kind":"RUN_COMPLETE","status":"SUCCESS"}\n\n'
    );
  });

  it('returns 404 for a path outside the base path', async () => {
    const { base } = ctx();

    const res = await fetch(`${base}/not-pipeline/x`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('returns 404 for an unmatched method/route under the base path', async () => {
    const { base } = ctx();

    // DELETE is not routed anywhere.
    const res = await fetch(`${base}/pipeline/abc`, { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('returns 500 with the error message when a handler throws', async () => {
    // Standalone server whose engine.load rejects.
    const engine = new StubEngine();
    engine.load = () => Promise.reject(new Error('kaboom'));
    const server = createServer(createNodeHttpHandler(createPipelineHandlers(engine)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${String(addr.port)}/pipeline/abc`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'kaboom' });
    } finally {
      server.close();
    }
  });
});

describe('createNodeHttpHandler with a custom basePath', () => {
  it('routes under the custom base and 404s the default base', async () => {
    const custom = await start({ basePath: '/api/flows' });
    try {
      const draft: PipelineDraft = { id: 'p1', name: 'n', nodes: [], edges: [] };
      const ok = await fetch(`${custom.base}/api/flows`, {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ pipelineId: 'p1' });

      const miss = await fetch(`${custom.base}/pipeline`, {
        method: 'POST',
        body: JSON.stringify(draft),
      });
      expect(miss.status).toBe(404);
    } finally {
      custom.server.close();
    }
  });
});
