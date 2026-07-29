import { OutputParserException } from '@langchain/core/output_parsers';
import { NOOP_LOGGER, PipelineAbortedError } from '@openpipeline/core';
import { describe, expect, it, vi } from 'vitest';

import { designNode } from '../src/nodes/design.node.js';
import { PipelinePlanner } from '../src/planner.js';
import { buildSpecCatalogText } from '../src/prompts.js';
import type { PlannerRuntime } from '../src/runtime.js';
import type { PlannerState } from '../src/state.js';
import type { PlannerProgressEvent } from '../src/types.js';

import {
  FakeChatModel,
  InvokeRejectingChatModel,
  makeLlmFactory,
} from './helpers/fake-chat-model.js';
import { echoSpec, shoutSpec, testSpecs, unconvertibleSpec } from './helpers/fixtures.js';
import { findHumanMessageText } from './helpers/messages.js';

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

/** Two distinct nodes both authored with the short id "n1" — an LLM mistake, not a correction-round id reuse. */
function duplicateNodeIdRawDraft(): unknown {
  return {
    nodes: [
      {
        id: 'n1',
        key: echoSpec.key,
        label: 'Echo A',
        inputs: { text: { kind: 'literal', value: 'a' } },
      },
      {
        id: 'n1',
        key: shoutSpec.key,
        label: 'Echo B',
        inputs: { text: { kind: 'literal', value: 'b' } },
      },
    ],
    edges: [],
  };
}

/** A malformed structured-output payload that fails `PlannerDraftSchema.parse` (empty `nodes`, min(1)). */
function malformedRawDraft(): unknown {
  return { nodes: [], edges: [] };
}

/**
 * Stubs `crypto.randomUUID` with a deterministic counter so a test can assert
 * exactly which minted id ends up where (T1 review round 3, M2). Returns the
 * ids minted so far (in minting order) and a restore function — always call
 * `restore()`, even on failure, since this replaces a real Node global.
 */
