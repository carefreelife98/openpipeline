import type { IncomingMessage, ServerResponse } from 'node:http';

import { PipelineNotFoundError, type PipelineDraft, type RunContext } from '@openpipeline/core';

import type { PipelineHandlers } from './handlers.js';
import { sseFrame, SSE_HEADERS } from './sse.js';

/**
 * A tiny Node `http` request handler wiring the pipeline routes. Drop it into
 * `http.createServer(...)`. For real apps, prefer mounting `PipelineHandlers`
 * into your framework (Express/Fastify/Hono) — this adapter exists so the package
 * runs out of the box.
 *
 * Routes (all under `basePath`, default `/pipeline`):
 *   POST   /pipeline                    -> save     { ...PipelineDraft }  => { pipelineId }
 *   GET    /pipeline/:id                -> load. 404 (`{ error }`) if the pipeline
 *                                           does not exist (`PipelineNotFoundError`);
 *                                           any other failure (e.g. a DB outage) still
 *                                           500s, unclassified — never conflated with
 *                                           "not found".
 *   GET    /pipeline/:id/runs           -> list runs
 *   POST   /pipeline/run                -> run (non-streaming)  { pipelineId }. 400 for
 *                                           a missing/non-string `pipelineId`, validated
 *                                           before the engine is touched; 404 for
 *                                           a nonexistent pipeline (`PipelineNotFoundError`,
 *                                           thrown by `store.load` before the run row is
 *                                           created — see runtime's `run()`); any other
 *                                           failure still 500s.
 *   POST   /pipeline/run/stream         -> start a run and stream its live events
 *                                           (SSE)  { pipelineId, context? } — this is
 *                                           the route that actually starts a run;
 *                                           the GET stream route below no longer does.
 *                                           404 (headers unsent) for a nonexistent
 *                                           pipeline (`PipelineNotFoundError`); 400
 *                                           (headers unsent) for a missing/non-string
 *                                           `pipelineId` or any other startRun failure —
 *                                           both validated/started BEFORE
 *                                           `res.writeHead` (#8).
 *   GET    /pipeline/runs/:runId/stream -> attach to an already IN-FLIGHT run's SSE
 *                                           stream. 404 (headers unsent) if the run is
 *                                           unknown or has already finished — never
 *                                           starts a run and never replays one (#S11a/#E1).
 *   POST   /pipeline/run/:runId/abort   -> abort. 404 if the run is unknown or has
 *                                           already finished (#S11d).
 */
