/**
 * OpenPipeline planner quickstart — turns a natural-language instruction into
 * a runnable pipeline end to end:
 *
 *   instruction ──> PipelinePlanner.plan() ──> PipelineDraft
 *                                                 │
 *                                                 ▼
 *                                   engine.save(draft) ──> engine.run()
 *
 * The DESIGNED pipeline is the exact same "uppercase -> branch" shape
 * `examples/quickstart` hand-authors — same `MemoryStore`, same `control.if` /
 * `llm.invoke` / `tool.uppercase` specs — the only difference is that the
 * graph here comes FROM the planner instead of being written by hand.
 *
 * Two LLM factories, deliberately kept separate:
 * - `plannerLlmFactory` drives the planner's structured-output DESIGN call
 *   (`withStructuredOutput(PlannerDraftSchema, ...)`).
 * - `stubLlmFactory` drives the DESIGNED pipeline's own `llm.invoke` node at
 *   RUN time (a plain `.invoke(messages) -> { content }`, no structured
 *   output — identical to `examples/quickstart`'s stub).
 * A real deployment can point both at the same real chat model; they're kept
 * separate here only because the fakes below need different response shapes.
 *
 * To keep this example hermetic (zero API keys, fully deterministic — CI runs
 * this on every push), we supply a MINIMAL FAKE structured-output model that
 * returns one canned `PlannerDraft` regardless of the prompt. It is NOT a
 * re-export of `packages/planner/test/helpers/fake-chat-model.ts` — that file
 * is test-only and outside the published package, exactly like it would be
 * for any other consumer, so this example writes its own minimal stand-in
 * instead.
 *
 * ── REAL mode ────────────────────────────────────────────────────────────
 * For a real LLM, swap `plannerLlmFactory` for any LangChain `BaseChatModel`
 * that implements `withStructuredOutput(...)` (e.g. `@langchain/openai`'s
 * `ChatOpenAI`), reading its API key from the environment. This example
 * itself NEVER makes a network call — that is a deliberate property of the
 * CI smoke, not a limitation of the planner:
 *
 *   import { ChatOpenAI } from '@langchain/openai';
 *   import type { LlmFactory } from '@openpipeline/core';
 *
 *   const plannerLlmFactory: LlmFactory = {
 *     createModel: (modelId, overrides) =>
 *       new ChatOpenAI({ model: modelId, apiKey: process.env.OPENAI_API_KEY, ...overrides }),
 *   };
 *   const planner = new PipelinePlanner({
 *     llmFactory: plannerLlmFactory,
 *     modelId: 'gpt-4o',
 *     specs: () => registry.list(),
 *   });
 *
 * `OPENAI_API_KEY` (or your provider's equivalent, e.g. `ANTHROPIC_API_KEY`)
 * is the only environment variable a real run needs — `modelId` is passed
 * straight through to `createModel`, so any provider/model your `LlmFactory`
 * supports works, and the MCP tool-selection path (`catalogLoader` +
 * `mcpNodeResolver`, see `examples/mcp` and the planner README) layers on top
 * unchanged.
 */
import { defineNode, type LlmFactory } from '@openpipeline/core';
import { createIfNodeSpec, createLlmInvokeNodeSpec, NodeSpecRegistry } from '@openpipeline/nodes';
import { PipelinePlanner } from '@openpipeline/planner';
import { PipelineEngine } from '@openpipeline/runtime';
import { MemoryStore } from '@openpipeline/store-memory';
import { z } from 'zod';

// ── Node specs (identical to examples/quickstart) ───────────────────────────
const ifSpec = createIfNodeSpec();
const llmSpec = createLlmInvokeNodeSpec({ models: ['stub-model'], defaultModel: 'stub-model' });
const uppercaseSpec = defineNode({
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
  handler: ({ text }) => {
    const out = text.toUpperCase();
    return Promise.resolve({ kind: 'tool.uppercase' as const, out, nonEmpty: out.length > 0 });
  },
});

