import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkflowDraft } from '@openworkflow/core';
import type { WorkflowHandlers } from './handlers.js';
import { sseFrame, SSE_HEADERS } from './sse.js';

/**
 * A tiny Node `http` request handler wiring the workflow routes. Drop it into
 * `http.createServer(...)`. For real apps, prefer mounting `WorkflowHandlers`
 * into your framework (Express/Fastify/Hono) — this adapter exists so the package
 * runs out of the box.
 *
 * Routes (all under `basePath`, default `/workflow`):
 *   POST   /workflow                  -> save     { ...WorkflowDraft }  => { workflowId }
 *   GET    /workflow/:id              -> load
 *   GET    /workflow/:id/runs         -> list runs
 *   POST   /workflow/run              -> run (non-streaming)  { workflowId }
 *   POST   /workflow/run/:runId/abort -> abort
 *   GET    /workflow/runs/:runId/stream?workflowId=... -> SSE live events
 */
export function createNodeHttpHandler(
  handlers: WorkflowHandlers,
  opts: { basePath?: string } = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const base = opts.basePath ?? '/workflow';

  return (req, res) => {
    void handle(req, res).catch((err) => {
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

    // POST /workflow  (save)
    if (method === 'POST' && (rest === '' || rest === '/')) {
      const draft = (await readJson(req)) as WorkflowDraft;
      json(res, 200, await handlers.saveWorkflow(draft));
      return;
    }

    // POST /workflow/run  (run, non-streaming)
    if (method === 'POST' && rest === '/run') {
      const body = (await readJson(req)) as { workflowId: string };
      json(res, 200, await handlers.runWorkflow({ workflowId: body.workflowId }));
      return;
    }

    // POST /workflow/run/:runId/abort
    const abortMatch = rest.match(/^\/run\/([^/]+)\/abort$/);
    if (method === 'POST' && abortMatch) {
      handlers.abortRun(abortMatch[1]!);
      json(res, 200, { ok: true });
      return;
    }

    // GET /workflow/runs/:runId/stream  (SSE)
    const streamMatch = rest.match(/^\/runs\/([^/]+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const workflowId = url.searchParams.get('workflowId');
      if (!workflowId) {
        json(res, 400, { error: 'workflowId query param required' });
        return;
      }
      res.writeHead(200, SSE_HEADERS);
      await handlers.runAndStream({ workflowId }, (event) => {
        res.write(sseFrame(event));
      });
      res.end();
      return;
    }

    // GET /workflow/:id/runs
    const runsMatch = rest.match(/^\/([^/]+)\/runs$/);
    if (method === 'GET' && runsMatch) {
      const limit = url.searchParams.get('limit');
      json(res, 200, await handlers.listRuns(runsMatch[1]!, limit ? { limit: Number(limit) } : undefined));
      return;
    }

    // GET /workflow/:id
    const getMatch = rest.match(/^\/([^/]+)$/);
    if (method === 'GET' && getMatch) {
      json(res, 200, await handlers.getWorkflow(getMatch[1]!));
      return;
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