export function createNodeHttpHandler(
  handlers: PipelineHandlers,
  opts: { basePath?: string } = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const base = opts.basePath ?? '/pipeline';

  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith(base)) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const rest = path.slice(base.length); // '' | '/:id' | '/run' | '/runs/:id/stream' ...

    // POST /pipeline  (save)
    if (method === 'POST' && (rest === '' || rest === '/')) {
      const draft = (await readJson(req)) as PipelineDraft;
      json(res, 200, await handlers.savePipeline(draft));
      return;
    }

    // POST /pipeline/run  (run, non-streaming)
    // `pipelineId` is validated the same way `/run/stream` validates it —
    // BEFORE the engine is ever touched — so a missing/non-string field 400s
    // instead of reaching `store.load` with `undefined` and coming back as a
    // misleading 404 `Pipeline not found: undefined`.
    // A PipelineNotFoundError from engine.run() (store.load runs before
    // createRun — see runtime/src/index.ts) 404s; any other error (e.g. an
    // infra failure) falls through to the top-level catch's generic 500 —
    // unchanged from before PipelineNotFoundError existed.
    if (method === 'POST' && rest === '/run') {
      const body = (await readJson(req)) as { pipelineId?: unknown };
      if (typeof body.pipelineId !== 'string' || body.pipelineId.length === 0) {
        json(res, 400, { error: 'pipelineId is required and must be a non-empty string' });
        return;
      }
      let result: Awaited<ReturnType<typeof handlers.runPipeline>>;
      try {
        result = await handlers.runPipeline({ pipelineId: body.pipelineId });
      } catch (err) {
        if (err instanceof PipelineNotFoundError) {
          json(res, 404, { error: err.message });
          return;
        }
        throw err;
      }
      json(res, 200, result);
      return;
    }

    // POST /pipeline/run/stream — start a run and stream it. The route that
    // actually starts a run + streams it (the old GET stream route's real
    // meaning); see #S11a/#E1.
    //
    // #8 — `pipelineId` is validated, AND the run is actually started (via
    // `startRun`, which loads the pipeline before doing anything else) —
    // BEFORE `res.writeHead` — so a missing OR nonexistent pipelineId 400s
    // with headers still unsent, instead of `store.load` rejecting into the
    // top-level catch (line ~37) after a 200 `text/event-stream` response was
    // already committed, which used to smuggle a raw JSON error body into an
    // already-open SSE stream — not a valid SSE frame, and a violation of the
    // same "404/400 only with headers unsent" invariant the GET stream route
    // and the abort route already uphold.
    if (method === 'POST' && rest === '/run/stream') {
      const body = (await readJson(req)) as { pipelineId?: unknown; context?: RunContext };
      if (typeof body.pipelineId !== 'string' || body.pipelineId.length === 0) {
        json(res, 400, { error: 'pipelineId is required and must be a non-empty string' });
        return;
      }
      let runId: string;
      try {
        ({ runId } = await handlers.startRun({
          pipelineId: body.pipelineId,
          context: body.context,
        }));
      } catch (err) {
        // A PipelineNotFoundError (store.load runs before createRun inside
        // engine.run — see runtime/src/index.ts) 404s; any other startRun
        // failure (validation, MCP catalog, infra) keeps the pre-existing
        // headers-unsent 400 behavior.
        if (err instanceof PipelineNotFoundError) {
          json(res, 404, { error: err.message });
          return;
        }
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }

      res.writeHead(200, SSE_HEADERS);
      // Client-disconnect handling (#S11c/#E2): once the connection is gone we
      // must stop writing to it — writing to a destroyed response throws — but
      // the run itself keeps running (fire-and-forget semantics; disconnecting
      // does not abort it). A plain `let` here gets permanently narrowed to
      // `false` by TS/eslint across the `await` below (it can't see the
      // `res.on('close', ...)` callback flipping it), so a mutable box is used
      // instead — not a style nit, the `let` version type-checks to a
      // structurally-always-true guard that would silently stop guarding.
      //
      // `res.on('close', ...)` (NOT `req.on('close', ...)`) is the correct
      // signal here — confirmed empirically, not just from the docs'
      // wording: `req`'s (IncomingMessage) `'close'` fires as soon as the
      // REQUEST body finishes being read (i.e., right after `readJson(req)`
      // above returns), completely independent of whether the client is
      // still connected waiting on the response — for a POST with a body,
      // by the time this line runs that has ALREADY happened, so a listener
      // attached here would silently never fire on a real disconnect.
      // `res`'s (ServerResponse) `'close'` fires only when the underlying
      // connection for the RESPONSE actually tears down (client abort,
      // network failure, or normal `res.end()`), which is what "the client
      // disconnected mid-SSE-stream" actually means.
      const state = { closed: false };
      // #9 — a disconnect must unsubscribe from the engine's per-run listener
      // Set promptly, not just stop writing: `streamRun`'s `opts.signal` is
      // exactly what lets it unsubscribe+resolve immediately on `abort()`
      // instead of waiting for RUN_COMPLETE (up to the run's full timeout).
      const abortController = new AbortController();
      res.on('close', () => {
        state.closed = true;
        abortController.abort();
      });
      await handlers.streamRun(
        runId,
        (event) => {
          if (!state.closed && !res.writableEnded) res.write(sseFrame(event));
        },
        { signal: abortController.signal }
      );
      if (!state.closed && !res.writableEnded) res.end();
      return;
    }

    // POST /pipeline/run/:runId/abort — 404 for an unknown or already-finished
    // run instead of a blanket 200 (#S11d).
    const abortMatch = rest.match(/^\/run\/([^/]+)\/abort$/);
    if (method === 'POST' && abortMatch) {
      const [, runId] = abortMatch;
      if (runId !== undefined) {
        const ok = handlers.abortRun(runId);
        if (ok) json(res, 200, { ok: true });
        else json(res, 404, { error: 'run not found or already finished' });
        return;
      }
    }

    // GET /pipeline/runs/:runId/stream — attach to an IN-FLIGHT run only.
    // `isInFlight` is checked *before* `res.writeHead` so the 404 path never
    // sends headers first (#S11a/#E1) — a single streamRun path, no separate
    // probe helper: `isInFlight` here and `streamRun`'s own internal check are
    // the same underlying read, just ordered around the one point (writeHead)
    // that can't be undone.
    const streamMatch = rest.match(/^\/runs\/([^/]+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const [, runId] = streamMatch;
      if (runId !== undefined) {
        if (!handlers.isInFlight(runId)) {
          json(res, 404, { error: 'run not in flight (finished-run replay: see roadmap)' });
          return;
        }
        res.writeHead(200, SSE_HEADERS);
        const state = { closed: false };
        // #9 — same disconnect-driven unsubscribe as the POST route above,
        // and the same `res.on('close', ...)` (not `req`) choice — see that
        // route's comment for why.
        const abortController = new AbortController();
        res.on('close', () => {
          state.closed = true;
          abortController.abort();
        });
        await handlers.streamRun(
          runId,
          (event) => {
            if (!state.closed && !res.writableEnded) res.write(sseFrame(event));
          },
          { signal: abortController.signal }
        );
        if (!state.closed && !res.writableEnded) res.end();
        return;
      }
    }

    // GET /pipeline/:id/runs
    const runsMatch = rest.match(/^\/([^/]+)\/runs$/);
    if (method === 'GET' && runsMatch) {
      const [, pipelineId] = runsMatch;
      if (pipelineId !== undefined) {
        const limit = url.searchParams.get('limit');
        json(
          res,
          200,
          await handlers.listRuns(pipelineId, limit ? { limit: Number(limit) } : undefined)
        );
        return;
      }
    }

    // GET /pipeline/:id
    // A PipelineNotFoundError from engine.load() 404s; any other error (e.g.
    // an infra failure) falls through to the top-level catch's generic 500 —
    // unchanged from before PipelineNotFoundError existed.
    const getMatch = rest.match(/^\/([^/]+)$/);
    if (method === 'GET' && getMatch) {
      const [, pipelineId] = getMatch;
      if (pipelineId !== undefined) {
        let graph: unknown;
        try {
          graph = await handlers.getPipeline(pipelineId);
        } catch (err) {
          if (err instanceof PipelineNotFoundError) {
            json(res, 404, { error: err.message });
            return;
          }
          throw err;
        }
        json(res, 200, graph);
        return;
      }
    }

    json(res, 404, { error: 'not found' });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
