// The playground backend: an OpenPipeline engine + node catalog + the HTTP/SSE
// handlers. Mounted as Vite dev middleware (see vite.config.ts) so `pnpm dev`
// serves both the API and the React app from one process. This same wiring works
// behind Express/Fastify in production.
import { PipelineEngine } from '@openpipeline/runtime';
import { createIfNodeSpec, createLlmInvokeNodeSpec } from '@openpipeline/nodes';
import { MemoryStore } from '@openpipeline/store-memory';
import { createPipelineHandlers, createNodeHttpHandler } from '@openpipeline/server';
import { defineNode } from '@openpipeline/core';
import type { NodeSpecDescriptor } from '@openpipeline/react';
import { z } from 'zod';

// A couple of demo tool nodes so the palette has something to offer.
const upperNode = defineNode({
  key: 'tool.uppercase',
  nodeType: 'TOOL',
  displayName: 'Uppercase',
  description: 'Uppercases its input text.',
  icon: 'type',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({
    kind: z.literal('tool.uppercase'),
    out: z.string(),
    nonEmpty: z.boolean(),
  }),
  handler: async ({ text }) => ({
    kind: 'tool.uppercase' as const,
    out: text.toUpperCase(),
    nonEmpty: text.length > 0,
  }),
});

const reverseNode = defineNode({
  key: 'tool.reverse',
  nodeType: 'TOOL',
  displayName: 'Reverse',
  description: 'Reverses its input text.',
  icon: 'flip-horizontal',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ kind: z.literal('tool.reverse'), out: z.string() }),
  handler: async ({ text }) => ({
    kind: 'tool.reverse' as const,
    out: [...text].reverse().join(''),
  }),
});

export function createBackend() {
  const engine = new PipelineEngine({
    store: new MemoryStore(),
    // A stub LLM so llm.invoke works without API keys in the demo.
    llmFactory: {
      createModel: () => ({
        invoke: async (m: unknown) => ({
          content: `(demo) ${JSON.stringify(m).slice(0, 60)}`,
          usage_metadata: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        }),
      }),
    },
  });

  engine.registerNode(createIfNodeSpec());
  engine.registerNode(
    createLlmInvokeNodeSpec({ models: ['demo-model'], defaultModel: 'demo-model' })
  );
  engine.registerNode(upperNode);
  engine.registerNode(reverseNode);

  // The node-spec catalog the builder palette/inspector renders.
  const catalog: NodeSpecDescriptor[] = [
    {
      key: 'tool.uppercase',
      nodeType: 'TOOL',
      displayName: 'Uppercase',
      description: 'Uppercases text.',
      icon: 'type',
      inputs: [{ name: 'text', required: true }],
    },
    {
      key: 'tool.reverse',
      nodeType: 'TOOL',
      displayName: 'Reverse',
      description: 'Reverses text.',
      icon: 'flip-horizontal',
      inputs: [{ name: 'text', required: true }],
    },
    {
      key: 'control.if',
      nodeType: 'IF',
      displayName: 'IF',
      description: 'Branch on a condition.',
      icon: 'git-branch',
      inputs: [{ name: 'condition', required: false }],
    },
    {
      key: 'llm.invoke',
      nodeType: 'LLM',
      displayName: 'LLM',
      description: 'Invoke a model.',
      icon: 'sparkles',
      inputs: [
        { name: 'userPrompt', required: true },
        { name: 'model', required: true },
      ],
    },
  ];

  const handlers = createPipelineHandlers(engine);
  const httpHandler = createNodeHttpHandler(handlers);

  // Seed a starter pipeline so the canvas isn't empty on first load.
  const seedId = engine.save({
    name: 'starter',
    nodes: [
      {
        id: 'u',
        nodeType: 'TOOL',
        key: 'tool.uppercase',
        label: 'Uppercase',
        inputs: { text: { kind: 'literal', value: 'hello openpipeline' } },
      },
      {
        id: 'r',
        nodeType: 'TOOL',
        key: 'tool.reverse',
        label: 'Reverse',
        inputs: { text: { kind: 'state', path: 'outputs.u.out' } },
      },
    ],
    edges: [{ id: 'e1', fromNodeId: 'u', toNodeId: 'r' }],
  });

  return { engine, catalog, httpHandler, seedId };
}
