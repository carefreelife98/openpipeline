import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PipelineDraft, RunContext } from '@openpipeline/core';

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
 *   GET    /pipeline/:id                -> load
 *   GET    /pipeline/:id/runs           -> list runs
 *   POST   /pipeline/run                -> run (non-streaming)  { pipelineId }
 *   POST   /pipeline/run/stream         -> start a run and stream its live events
 *                                           (SSE)  { pipelineId, context? } — this is
 *                                           the route that actually starts a run;
 *                                           the GET stream route below no longer does.
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
    if (method === 'POST' && rest === '/run') {
      const body = (await readJson(req)) as { pipelineId: string };
      json(res, 200, await handlers.runPipeline({ pipelineId: body.pipelineId }));
      return;
    }

    // POST /pipeline/run/stream — start a run and stream it. The route that
    // actually starts a run + streams it (the old GET stream route's real
    // meaning); see #S11a/#E1.
    if (method === 'POST' && rest === '/run/stream') {
      const body = (await readJson(req)) as { pipelineId: string; context?: RunContext };
      res.writeHead(200, SSE_HEADERS);
      // Client-disconnect handling (#S11c/#E2): once the connection is gone we
      // must stop writing to it — writing to a destroyed response throws — but
      // the run itself keeps running (fire-and-forget semantics; disconnecting
      // does not abort it). A plain `let` here gets permanently narrowed to
      // `false` by TS/eslint across the `await` below (it can't see the
      // `req.on('close', ...)` callback flipping it), so a mutable box is used
      // instead — not a style nit, the `let` version type-checks to a
      // structurally-always-true guard that would silently stop guarding.
      const state = { closed: false };
      req.on('close', () => {
        state.closed = true;
      });
      await handlers.runAndStream(
        { pipelineId: body.pipelineId, context: body.context },
        (event) => {
          if (!state.closed && !res.writableEnded) res.write(sseFrame(event));
        }
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
        req.on('close', () => {
          state.closed = true;
        });
        await handlers.streamRun(runId, (event) => {
          if (!state.closed && !res.writableEnded) res.write(sseFrame(event));
        });
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
    const getMatch = rest.match(/^\/([^/]+)$/);
    if (method === 'GET' && getMatch) {
      const [, pipelineId] = getMatch;
      if (pipelineId !== undefined) {
        json(res, 200, await handlers.getPipeline(pipelineId));
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
