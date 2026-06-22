/**
 * @openpipeline/server demo — boots a real Node http server, then exercises it
 * over the wire: save a pipeline, stream a run via SSE, list runs. No external
 * deps beyond the OpenPipeline packages.
 */
import { createServer } from 'node:http';

import { defineNode } from '@openpipeline/core';
import { createIfNodeSpec } from '@openpipeline/nodes';
import { PipelineEngine } from '@openpipeline/runtime';
import { createPipelineHandlers, createNodeHttpHandler } from '@openpipeline/server';
import { MemoryStore } from '@openpipeline/store-memory';
import { z } from 'zod';

// ── Build an engine ─────────────────────────────────────────────────────────
const engine = new PipelineEngine({
  store: new MemoryStore(),
  llmFactory: { createModel: () => ({ invoke: () => Promise.resolve({ content: '' }) }) },
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
    handler: ({ name }) =>
      Promise.resolve({ kind: 'tool.greet' as const, text: `Hello, ${name}!` }),
  })
);

// ── Boot the http server ────────────────────────────────────────────────────
const handlers = createPipelineHandlers(engine);
const server = createServer(createNodeHttpHandler(handlers));
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (address === null || typeof address === 'string') {
  throw new Error('expected the http server to bind to a TCP port');
}
const base = `http://localhost:${String(address.port)}/pipeline`;
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
        inputs: { name: { kind: 'literal', value: 'OpenPipeline' } },
      },
    ],
    edges: [],
  }),
});
const { pipelineId } = (await saveRes.json()) as { pipelineId: string };
console.log('saved pipelineId:', pipelineId);

// 2. Stream a run via SSE
console.log('\n── SSE events ──');
const streamRes = await fetch(`${base}/runs/x/stream?pipelineId=${pipelineId}`);
if (streamRes.body === null) {
  throw new Error('SSE response had no body to stream');
}
const reader = streamRes.body.getReader();
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
const runsRes = await fetch(`${base}/${pipelineId}/runs`);
const runs = (await runsRes.json()) as unknown[];
console.log('\nlistRuns:', JSON.stringify(runs));

server.close();
console.log('\ndone.');
