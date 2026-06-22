import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PipelineDraft } from '@openpipeline/core';

import type { PipelineHandlers } from './handlers.js';
import { sseFrame, SSE_HEADERS } from './sse.js';

/**
 * A tiny Node `http` request handler wiring the pipeline routes. Drop it into
 * `http.createServer(...)`. For real apps, prefer mounting `PipelineHandlers`
 * into your framework (Express/Fastify/Hono) — this adapter exists so the package
 * runs out of the box.
 *
 * Routes (all under `basePath`, default `/pipeline`):
 *   POST   /pipeline                  -> save     { ...PipelineDraft }  => { pipelineId }
 *   GET    /pipeline/:id              -> load
 *   GET    /pipeline/:id/runs         -> list runs
 *   POST   /pipeline/run              -> run (non-streaming)  { pipelineId }
 *   POST   /pipeline/run/:runId/abort -> abort
 *   GET    /pipeline/runs/:runId/stream?pipelineId=... -> SSE live events
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

    // POST /pipeline/run/:runId/abort
    const abortMatch = rest.match(/^\/run\/([^/]+)\/abort$/);
    if (method === 'POST' && abortMatch) {
      const [, runId] = abortMatch;
      if (runId !== undefined) {
        handlers.abortRun(runId);
        json(res, 200, { ok: true });
        return;
      }
    }

    // GET /pipeline/runs/:runId/stream  (SSE)
    const streamMatch = rest.match(/^\/runs\/([^/]+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const pipelineId = url.searchParams.get('pipelineId');
      if (!pipelineId) {
        json(res, 400, { error: 'pipelineId query param required' });
        return;
      }
      res.writeHead(200, SSE_HEADERS);
      await handlers.runAndStream({ pipelineId }, (event) => {
        res.write(sseFrame(event));
      });
      res.end();
      return;
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