// `NodeSpecRegistry` is the sanctioned way to hand a planner a mix of
// differently-typed `NodeSpec<TInput, TOutput>`s as one `NodeSpec[]` — its own
// `register()` does the (deliberate, contained) generic-widening cast
// `@openpipeline/planner`'s `PlannerSpecsInput` doc comment points at
// (`specs: () => registry.list()`), so this example never needs an unsound
// cast of its own to build the array by hand.
const registry = new NodeSpecRegistry();
registry.register(ifSpec);
registry.register(llmSpec);
registry.register(uppercaseSpec);

// ── Minimal fake structured-output model for the planner (no API key) ──────
// Always returns the SAME 4-node draft `examples/quickstart` hand-authors —
// this example's point is the plan -> save -> run plumbing, not prompt
// engineering, so a single canned response keeps `pnpm example:planner`
// deterministic.
function plannerDraftResponse(): unknown {
  return {
    nodes: [
      {
        id: 'n1',
        key: uppercaseSpec.key,
        label: 'Uppercase',
        inputs: { text: { kind: 'literal', value: 'hello openpipeline' } },
      },
      {
        id: 'n2',
        key: ifSpec.key,
        label: 'Has output?',
        inputs: { condition: { kind: 'state', path: 'outputs.n1.nonEmpty' } },
      },
      {
        id: 'n3',
        key: llmSpec.key,
        label: 'Comment',
        inputs: {
          userPrompt: { kind: 'state', path: 'outputs.n1.out' },
          model: { kind: 'literal', value: 'stub-model' },
        },
      },
      {
        id: 'n4',
        key: uppercaseSpec.key,
        label: 'Skipped (false branch)',
        inputs: { text: { kind: 'literal', value: 'this branch is not taken' } },
      },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3', label: 'true' },
      { from: 'n2', to: 'n4', label: 'false' },
    ],
  };
}

class FakeStructuredOutputModel {
  // `_schema`/`_config` are ignored — deliberately un-typed to the real
  // `withStructuredOutput` signature (no `@langchain/core` dependency needed
  // for this minimal fake); the planner narrows structurally at runtime, not
  // by this class implementing an imported interface.
  withStructuredOutput(
    _schema: unknown,
    _config?: { method?: string }
  ): { invoke: (input: unknown) => Promise<unknown> } {
    return { invoke: () => Promise.resolve(plannerDraftResponse()) };
  }
}

const plannerLlmFactory: LlmFactory = {
  createModel: () => new FakeStructuredOutputModel(),
};

// ── Plan: instruction -> PipelinePlanner.plan() -> PipelineDraft ───────────
const planner = new PipelinePlanner({
  llmFactory: plannerLlmFactory,
  modelId: 'fake-planner-model',
  specs: () => registry.list(),
  logger: console,
});

const planResult = await planner.plan({
  instruction:
    'Uppercase "hello openpipeline", branch on whether it produced any output, and comment on it with an LLM when it did.',
});

console.log('\n── Plan ─────────────────────────────────');
console.log('attempts:', planResult.attempts);
console.log('plannerWarnings:', planResult.plannerWarnings ?? []);
console.log(
  'draft:',
  planResult.draft.nodes.length,
  'nodes,',
  planResult.draft.edges.length,
  'edges'
);

// ── Run: engine.save(draft) -> engine.run() ─────────────────────────────────
// Same MemoryStore + stub llm.invoke as examples/quickstart — the planner's
// OUTPUT executes exactly like a hand-authored draft; nothing downstream of
// `plan()` needs to know a pipeline came from an LLM instead of a person.
const stubLlmFactory: LlmFactory = {
  createModel: () => ({
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
engine.registerNode(ifSpec);
engine.registerNode(llmSpec);
engine.registerNode(uppercaseSpec);

const pipelineId = await engine.save(planResult.draft);
const { runId, done } = await engine.run({ pipelineId });
const result = await done;

console.log('\n── Result ──────────────────────────────');
console.log('runId:', runId);
console.log('status:', result.status);
console.log('outputs:', JSON.stringify(result.outputs, null, 2));
console.log('cost:', result.cost);
