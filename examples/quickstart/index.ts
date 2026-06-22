/**
 * OpenPipeline quickstart — runs a 3-node DAG with zero database and zero LLM
 * API keys. Demonstrates: a custom node, an IF branch, and the engine loop.
 *
 *   upper ──> gate ──true──> shout
 *                  └─false─> skipped
 *
 * The IF condition reads the custom node's output via a `state` binding. Both
 * branches point at a real node (an IF requires a true AND a false target).
 */
import { defineNode } from '@openpipeline/core';
import { createIfNodeSpec, createLlmInvokeNodeSpec } from '@openpipeline/nodes';
import { PipelineEngine } from '@openpipeline/runtime';
import { MemoryStore } from '@openpipeline/store-memory';
import { z } from 'zod';

// A trivial LlmFactory stub so llm.invoke works without API keys.
// In a real app this returns a LangChain BaseChatModel.
const stubLlmFactory = {
  createModel: () => ({
    // No real network call here, so we return a resolved Promise rather than
    // marking the function `async` — it still satisfies the Promise-returning
    // `.invoke()` contract that the LLM node awaits.
    invoke: (messages: unknown[]) =>
      Promise.resolve({
        content: `(stub echo) ${JSON.stringify(messages).slice(0, 80)}`,
        usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
  }),
};

const engine = new PipelineEngine({
  store: new MemoryStore(),
  llmFactory: stubLlmFactory,
  logger: console,
});

// Register built-ins + one custom node.
engine.registerNode(createIfNodeSpec());
engine.registerNode(
  createLlmInvokeNodeSpec({ models: ['stub-model'], defaultModel: 'stub-model' })
);
engine.registerNode(
  defineNode({
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
    // Synchronous work, but the handler contract is Promise-returning, so we
    // resolve immediately instead of using a redundant `async`.
    handler: ({ text }) => {
      const out = text.toUpperCase();
      return Promise.resolve({ kind: 'tool.uppercase' as const, out, nonEmpty: out.length > 0 });
    },
  })
);

const pipelineId = await engine.save({
  name: 'uppercase-then-branch',
  nodes: [
    {
      id: 'upper',
      nodeType: 'TOOL',
      key: 'tool.uppercase',
      label: 'Uppercase',
      inputs: { text: { kind: 'literal', value: 'hello openpipeline' } },
    },
    {
      id: 'gate',
      nodeType: 'IF',
      key: 'control.if',
      label: 'Has output?',
      inputs: { condition: { kind: 'state', path: 'outputs.upper.nonEmpty' } },
    },
    {
      id: 'shout',
      nodeType: 'LLM',
      key: 'llm.invoke',
      label: 'Comment',
      inputs: {
        userPrompt: { kind: 'state', path: 'outputs.upper.out' },
        model: { kind: 'literal', value: 'stub-model' },
      },
    },
    {
      id: 'skipped',
      nodeType: 'TOOL',
      key: 'tool.uppercase',
      label: 'Skipped (false branch)',
      inputs: { text: { kind: 'literal', value: 'this branch is not taken' } },
    },
  ],
  edges: [
    { id: 'e1', fromNodeId: 'upper', toNodeId: 'gate' },
    { id: 'e2', fromNodeId: 'gate', toNodeId: 'shout', label: 'true' },
    { id: 'e3', fromNodeId: 'gate', toNodeId: 'skipped', label: 'false' },
  ],
});

const { runId, done } = await engine.run({ pipelineId });
const result = await done;

console.log('\n── Result ──────────────────────────────');
console.log('runId:', runId);
console.log('status:', result.status);
console.log('outputs:', JSON.stringify(result.outputs, null, 2));
console.log('cost:', result.cost);
