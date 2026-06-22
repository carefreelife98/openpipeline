/**
 * @openworkflow/server demo — boots a real Node http server, then exercises it
 * over the wire: save a workflow, stream a run via SSE, list runs. No external
 * deps beyond the OpenWorkflow packages.
 */
import { createServer } from 'node:http';
import { WorkflowEngine } from '@openworkflow/runtime';
import { createIfNodeSpec } from '@openworkflow/nodes';
import { MemoryStore } from '@openworkflow/store-memory';
import { createWorkflowHandlers, createNodeHttpHandler } from '@openworkflow/server';
import { defineNode } from '@openworkflow/core';
import { z } from 'zod';

// ── Build an engine ─────────────────────────────────────────────────────────
const engine = new WorkflowEngine({
  store: new MemoryStore(),
  llmFactory: { createModel: () => ({ invoke: async () => ({ content: '' }) }) },
});
engine.registerNode(createIfNodeSpec());
engine.registerNode(
  defineNode({
    key: 'tool.greet',
    nodeType: 'TOOL',
    displayName: 'Greet',
    description: 'Greets a name.',
    icon: 'hand',
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ kind: z.literal('tool.greet'), text: z.string() }),
    handler: async ({ name }) => ({ kind: 'tool.greet' as const, text: `Hello, ${name}!` }),
  }),
);

// ── Boot the http server ────────────────────────────────────────────────────
const handlers = createWorkflowHandlers(engine);
const server = createServer(createNodeHttpHandler(handlers));
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;
const base = `http://localhost:${port}/workflow`;
console.log(`server listening on ${base}`);

// ── Drive it over the wire ──────────────────────────────────────────────────
// 1. Save
const saveRes = await fetch(base, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'greeter',
    nodes: [
      {
        id: 'g',
        nodeType: 'TOOL',
        key: 'tool.greet',
        label: 'Greet',
        inputs: { name: { kind: 'literal', value: 'OpenWorkflow' } },
      },
    ],
    edges: [],
  }),
});
const { workflowId } = (await saveRes.json()) as { workflowId: string };
console.log('saved workflowId:', workflowId);

// 2. Stream a run via SSE
console.log('\n── SSE events ──');
const streamRes = await fetch(`${base}/runs/x/stream?workflowId=${workflowId}`);
const reader = streamRes.body!.getReader();
const decoder = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split('\n\n');
  buf = frames.pop() ?? '';
  for (const frame of frames) {
    if (frame.trim()) console.log(' ', frame.replace(/\n/g, ' '));
  }
}

// 3. List runs
const runsRes = await fetch(`${base}/${workflowId}/runs`);
const runs = (await runsRes.json()) as unknown[];
console.log('\nlistRuns:', JSON.stringify(runs));

server.close();
console.log('\ndone.');