function stubSequentialUuids(): {
  minted: string[];
  restore: () => void;
} {
  const minted: string[] = [];
  let counter = 0;
  const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    counter += 1;
    // Not a "real" UUID, but structurally shaped like one (5 dash-separated
    // groups) so it can't be confused with a short id, matching what the
    // production code's own return-type contract requires here.
    const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}` as ReturnType<
      typeof crypto.randomUUID
    >;
    minted.push(id);
    return id;
  });
  return {
    minted,
    restore: () => {
      spy.mockRestore();
    },
  };
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

    // T1 review round 3, M2: cross-attempt UUID stability (D4) was only
    // proven one level below the public API (test (d) calls `designNode`
    // directly). Stubbing the id source here and asserting against the
    // *first* minted UUID exercises `state.ts`'s `idMap` merge reducer for
    // real: if it didn't survive the correction round, attempt 2 would mint
    // a FRESH uuid for "n1" instead of reusing the first one.
    const { minted, restore } = stubSequentialUuids();
    let result: Awaited<ReturnType<typeof planner.plan>>;
    try {
      result = await planner.plan({ instruction: 'Echo some text, then shout it.' });
    } finally {
      restore();
    }

    expect(result.attempts).toBe(2);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(result.draft.nodes).toHaveLength(2);
    // n1 is the first short id `buildIdAssignment` resolves on attempt 1, so
    // the first uuid minted must be the one that survives into the final draft.
    expect(result.draft.nodes[0]?.id).toBe(minted[0]);

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
    // maxAttempts=3 design calls are actually made (T1 review I3: the
    // `correct` node gates on `maxAttempts` BEFORE incrementing `attempts`,
    // so `attempts` and "design calls made" never diverge, and exhaustion
    // never costs a `design` call the way a post-increment gate would).
    expect(model.calls).toHaveLength(3);
  });

  it('(c2) maxAttempts=2 performs one correction round (T1 review I3: previously a dead setting identical to maxAttempts=1)', async () => {
    const model = new FakeChatModel([danglingEdgeRawDraft(), danglingEdgeRawDraft()]); // repeats — always invalid
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      maxAttempts: 2,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(2);
    expect(result.unresolvedValidationErrors).toBeDefined();
    // Two design calls, not one: maxAttempts=2 must actually spend its one
    // correction round, proving it is behaviorally distinct from
    // maxAttempts=1 rather than the pre-fix off-by-one collapsing both to a
    // single design call.
    expect(model.calls).toHaveLength(2);
  });

  it('(c1) maxAttempts=1 performs zero correction rounds (a single design call, no feedback sent)', async () => {
    const model = new FakeChatModel([danglingEdgeRawDraft()]); // never consulted a second time
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      maxAttempts: 1,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(1);
    expect(result.unresolvedValidationErrors).toBeDefined();
    expect(model.calls).toHaveLength(1);
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

  it('(g) maxAttempts above the LangGraph default recursion-limit budget still exhausts cleanly (T1 review round 2, I1)', async () => {
    // 3 super-steps (design -> validate -> correct) per round; LangGraph's
    // default recursionLimit of 25 caps out around maxAttempts=8 without an
    // explicit override. maxAttempts=12 would previously reject with a raw
    // GraphRecursionError after burning 9 real design calls instead of
    // returning the documented exhaustion PlannerResult.
    const model = new FakeChatModel([danglingEdgeRawDraft()]); // repeats — always invalid
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      maxAttempts: 12,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(12);
    expect(result.unresolvedValidationErrors).toBeDefined();
    expect(result.unresolvedValidationErrors?.length ?? 0).toBeGreaterThan(0);
    // All 12 design calls actually happened -- the loop was not silently
    // truncated by an unstated internal recursion ceiling.
    expect(model.calls).toHaveLength(12);
  });

  it('(h) plannerWarnings from a non-convertible spec appear exactly once across a multi-attempt run (T1 review round 2, I3)', async () => {
    const model = new FakeChatModel([
      danglingEdgeRawDraft(),
      danglingEdgeRawDraft(),
      validRawDraft(),
    ]);
    const specsWithUnconvertible = [...testSpecs, unconvertibleSpec];
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: specsWithUnconvertible,
      maxAttempts: 3,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    // Three design attempts were made (two dangling-edge failures, then a
    // valid draft), so a per-attempt-recomputed catalog would have produced
    // three byte-identical warnings. Exactly one must survive.
    expect(model.calls).toHaveLength(3);
    expect(result.plannerWarnings).toHaveLength(1);
    expect(result.plannerWarnings?.[0]).toContain('tool.unconvertible');
  });

  it('(i) duplicate short ids from the LLM produce a clear correction instead of a misleading TOPOLOGY_CYCLE (T1 review round 3, M5)', async () => {
    const model = new FakeChatModel([duplicateNodeIdRawDraft(), validRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(2);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(model.calls).toHaveLength(2);
    const secondPrompt = findHumanMessageText(model.calls[1]?.messages ?? []);
    // The feedback must name the offending short id and clearly describe a
    // DUPLICATE, not just repeat validateGraph's generic (and, for this
    // input, actively misleading) "cycle detected among 1 node(s)" message.
    expect(secondPrompt).toContain('n1');
    expect(secondPrompt.toLowerCase()).toMatch(/duplicate|share/);
  });

  it('(j) a structured output failing PlannerDraftSchema.parse consumes an attempt instead of aborting the run (T1 review round 3, M6)', async () => {
    const model = new FakeChatModel([malformedRawDraft(), validRawDraft()]);
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
    expect(secondPrompt).toContain('did not match the required schema');
  });

  it("(j2) danglingEdge -> malformed sequence: a later schema-parse failure MERGES onto the prior attempt's real validationIssues instead of replacing them (T2 carried-over T1 minor)", async () => {
    // Attempt 1 produces a REAL structural defect (dangling edge to "n3");
    // attempt 2's structured output then fails PlannerDraftSchema.parse
    // entirely. Before the carried-over fix, design.node.ts's schema-parse
    // catch branch returned `validationIssues: [{...}]` (a fresh array
    // containing ONLY this attempt's schema-shape complaint), silently
    // dropping attempt 1's genuine dangling-edge issue the instant a LATER
    // attempt merely failed to parse — even though the underlying structural
    // defect was never actually fixed.
    const model = new FakeChatModel([danglingEdgeRawDraft(), malformedRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      maxAttempts: 2,
    });

    const result = await planner.plan({ instruction: 'Echo some text, then shout it.' });

    expect(result.attempts).toBe(2);
    expect(model.calls).toHaveLength(2);
    // No PlannerDraft was ever produced on attempt 2, so the run still
    // returns attempt 1's (invalid) draft — never throws, matching the
    // exhaustion shape test (c)/(k) exercise elsewhere.
    expect(result.draft.nodes).toHaveLength(2);

    // `result.unresolvedValidationErrors` is `finalState.validationIssues`
    // verbatim — UUID-based (short-id rewriting only ever happens for the
    // NEXT design prompt via `buildDesignFeedback`, never for the returned
    // result), so assert on `code`/message substrings that don't depend on
    // any particular id.
    const issues = result.unresolvedValidationErrors ?? [];
    const realIssueIndex = issues.findIndex((issue) => issue.code === 'REF_SOURCE_MISSING');
    const schemaIssueIndex = issues.findIndex((issue) =>
      issue.message.includes('did not match the required schema')
    );
    // Attempt 1's real dangling-edge defect must survive into the final
    // result...
    expect(realIssueIndex).toBeGreaterThanOrEqual(0);
    // ...alongside (not replaced by) attempt 2's schema-parse failure...
    expect(schemaIssueIndex).toBeGreaterThanOrEqual(0);
    // ...and, per the "MERGE, oldest first" contract (T1 carried-over minor),
    // strictly BEFORE it — a mere presence check (T2 review Minor 2) would
    // also pass for a prepend implementation that silently reordered them.
    expect(realIssueIndex).toBeLessThan(schemaIssueIndex);
  });

  it('(k) exhaustion on nothing but schema-parse failures surfaces a clear error, not a raw ZodError (T1 review round 3, M6)', async () => {
    const model = new FakeChatModel([malformedRawDraft()]); // repeats — never parses
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      maxAttempts: 2,
    });

    // T2 carried-over T1 minor (b): `.rejects.not.toBeInstanceOf(z.ZodError)`
    // is satisfied by ANY non-ZodError rejection (including an unrelated bug
    // throwing a completely different error) — too weak to actually prove
    // `plan()` surfaces the documented exhaustion message. Assert the exact
    // message instead.
    await expect(planner.plan({ instruction: 'Echo some text, then shout it.' })).rejects.toThrow(
      /planning finished with no draft produced/
    );
    expect(model.calls).toHaveLength(2);
  });

  it("(l) a design invoke() rejecting with an OutputParserException (a provider functionCalling adapter validating INSIDE invoke, e.g. ChatOpenAI's JsonOutputKeyToolsParser._validateResult) consumes an attempt instead of aborting the run, same as PlannerDraftSchema.parse failing (T3 review llm-robustness #1)", async () => {
    const model = new InvokeRejectingChatModel([
      new OutputParserException('Failed to parse. Text: "{}"'),
      validRawDraft(),
    ]);
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
    expect(secondPrompt).toContain('did not match the required schema');
  });

  it("(m) a genuine (non-schema) error rejecting design's invoke() still rejects plan() — proves the classification actually discriminates rather than swallowing everything (T3 review llm-robustness #1)", async () => {
    const model = new InvokeRejectingChatModel([new Error('simulated network failure')]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });

    await expect(planner.plan({ instruction: 'Echo some text, then shout it.' })).rejects.toThrow(
      'simulated network failure'
    );
    expect(model.calls).toHaveLength(1);
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

  it('throws synchronously when only catalogLoader is supplied (T2: catalogLoader/mcpNodeResolver must be provided together)', () => {
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
    ).toThrow(/catalogLoader and mcpNodeResolver must be provided together/);
  });

  it('throws synchronously when only mcpNodeResolver is supplied (T2: catalogLoader/mcpNodeResolver must be provided together)', () => {
    expect(
      () =>
        new PipelinePlanner({
          llmFactory: makeLlmFactory(new FakeChatModel([validRawDraft()])),
          modelId: 'test-model',
          specs: testSpecs,
          mcpNodeResolver: {
            resolveSpec: () => Promise.reject(new Error('should never be called')),
          },
        })
    ).toThrow(/catalogLoader and mcpNodeResolver must be provided together/);
  });

  it('does not throw when both catalogLoader and mcpNodeResolver are supplied together (T2)', () => {
    expect(
      () =>
        new PipelinePlanner({
          llmFactory: makeLlmFactory(new FakeChatModel([validRawDraft()])),
          modelId: 'test-model',
          specs: testSpecs,
          catalogLoader: {
            load: () => Promise.resolve({ providers: [], cleanup: () => Promise.resolve() }),
          },
          mcpNodeResolver: {
            resolveSpec: () => Promise.reject(new Error('should never be called')),
          },
        })
    ).not.toThrow();
  });

  // T1 review round 3, I1-R3: `maxAttempts` used to flow unvalidated straight
  // into both loop-stop conditions (`correct.node.ts`'s `attempts >=
  // maxAttempts` gate AND `recursionLimit: maxAttempts * 3 + 2`). A `NaN`
  // (the realistic path — `Number(unset env var)`, and `??` does NOT default
  // NaN) makes BOTH conditions permanently false/unreachable, so the planner
  // calls the model forever. These two tests are deliberately BOUNDED:
  // constructor-only, no `.plan()` call, no graph execution — a NaN test that
  // actually ran the graph would hang the suite.
  it('throws synchronously when maxAttempts is NaN (T1 review round 3, I1-R3)', () => {
    expect(
      () =>
        new PipelinePlanner({
          llmFactory: makeLlmFactory(new FakeChatModel([validRawDraft()])),
          modelId: 'test-model',
          specs: testSpecs,
          maxAttempts: Number('not-a-number'),
        })
    ).toThrow(/maxAttempts must be an integer/);
  });

  it('throws synchronously when maxAttempts is 0 (T1 review round 3, I1-R3)', () => {
    expect(
      () =>
        new PipelinePlanner({
          llmFactory: makeLlmFactory(new FakeChatModel([validRawDraft()])),
          modelId: 'test-model',
          specs: testSpecs,
          maxAttempts: 0,
        })
    ).toThrow(/maxAttempts must be an integer/);
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
      catalog: buildSpecCatalogText(testSpecs),
      logger: NOOP_LOGGER,
      context: {},
      mcpCatalogBox: {},
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
