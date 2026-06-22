import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PipelineEngine } from '@openpipeline/runtime';
import { createIfNodeSpec, createLlmInvokeNodeSpec } from '@openpipeline/nodes';
import { MemoryStore } from '@openpipeline/store-memory';
import { defineNode } from '@openpipeline/core';

// End-to-end integration test against the BUILT packages (run `pnpm build`
// first — CI builds before test). Exercises save -> run -> done through the
// real engine, compiler, and LangGraph, with an in-memory store and a stub LLM.

const stubLlmFactory = {
  createModel: () => ({
    invoke: async () => ({
      content: 'stub reply',
      usage_metadata: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }),
  }),
};

function makeEngine() {
  const engine = new PipelineEngine({ store: new MemoryStore(), llmFactory: stubLlmFactory });
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
      handler: async ({ text }) => {
        const out = text.toUpperCase();
        return { kind: 'tool.uppercase' as const, out, nonEmpty: out.length > 0 };
      },
    })
  );
  return engine;
}

describe('PipelineEngine end-to-end', () => {
  it('runs a single TOOL node to SUCCESS and returns its output', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'just-upper',
      nodes: [
        {
          id: 'upper',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Uppercase',
          inputs: { text: { kind: 'literal', value: 'hello' } },
        },
      ],
      edges: [],
    });

    const { done } = await engine.run({ pipelineId });
    const result = await done;

    expect(result.status).toBe('SUCCESS');
    expect(result.outputs.upper).toMatchObject({ out: 'HELLO', nonEmpty: true });
  });

  it('flows an IF gate down the TRUE branch and skips the FALSE branch', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'upper-then-branch',
      nodes: [
        {
          id: 'upper',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Uppercase',
          inputs: { text: { kind: 'literal', value: 'hello' } },
        },
        {
          id: 'gate',
          nodeType: 'IF',
          key: 'control.if',
          label: 'Has output?',
          inputs: { condition: { kind: 'state', path: 'outputs.upper.nonEmpty' } },
        },
        {
          id: 'taken',
          nodeType: 'LLM',
          key: 'llm.invoke',
          label: 'Taken',
          inputs: {
            userPrompt: { kind: 'state', path: 'outputs.upper.out' },
            model: { kind: 'literal', value: 'stub-model' },
          },
        },
        {
          id: 'skipped',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Skipped',
          inputs: { text: { kind: 'literal', value: 'not taken' } },
        },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'upper', toNodeId: 'gate' },
        { id: 'e2', fromNodeId: 'gate', toNodeId: 'taken', label: 'true' },
        { id: 'e3', fromNodeId: 'gate', toNodeId: 'skipped', label: 'false' },
      ],
    });

    const { done } = await engine.run({ pipelineId });
    const result = await done;

    expect(result.status).toBe('SUCCESS');
    expect(result.outputs.gate).toMatchObject({ branch: 'true' });
    expect(result.outputs.taken).toBeDefined();
    expect(result.outputs.skipped).toBeUndefined(); // false branch never ran
  });

  it('accumulates LLM token cost across the run', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'just-llm',
      nodes: [
        {
          id: 'say',
          nodeType: 'LLM',
          key: 'llm.invoke',
          label: 'Say',
          inputs: {
            userPrompt: { kind: 'literal', value: 'hi' },
            model: { kind: 'literal', value: 'stub-model' },
          },
        },
      ],
      edges: [],
    });

    const result = await (await engine.run({ pipelineId })).done;
    expect(result.status).toBe('SUCCESS');
    expect(result.cost.tokens.total).toBe(6);
    expect(result.cost.llmCalls).toBe(1);
  });

  it('fails (not throws) when the graph is a pure cycle with no entry node', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'cyclic',
      nodes: [
        {
          id: 'a',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'A',
          inputs: { text: { kind: 'literal', value: 'x' } },
        },
        {
          id: 'b',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'B',
          inputs: { text: { kind: 'literal', value: 'y' } },
        },
      ],
      edges: [
        { id: 'e1', fromNodeId: 'a', toNodeId: 'b' },
        { id: 'e2', fromNodeId: 'b', toNodeId: 'a' },
      ],
    });

    const result = await (await engine.run({ pipelineId })).done;
    expect(result.status).toBe('FAILED');
    expect(result.error).toBeDefined();
  });

  it('streams NODE_START/NODE_END and RUN_COMPLETE events via onEvent', async () => {
    const engine = makeEngine();
    const pipelineId = await engine.save({
      name: 'evented',
      nodes: [
        {
          id: 'upper',
          nodeType: 'TOOL',
          key: 'tool.uppercase',
          label: 'Uppercase',
          inputs: { text: { kind: 'literal', value: 'hello' } },
        },
      ],
      edges: [],
    });

    const { runId, done } = await engine.run({ pipelineId });
    const kinds: string[] = [];
    engine.onEvent(runId, (evt) => kinds.push(evt.kind));
    await done;

    expect(kinds).toContain('RUN_COMPLETE');
  });
});
