import { HumanMessage } from '@langchain/core/messages';
import { NOOP_LOGGER, PipelineAbortedError } from '@openpipeline/core';
import { describe, expect, it } from 'vitest';

import { designNode } from '../src/nodes/design.node.js';
import { PipelinePlanner } from '../src/planner.js';
import type { PlannerRuntime } from '../src/runtime.js';
import type { PlannerState } from '../src/state.js';
import type { PlannerProgressEvent } from '../src/types.js';

import { FakeChatModel, makeLlmFactory } from './helpers/fake-chat-model.js';
import { echoSpec, shoutSpec, testSpecs } from './helpers/fixtures.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Unanchored counterpart of UUID_RE for "must not contain a UUID anywhere in
// this (possibly multi-line) string" assertions. UUID_RE is anchored
// (`^...$`, no `/m`), so `.not.toMatch(UUID_RE)` against a multi-line prompt
// is vacuously true regardless of content — it only ever matches a string
// that IS, in its entirety, a bare UUID (T1 review I2). Use this one for the
// negative/"must not leak" direction; keep UUID_RE for exact-value equality
// checks like `expect(node.id).toMatch(UUID_RE)`.
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A valid 2-node draft: n1 (echo, literal input) -> n2 (shout, reads n1's output). */
function validRawDraft(): unknown {
  return {
    nodes: [
      {
        id: 'n1',
        key: echoSpec.key,
        label: 'Echo',
        inputs: { text: { kind: 'literal', value: 'hello' } },
      },
      {
        id: 'n2',
        key: shoutSpec.key,
        label: 'Shout',
        inputs: { text: { kind: 'state', path: 'outputs.n1.text' } },
      },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };
}

/** Same n1/n2 as `validRawDraft`, but n1's outgoing edge dangles to a never-declared "n3". */
function danglingEdgeRawDraft(): unknown {
  const draft = validRawDraft() as { nodes: unknown[]; edges: unknown[] };
  return { nodes: draft.nodes, edges: [{ from: 'n1', to: 'n3' }] };
}

function findHumanMessageText(messages: readonly unknown[]): string {
  const human = messages.find((m) => m instanceof HumanMessage);
  if (!human) throw new Error('test fixture bug: no HumanMessage found in captured call');
  const { content } = human as HumanMessage;
  if (typeof content !== 'string') {
    throw new Error('test fixture bug: expected HumanMessage content to be a plain string');
  }
  return content;
}

describe('PipelinePlanner.plan — no-MCP core loop', () => {
  it('(a) happy path: a valid 2-node draft resolves on the first attempt with UUIDs, positions, no warnings', async () => {
    const model = new FakeChatModel([validRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(1);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(result.plannerWarnings).toBeUndefined();
    expect(result.draft.nodes).toHaveLength(2);
    expect(result.draft.edges).toHaveLength(1);

    for (const node of result.draft.nodes) {
      expect(node.id).toMatch(UUID_RE);
      expect(typeof node.positionX).toBe('number');
      expect(typeof node.positionY).toBe('number');
    }
    const [n1, n2] = result.draft.nodes;
    expect(result.draft.edges[0]?.fromNodeId).toBe(n1?.id);
    expect(result.draft.edges[0]?.toNodeId).toBe(n2?.id);
    // The state binding was rewritten from the short id to n1's persisted UUID.
    expect(n2?.inputs['text']).toEqual({ kind: 'state', path: `outputs.${String(n1?.id)}.text` });
  });

  it('(b) correction loop: a dangling edge fails validation, feedback uses short ids, then the fixed draft succeeds on attempt 2', async () => {
    const model = new FakeChatModel([danglingEdgeRawDraft(), validRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(2);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(result.draft.nodes).toHaveLength(2);

    expect(model.calls).toHaveLength(2);
    const secondPrompt = findHumanMessageText(model.calls[1]?.messages ?? []);
    // The dangling edge's target ("n3") is referenced by its SHORT id in the
    // feedback the model sees — never by the internal persisted UUID (D4),
    // and never by the edge's own internal id either (T1 review I1).
    expect(secondPrompt).toContain('n3');
    expect(secondPrompt).not.toMatch(UUID_ANYWHERE_RE);
  });

  it('(c) maxAttempts exhaustion: always-invalid responses end with unresolvedValidationErrors and the last draft', async () => {
    const model = new FakeChatModel([danglingEdgeRawDraft()]); // repeats — always invalid
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      maxAttempts: 3,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(3);
    expect(result.unresolvedValidationErrors).toBeDefined();
    expect(result.unresolvedValidationErrors?.length ?? 0).toBeGreaterThan(0);
    expect(result.draft).toBeDefined();
    expect(result.draft.nodes).toHaveLength(2);
    // Two design calls were actually made (attempts 1 and 2); the third
    // increment (to 3) is what trips the `>= maxAttempts` exhaustion check.
    expect(model.calls).toHaveLength(2);
  });

  it('(e) an abort signal fired between nodes rejects with PipelineAbortedError', async () => {
    const model = new FakeChatModel([validRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });
    const controller = new AbortController();
    const onProgress = (event: PlannerProgressEvent): void => {
      // Fires synchronously at design's entry, before the fake LLM call —
      // design itself still completes normally, but validate's own
      // checkAbort() (its entry, i.e. "between nodes") must catch it next.
      if (event.phase === 'design') controller.abort();
    };

    await expect(
      planner.plan({ instruction: 'x', signal: controller.signal, onProgress })
    ).rejects.toBeInstanceOf(PipelineAbortedError);
  });

  it('(e-upfront) an already-aborted signal rejects before ever calling the model', async () => {
    const model = new FakeChatModel([validRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      planner.plan({ instruction: 'x', signal: controller.signal })
    ).rejects.toBeInstanceOf(PipelineAbortedError);
    expect(model.calls).toHaveLength(0);
  });

  it('(f) the design LLM is invoked via withStructuredOutput(..., { method: "functionCalling" })', async () => {
    const model = new FakeChatModel([validRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });

    await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.method).toBe('functionCalling');
  });
});

describe('PipelinePlanner — constructor guards', () => {
  it('throws synchronously when a modelId is not provided', () => {
    expect(
      () =>
        new PipelinePlanner({
          llmFactory: makeLlmFactory(new FakeChatModel([validRawDraft()])),
          modelId: '',
          specs: testSpecs,
        })
    ).toThrow(/modelId is required/);
  });

  it('throws synchronously when catalogLoader is supplied (no-MCP path only in this build)', () => {
    expect(
      () =>
        new PipelinePlanner({
          llmFactory: makeLlmFactory(new FakeChatModel([validRawDraft()])),
          modelId: 'test-model',
          specs: testSpecs,
          catalogLoader: {
            load: () => Promise.resolve({ providers: [], cleanup: () => Promise.resolve() }),
          },
        })
    ).toThrow(/catalogLoader/);
  });
});

describe('design node — idMap stability across attempts (D4)', () => {
  it('(d) a node whose short id is reused across two design calls keeps the same persisted UUID', async () => {
    const draftAttempt1 = {
      nodes: [
        {
          id: 'n1',
          key: echoSpec.key,
          label: 'Echo',
          inputs: { text: { kind: 'literal', value: 'first' } },
        },
      ],
      edges: [],
    };
    const draftAttempt2 = {
      nodes: [
        {
          id: 'n1',
          key: echoSpec.key,
          label: 'Echo',
          inputs: { text: { kind: 'literal', value: 'second' } },
        },
      ],
      edges: [],
    };
    const model = new FakeChatModel([draftAttempt1, draftAttempt2]);
    const runtime: PlannerRuntime = {
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      temperature: 0.3,
      specs: testSpecs,
      logger: NOOP_LOGGER,
    };

    const state1: PlannerState = {
      instruction: 'echo something',
      attempts: 1,
      idMap: {},
      validationIssues: [],
      plannerWarnings: [],
    };
    const result1 = await designNode(state1, runtime);
    const uuidAfterAttempt1 = result1.idMap?.['n1'];
    expect(uuidAfterAttempt1).toMatch(UUID_RE);
    expect(result1.draft?.nodes[0]?.id).toBe(uuidAfterAttempt1);

    // Simulate exactly what the real graph's `idMap` reducer does between
    // attempts: merge the previous attempt's idMap into the next state.
    const state2: PlannerState = {
      ...state1,
      attempts: 2,
      idMap: result1.idMap ?? {},
      designFeedback: 'please retry',
    };
    const result2 = await designNode(state2, runtime);
    const uuidAfterAttempt2 = result2.idMap?.['n1'];

    expect(uuidAfterAttempt2).toBe(uuidAfterAttempt1);
    expect(result2.draft?.nodes[0]?.id).toBe(uuidAfterAttempt1);
  });
});
