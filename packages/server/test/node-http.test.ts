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
  /** Mirrors the real engine's `inFlight` map — set in `run()`, cleared once its resolver settles. */
  private readonly inFlightIds = new Set<string>();
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
    this.seq += 1;
    const runId = `run-${String(this.seq)}`;
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
 * headers, i.e. after `fetch` resolves. Poll until at least `count` server-side
 * subscriptions exist for the run before driving it — deterministic, no fixed
 * sleep. (`count` is 2 when both a POST /run/stream starter and a GET attach
 * are subscribed to the same run concurrently.)
 */
async function waitForListenerCount(engine: StubEngine, runId: string, count = 1): Promise<void> {
  for (let i = 0; i < 200 && engine.listenerCount(runId) < count; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function waitForSubscriber(engine: StubEngine, runId: string): Promise<void> {
  await waitForListenerCount(engine, runId, 1);
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

  it('POST /pipeline/run/:runId/abort 404s for an unknown/not-in-flight run (#S11d)', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline/run/run-77/abort`, { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'run not found or already finished' });
    expect(engine.aborted).toEqual([]);
  });

  it('POST /pipeline/run/:runId/abort aborts an in-flight run and returns 200', async () => {
    const { base, engine } = ctx();
    engine.autoFinish = false; // keep the run in flight

    const streamPromise = fetch(`${base}/pipeline/run/stream`, {
      method: 'POST',
      body: JSON.stringify({ pipelineId: 'p1' }),
    });
    await waitForSubscriber(engine, 'run-1');

    const abortRes = await fetch(`${base}/pipeline/run/run-1/abort`, { method: 'POST' });
    expect(abortRes.status).toBe(200);
    expect(await abortRes.json()).toEqual({ ok: true });
    expect(engine.aborted).toEqual(['run-1']);

    // Settle the run so the still-open streaming response completes and the
    // test doesn't leave a dangling request.
    engine.controller('run-1').finish('ABORTED');
    const res = await streamPromise;
    expect(res.status).toBe(200);
  });

  it("POST /pipeline/run/stream starts a run and streams its live events (the old GET route's real meaning) (#S11a/#E1)", async () => {
    const { base, engine } = ctx();
    engine.autoFinish = false; // drive the stream manually

    const responsePromise = fetch(`${base}/pipeline/run/stream`, {
      method: 'POST',
      body: JSON.stringify({ pipelineId: 'p1' }),
    });

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
    expect(engine.runCalls).toHaveLength(1);
    expect(engine.runCalls[0]).toMatchObject({ pipelineId: 'p1', context: undefined });
    expect(typeof engine.runCalls[0]?.onEvent).toBe('function');
  });

  it('POST /pipeline/run/stream delivers events from the very first node — no subscribe gap (#S11b)', async () => {
    const { base, engine } = ctx();
    // autoFinish stays true: the run (and its NODE_START/RUN_COMPLETE emission
    // inside the stub's synchronous `run()`) completes before `fetch` even
    // resolves. Before the RunOptions.onEvent fix, this ordering is exactly
    // what used to lose the first event: the handler subscribed only *after*
    // engine.run() resolved, by which time these had already fired.
    engine.autoFinish = false;
    const responsePromise = fetch(`${base}/pipeline/run/stream`, {
      method: 'POST',
      body: JSON.stringify({ pipelineId: 'p1' }),
    });
    await waitForSubscriber(engine, 'run-1');
    // Emit NODE_START synchronously, in the same tick the subscriber appears —
    // simulating a run whose first event fires immediately.
    engine.controller('run-1').emit({ kind: 'NODE_START', nodeId: 'a' });
    engine.controller('run-1').finish('SUCCESS');

    const text = await (await responsePromise).text();
    const firstEventLine = text.split('\n\n')[0]?.split('\n')[0];
    expect(firstEventLine).toBe('event: NODE_START');
  });

  it('GET /pipeline/runs/:runId/stream does NOT start a new run and 404s for an unknown/not-in-flight runId (#S11a/#E1)', async () => {
    const { base, engine } = ctx();

    const res = await fetch(`${base}/pipeline/runs/nonexistent/stream`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'run not in flight (finished-run replay: see roadmap)',
    });
    expect(engine.runCalls).toHaveLength(0);
  });

  it('GET /pipeline/runs/:runId/stream attaches to an in-flight run and streams its events, closing on RUN_COMPLETE', async () => {
    const { base, engine } = ctx();
    engine.autoFinish = false;

    // Start the run out of band via the POST streaming route, kept open.
    const startPromise = fetch(`${base}/pipeline/run/stream`, {
      method: 'POST',
      body: JSON.stringify({ pipelineId: 'p1' }),
    });
    await waitForSubscriber(engine, 'run-1');

    const attachPromise = fetch(`${base}/pipeline/runs/run-1/stream`);
    // Both the POST starter and the GET attach are now subscribed — wait for
    // both before driving events, or RUN_COMPLETE could fire (and finish() the
    // run) before the attach request has even reached the server, 404-ing it.
    await waitForListenerCount(engine, 'run-1', 2);
    const c = engine.controller('run-1');
    c.emit({ kind: 'NODE_START', nodeId: 'a' });
    c.emit({ kind: 'RUN_COMPLETE', status: 'SUCCESS' });
    c.finish('SUCCESS');

    const [startRes, attachRes] = await Promise.all([startPromise, attachPromise]);
    expect(attachRes.status).toBe(200);
    expect(attachRes.headers.get('content-type')).toBe('text/event-stream');
    const attachText = await attachRes.text();
    expect(attachText).toContain('event: NODE_START');
    expect(attachText).toContain('event: RUN_COMPLETE');

    await startRes.text(); // drain the POST stream too, don't leave it dangling
    // The GET attach route never called engine.run() itself.
    expect(engine.runCalls).toHaveLength(1);
  });

  it('a client disconnect on POST /pipeline/run/stream stops writes but keeps the run running (fire-and-forget) (#S11c/#E2)', async () => {
    const { base, engine, server } = ctx();
    engine.autoFinish = false;

    // Observe the server's own view of the request's `close` event
    // independently of node-http.ts's internals — a real, deterministic signal
    // that the underlying connection actually died server-side. A mutable box
    // (not a plain `let`) avoids TS permanently narrowing the flag to `false`
    // across the polling loop below, which can't see the closure flipping it.
    const observed = { serverSawClose: false };
    server.on('request', (req) => {
      if (req.url === '/pipeline/run/stream') {
        req.on('close', () => {
          observed.serverSawClose = true;
        });
      }
    });

    const controller = new AbortController();
    const fetchPromise = fetch(`${base}/pipeline/run/stream`, {
      method: 'POST',
      body: JSON.stringify({ pipelineId: 'p1' }),
      signal: controller.signal,
    });
    // `res.writeHead()` alone doesn't flush headers onto the wire until the
    // first `write()`/`end()` — since we abort before emitting any event,
    // `fetchPromise` never settles on its own; don't await it (would hang),
    // just avoid an unhandled-rejection warning once the abort rejects it.
    fetchPromise.catch(() => undefined);
    await waitForSubscriber(engine, 'run-1');

    controller.abort();

    for (let i = 0; i < 500 && !observed.serverSawClose; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(observed.serverSawClose).toBe(true);

    // Emitting further events (as the run keeps going) must not throw even
    // though nobody is listening anymore — the write is guarded, not attempted.
    expect(() => {
      engine.controller('run-1').emit({ kind: 'NODE_END', nodeId: 'a', output: {} });
    }).not.toThrow();

    // Disconnecting must NOT abort the run — fire-and-forget semantics.
    expect(engine.aborted).toEqual([]);
    expect(engine.isInFlight('run-1')).toBe(true);

    engine.controller('run-1').emit({ kind: 'RUN_COMPLETE', status: 'SUCCESS' });
    engine.controller('run-1').finish('SUCCESS');
    expect(engine.isInFlight('run-1')).toBe(false);

    // The server itself is still healthy afterwards.
    const health = await fetch(`${base}/pipeline/abc`);
    expect(health.status).toBe(200);
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
