import { PipelineAbortedError } from '@openpipeline/core';
import { describe, expect, it } from 'vitest';

import { PipelinePlanner } from '../src/planner.js';
import type { PlannerProgressEvent } from '../src/types.js';

import {
  DEFAULT_FAKE_PROVIDERS,
  makeFakeCatalogLoader,
  makeFakeMcpNodeResolver,
} from './helpers/fake-catalog.js';
import {
  FakeChatModel,
  ThrowingAfterNCallsChatModel,
  makeLlmFactory,
} from './helpers/fake-chat-model.js';
import {
  consumerSpec,
  echoSpec,
  mcpGenericSpec,
  mcpOtherSpec,
  shoutSpec,
  testSpecs,
} from './helpers/fixtures.js';
import { findHumanMessageText } from './helpers/messages.js';

/** `intent`'s canned structured-output payload. */
function intentRaw(needsMcp: boolean, candidateProviderKeys: string[] = []): unknown {
  return { taskSummary: 'a task summary', needsMcp, candidateProviderKeys };
}

/** `select`'s canned structured-output payload. */
function selectRaw(selectedKeys: string[]): unknown {
  return { selectedKeys };
}

/** A valid draft using only static specs (no `mcp:` key) — same shape planner.test.ts's `validRawDraft` uses. */
function staticOnlyRawDraft(): unknown {
  return {
    nodes: [
      {
        id: 'n1',
        key: echoSpec.key,
        label: 'Echo',
        inputs: { text: { kind: 'literal', value: 'hi' } },
      },
    ],
    edges: [],
  };
}

/** A single-node draft that references the resolved `mcp:demo:lookup` spec, with a downstream consumer for D5 auto-fill. */
function mcpDraftWithDownstreamConsumer(): unknown {
  return {
    nodes: [
      { id: 'n1', key: mcpGenericSpec.key, label: 'Lookup', inputs: {} },
      { id: 'n2', key: consumerSpec.key, label: 'Consume', inputs: {} },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };
}

/** Same shape as {@link mcpDraftWithDownstreamConsumer}, but n2's slot is already explicitly bound. */
function mcpDraftWithExplicitBinding(): unknown {
  return {
    nodes: [
      { id: 'n1', key: mcpGenericSpec.key, label: 'Lookup', inputs: {} },
      {
        id: 'n2',
        key: consumerSpec.key,
        label: 'Consume',
        inputs: { value: { kind: 'literal', value: 'author-provided' } },
      },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
  };
}

/** A single-node draft referencing an MCP key that was never selected/resolved this round. */
function unresolvedMcpKeyRawDraft(): unknown {
  return {
    nodes: [{ id: 'n1', key: 'mcp:demo:other', label: 'Ghost tool', inputs: {} }],
    edges: [],
  };
}

describe('PipelinePlanner — MCP catalog path constructor guard (T2)', () => {
  it('accepts a working catalogLoader/mcpNodeResolver pair and runs the intent -> select -> design graph', async () => {
    const model = new FakeChatModel([intentRaw(false), staticOnlyRawDraft()]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map());
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'do something' });

    expect(result.attempts).toBe(1);
    expect(result.draft.nodes).toHaveLength(1);
  });
});

describe('(a) needsMcp: false skips select entirely (D2)', () => {
  it('never calls the select LLM, never loads the catalog, and never invokes the resolver', async () => {
    // Two responses total: intent, then design — a THIRD response would only
    // ever be consumed if `select` ran, so an accidental extra LLM call here
    // would repeat the design response instead of silently passing.
    const model = new FakeChatModel([intentRaw(false), staticOnlyRawDraft()]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map());
    const events: PlannerProgressEvent[] = [];
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({
      instruction: 'do something static',
      onProgress: (event) => events.push(event),
    });

    expect(result.attempts).toBe(1);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    // Exactly 2 LLM calls (intent, design) — select's LLM was never reached.
    expect(model.calls).toHaveLength(2);
    expect(events.some((e) => e.phase === 'select')).toBe(false);
    // `select` loading the catalog is the ONLY thing that ever calls
    // `catalogLoader.load` — never reached means never loaded.
    expect(catalogLoader.loadCalls).toBe(0);
    expect(mcpNodeResolver.resolveCalls).toHaveLength(0);
  });

  it('a malformed (non-IntentSchema-shaped) response degrades to needsMcp: false instead of aborting the run (T2 review Minor 1)', async () => {
    const model = new FakeChatModel([
      { totallyUnrelated: true }, // fails IntentSchema.parse entirely
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map());
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'do something' });

    // plan() resolves — a schema-shape defect in `intent`'s output must not
    // block the run any more than `needsMcp: false` does.
    expect(result.attempts).toBe(1);
    expect(result.draft.nodes).toHaveLength(1);
    // Exactly 2 LLM calls (intent, design) — select was never reached, same
    // as the explicit `needsMcp: false` case above.
    expect(model.calls).toHaveLength(2);
    expect(catalogLoader.loadCalls).toBe(0);
    expect(result.plannerWarnings).toBeDefined();
    expect(
      result.plannerWarnings?.some((w) => w.includes('did not match the required schema'))
    ).toBe(true);
  });
});

describe('(b) select fail-soft: empty selection twice proceeds to design with static specs only (D2)', () => {
  it('retries once with the same input, then warns and proceeds without ever calling the resolver', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw([]), // first attempt: empty
      selectRaw([]), // same-input retry: still empty
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map());
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'maybe use a tool' });

    expect(result.attempts).toBe(1);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(result.draft.nodes).toHaveLength(1);
    expect(model.calls).toHaveLength(4); // intent, select x2, design
    expect(mcpNodeResolver.resolveCalls).toHaveLength(0); // nothing to resolve
    expect(result.plannerWarnings).toBeDefined();
    expect(result.plannerWarnings?.some((w) => w.includes('no MCP tools were selected'))).toBe(
      true
    );
  });

  it('filters an out-of-catalog key on the first attempt and still retries (a bogus key is "invalid", not "valid but unresolved")', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:not-in-catalog:tool']), // filtered out entirely -> counts as empty
      selectRaw([]),
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map());
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'maybe use a tool' });

    expect(result.attempts).toBe(1);
    expect(model.calls).toHaveLength(4);
    expect(result.plannerWarnings?.some((w) => w.includes('no MCP tools were selected'))).toBe(
      true
    );
  });

  it('a malformed (non-SelectSchema-shaped) response is fail-soft, not a raw ZodError rejection (T2 review Important 1)', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      { selectedKeys: 'mcp:demo:lookup' }, // wrong shape: string, not an array
      { totallyUnrelated: true }, // same-input retry: still doesn't match SelectSchema
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map());
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'maybe use a tool' });

    // plan() resolves — a schema-shape defect in `select`'s output must not
    // block the run any more than an empty/mismatched selection does.
    expect(result.attempts).toBe(1);
    expect(result.draft.nodes).toHaveLength(1);
    expect(model.calls).toHaveLength(4); // intent, select x2, design
    expect(mcpNodeResolver.resolveCalls).toHaveLength(0); // resolver never reached
    expect(result.plannerWarnings).toBeDefined();
    // The warning names the schema failure rather than the generic
    // empty-selection message, so the degradation isn't invisible.
    expect(
      result.plannerWarnings?.some((w) => w.includes('did not match the required schema'))
    ).toBe(true);
  });
});

describe('(c) deterministic auto-fill (D5) through the full graph, not just the unit helper', () => {
  it("fills the downstream consumer's empty required slot when the source resolves to a generic-unknown-output MCP spec", async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      mcpDraftWithDownstreamConsumer(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: [consumerSpec],
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'look something up and consume it' });

    expect(result.attempts).toBe(1);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    const consumerNode = result.draft.nodes.find((n) => n.key === consumerSpec.key);
    expect(consumerNode?.inputs['value']).toEqual({ kind: 'auto' });
  });

  it('never overwrites a slot the draft already bound explicitly', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      mcpDraftWithExplicitBinding(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: [consumerSpec],
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'look something up and consume it' });

    expect(result.unresolvedValidationErrors).toBeUndefined();
    const consumerNode = result.draft.nodes.find((n) => n.key === consumerSpec.key);
    expect(consumerNode?.inputs['value']).toEqual({ kind: 'literal', value: 'author-provided' });
  });
});

describe('(d) correct-routing extension: an unresolved mcp: key routes back to select, not design (D2b)', () => {
  it('re-enters select on the next attempt when the draft references a never-selected mcp: key', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']), // resolves fine — but design "hallucinates" a DIFFERENT key below
      unresolvedMcpKeyRawDraft(), // references "mcp:demo:other", never selected/resolved -> unresolved-key issue
      selectRaw(['mcp:demo:lookup']), // re-entry after correct routes to select
      staticOnlyRawDraft(), // this time design behaves and uses only static specs
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const events: PlannerProgressEvent[] = [];
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
      maxAttempts: 3,
    });

    const result = await planner.plan({
      instruction: 'do something with a tool',
      onProgress: (event) => events.push(event),
    });

    expect(result.attempts).toBe(2);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(model.calls).toHaveLength(5);

    const selectEvents = events.filter((e) => e.phase === 'select');
    expect(selectEvents).toHaveLength(2);
    // The re-entry happens on the SECOND design attempt (correct's post-increment attempts value).
    expect(selectEvents[1]?.attempt).toBe(2);
    // `correct` never routed through `design` directly on the round it detected the unresolved key —
    // it went to `select` first, so `design` must have been entered exactly twice, matching `attempts`.
    const designEvents = events.filter((e) => e.phase === 'design');
    expect(designEvents).toHaveLength(2);

    // The catalog is only ever loaded once per plan() call, even across the two `select` entries.
    expect(catalogLoader.loadCalls).toBe(1);
  });

  it('routes to design (not select) for a validation issue unrelated to an mcp: key, even when select DID run this plan()', async () => {
    // select runs once (needsMcp: true) and resolves a key successfully —
    // attempt 1's failure is a plain dangling edge, nothing to do with the
    // resolved mcp: key, so `correct` must route to `design`, and `select`
    // must NOT be re-entered a second time.
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      danglingEdgeStaticDraft(),
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const events: PlannerProgressEvent[] = [];
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: [echoSpec, shoutSpec],
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({
      instruction: 'echo then shout, maybe with a tool',
      onProgress: (event) => events.push(event),
    });

    expect(result.attempts).toBe(2);
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(model.calls).toHaveLength(4);
    const selectEvents = events.filter((e) => e.phase === 'select');
    // select ran once (intent routed it there) and was never re-entered by correct.
    expect(selectEvents).toHaveLength(1);
    const designEvents = events.filter((e) => e.phase === 'design');
    expect(designEvents).toHaveLength(2);
  });

  it("an empty D2b re-selection preserves an earlier round's resolved mcpSpecs instead of wiping them (T2 review Minor 4)", async () => {
    // Round 1: select resolves "mcp:demo:lookup" successfully, but design
    // "hallucinates" a DIFFERENT, never-selected key ("mcp:demo:other") —
    // correct routes back to select. Round 2: select comes back empty twice
    // (fail-soft trips) — WITHOUT the fix, this would overwrite
    // `state.mcpSpecs` with `[]`, wiping round 1's successfully-resolved
    // "mcp:demo:lookup". Round 2's design then uses ONLY "mcp:demo:lookup"
    // (no hallucinated key this time): if it survived, validate passes; if it
    // was wiped, "mcp:demo:lookup" reads back as an unresolved key and the
    // run would burn a THIRD round instead of succeeding on round 2.
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']), // round 1 select: resolves fine
      unresolvedMcpKeyRawDraft(), // round 1 design: hallucinates "mcp:demo:other"
      selectRaw([]), // round 2 select re-entry, attempt 1: empty
      selectRaw([]), // round 2 select re-entry, same-input retry: still empty
      { nodes: [{ id: 'n1', key: mcpGenericSpec.key, label: 'Lookup', inputs: {} }], edges: [] }, // round 2 design: only the round-1-resolved key
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
      maxAttempts: 3,
    });

    const result = await planner.plan({ instruction: 'do something with a tool' });

    expect(result.attempts).toBe(2);
    // Only ever resolved once (round 1) — round 2's empty selection never
    // reaches the resolver, and round 1's resolved spec was preserved rather
    // than re-resolved.
    expect(mcpNodeResolver.resolveCalls).toEqual(['mcp:demo:lookup']);
    // If mcpSpecs had been wiped, "mcp:demo:lookup" would read back as an
    // unresolved key and this would be defined instead.
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(result.draft.nodes).toHaveLength(1);
  });

  it("a non-empty D2b re-selection merges with an earlier round's resolved mcpSpecs instead of replacing them (T2 re-review round 2, Minor-4 residual, carried over to T3)", async () => {
    // Round 1: select resolves "mcp:demo:lookup", but design hallucinates a
    // DIFFERENT, never-selected key ("mcp:demo:other") — correct routes back
    // to select. Round 2: select comes back NON-empty this time — it selects
    // "mcp:demo:other" (and resolves it), but NOT "mcp:demo:lookup" again.
    // WITHOUT the fix, this replaces `state.mcpSpecs` with just
    // ["mcp:demo:other"], silently dropping round 1's resolved
    // "mcp:demo:lookup". Round 2's design then references BOTH keys: if
    // "mcp:demo:lookup" survived the merge, validate passes on round 2; if it
    // was dropped, it reads back as unresolved and (with maxAttempts: 2) the
    // run exhausts instead of succeeding.
    const catalogLoader = makeFakeCatalogLoader([
      {
        key: 'demo',
        displayName: 'Demo',
        tools: [
          { name: 'lookup', description: 'first tool', invoke: () => Promise.resolve({}) },
          { name: 'other', description: 'second tool', invoke: () => Promise.resolve({}) },
        ],
      },
    ]);
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([
        [mcpGenericSpec.key, mcpGenericSpec],
        [mcpOtherSpec.key, mcpOtherSpec],
      ])
    );
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']), // round 1 select: resolves "lookup"
      unresolvedMcpKeyRawDraft(), // round 1 design: hallucinates "mcp:demo:other"
      selectRaw(['mcp:demo:other']), // round 2 select re-entry: resolves "other", NOT "lookup" again
      {
        nodes: [
          { id: 'n1', key: mcpGenericSpec.key, label: 'Lookup', inputs: {} },
          { id: 'n2', key: mcpOtherSpec.key, label: 'Other', inputs: {} },
        ],
        edges: [],
      }, // round 2 design: references BOTH the round-1 and round-2 resolved keys
    ]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
      maxAttempts: 2,
    });

    const result = await planner.plan({ instruction: 'do something with two tools' });

    // If round 1's "mcp:demo:lookup" had been dropped, this would exhaust at
    // maxAttempts: 2 with `unresolvedValidationErrors` populated instead.
    expect(result.unresolvedValidationErrors).toBeUndefined();
    expect(result.attempts).toBe(2);
    expect(result.draft.nodes).toHaveLength(2);
    // Each key resolved exactly once, in order — round 1's key was carried
    // over by the merge, never re-resolved by round 2.
    expect(mcpNodeResolver.resolveCalls).toEqual(['mcp:demo:lookup', 'mcp:demo:other']);
    expect(model.calls).toHaveLength(5);
  });

  it('an identical select warning across two D2b re-entries appears only once in plannerWarnings (T2 review Minor 3)', async () => {
    // "mcp:demo:broken" is well-formed and IN the catalog (so `select`
    // accepts it as a "valid selected key"), but the resolver has no spec
    // registered for it — every round's resolve failure produces the exact
    // same warning message. The unresolved key routes `correct` back to
    // `select` every round, so without dedup the identical message would
    // accumulate once per round in the APPEND-semantics plannerWarnings
    // channel.
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:broken']), // round 1: resolves, but resolveSpec rejects
      { nodes: [{ id: 'n1', key: 'mcp:demo:broken', label: 'Broken', inputs: {} }], edges: [] },
      selectRaw(['mcp:demo:broken']), // round 2 re-entry: same key, same rejection
      { nodes: [{ id: 'n1', key: 'mcp:demo:broken', label: 'Broken', inputs: {} }], edges: [] },
    ]);
    const catalogLoader = makeFakeCatalogLoader([
      {
        key: 'demo',
        displayName: 'Demo',
        tools: [
          {
            name: 'broken',
            description: 'always fails to resolve',
            invoke: () => Promise.resolve({}),
          },
        ],
      },
    ]);
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map()); // nothing registered -> always rejects
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
      maxAttempts: 2,
    });

    const result = await planner.plan({ instruction: 'do something with a tool' });

    // Exhausts at maxAttempts=2 — the unresolved key is never fixed.
    expect(result.attempts).toBe(2);
    expect(mcpNodeResolver.resolveCalls).toEqual(['mcp:demo:broken', 'mcp:demo:broken']);
    const matchingWarnings = (result.plannerWarnings ?? []).filter((w) =>
      w.includes('mcp:demo:broken')
    );
    expect(matchingWarnings).toHaveLength(1);
  });
});

/** A 2-node static draft whose edge dangles to a never-declared node — a non-MCP validation issue. */
function danglingEdgeStaticDraft(): unknown {
  return {
    nodes: [
      {
        id: 'n1',
        key: echoSpec.key,
        label: 'Echo',
        inputs: { text: { kind: 'literal', value: 'x' } },
      },
    ],
    edges: [{ from: 'n1', to: 'n3' }],
  };
}

describe('(e) catalog cleanup runs exactly once on every exit path (D2)', () => {
  it('success: cleanup runs exactly once after a normal, valid plan()', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    await planner.plan({ instruction: 'use a tool' });

    expect(catalogLoader.loadCalls).toBe(1);
    expect(catalogLoader.cleanupCalls).toBe(1);
  });

  it('failure: cleanup still runs exactly once when the LLM throws mid-run, after the catalog was already loaded', async () => {
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    // Succeeds for the first 2 calls (intent, select), then rejects every
    // call after that (design) — simulating a genuine LLM/network failure
    // mid-run, well after `select` has already populated
    // `runtime.mcpCatalogBox`.
    const model = new ThrowingAfterNCallsChatModel(
      [intentRaw(true, ['demo']), selectRaw(['mcp:demo:lookup'])],
      2,
      new Error('simulated LLM failure')
    );

    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    await expect(planner.plan({ instruction: 'use a tool' })).rejects.toThrow(
      'simulated LLM failure'
    );

    expect(catalogLoader.loadCalls).toBe(1);
    expect(catalogLoader.cleanupCalls).toBe(1);
  });

  it('abort: cleanup still runs exactly once when the signal aborts mid-run, after the catalog was already loaded', async () => {
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      staticOnlyRawDraft(),
    ]);
    const controller = new AbortController();
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    await expect(
      planner.plan({
        instruction: 'use a tool',
        signal: controller.signal,
        // Fires at `select`'s OWN entry — `checkAbort` already passed for
        // this in-flight `select()` call, so aborting from inside this
        // callback doesn't interrupt it: `select` still runs to completion
        // (loads the catalog, resolves the key), and it's `design`'s own
        // entry `checkAbort` — the next node — that actually throws.
        onProgress: (event) => {
          if (event.phase === 'select') controller.abort();
        },
      })
    ).rejects.toBeInstanceOf(PipelineAbortedError);

    expect(catalogLoader.loadCalls).toBe(1);
    expect(catalogLoader.cleanupCalls).toBe(1);
  });

  it('is a no-op (never even attempted) on the no-MCP path', async () => {
    const model = new FakeChatModel([staticOnlyRawDraft()]);
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
    });

    await expect(planner.plan({ instruction: 'no catalog at all' })).resolves.toBeDefined();
  });

  it('success path: a rejecting cleanup() still resolves with the draft, carrying a plannerWarning (T2 review Important 2)', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      staticOnlyRawDraft(),
    ]);
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const catalogLoader = {
      load: () =>
        Promise.resolve({
          providers: DEFAULT_FAKE_PROVIDERS,
          cleanup: () => Promise.reject(new Error('cleanup boom')),
        }),
    };
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    // Must NOT reject with the cleanup error — the completed draft is the
    // expensive part of the run and must not be thrown away over a teardown
    // detail.
    const result = await planner.plan({ instruction: 'use a tool' });

    expect(result.draft.nodes).toHaveLength(1);
    expect(result.plannerWarnings).toBeDefined();
    expect(result.plannerWarnings?.some((w) => w.toLowerCase().includes('cleanup'))).toBe(true);
  });

  it('abort path: a rejecting cleanup() does not mask PipelineAbortedError (T2 review Important 2)', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      staticOnlyRawDraft(),
    ]);
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const catalogLoader = {
      load: () =>
        Promise.resolve({
          providers: DEFAULT_FAKE_PROVIDERS,
          cleanup: () => Promise.reject(new Error('cleanup boom')),
        }),
    };
    const controller = new AbortController();
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    // Without the fix, the rejecting cleanup() in `finally` REPLACES the
    // PipelineAbortedError the `try` block threw, so the caller would see
    // "cleanup boom" instead and any `instanceof PipelineAbortedError`
    // handling would silently stop working.
    await expect(
      planner.plan({
        instruction: 'use a tool',
        signal: controller.signal,
        onProgress: (event) => {
          if (event.phase === 'select') controller.abort();
        },
      })
    ).rejects.toBeInstanceOf(PipelineAbortedError);
  });
});

describe('select prompt content (D2)', () => {
  it('truncates a tool description to 240 chars and lists the mcp:<provider>:<tool> key', async () => {
    const longDescription = 'x'.repeat(400);
    const providers = [
      {
        key: 'demo',
        displayName: 'Demo',
        tools: [
          { name: 'lookup', description: longDescription, invoke: () => Promise.resolve({}) },
        ],
      },
    ];
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw([]),
      selectRaw([]),
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader(providers);
    const mcpNodeResolver = makeFakeMcpNodeResolver(new Map());
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    await planner.plan({ instruction: 'do something' });

    const selectPrompt = findHumanMessageText(model.calls[1]?.messages ?? []);
    expect(selectPrompt).toContain('mcp:demo:lookup');
    expect(selectPrompt).toContain('x'.repeat(240));
    expect(selectPrompt).not.toContain('x'.repeat(241));
  });

  it('is invoked via withStructuredOutput(..., { method: "functionCalling" }) for both intent and select', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader(DEFAULT_FAKE_PROVIDERS);
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    await planner.plan({ instruction: 'do something' });

    expect(model.calls[0]?.method).toBe('functionCalling'); // intent
    expect(model.calls[1]?.method).toBe('functionCalling'); // select
  });
});

describe('select per-key resolve fail-soft (D2)', () => {
  it('drops a key whose resolveSpec rejects with its own plannerWarning, keeping the others', async () => {
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup', 'mcp:demo:broken']),
      staticOnlyRawDraft(),
    ]);
    const catalogLoader = makeFakeCatalogLoader([
      {
        key: 'demo',
        displayName: 'Demo',
        tools: [
          { name: 'lookup', description: 'ok', invoke: () => Promise.resolve({}) },
          {
            name: 'broken',
            description: 'always fails to resolve',
            invoke: () => Promise.resolve({}),
          },
        ],
      },
    ]);
    // Only registers "mcp:demo:lookup" — "mcp:demo:broken" rejects.
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
    });

    const result = await planner.plan({ instruction: 'use tools' });

    expect(mcpNodeResolver.resolveCalls).toEqual(['mcp:demo:lookup', 'mcp:demo:broken']);
    expect(result.plannerWarnings?.some((w) => w.includes('mcp:demo:broken'))).toBe(true);
  });
});

describe('(f) catalog-path exhaustion: an unresolved mcp: key persists across every attempt (T2 review Minor 5)', () => {
  it('never throws, exhausts at maxAttempts with unresolvedValidationErrors populated instead of an opaque GraphRecursionError', async () => {
    // Every design attempt references "mcp:demo:other", which is never
    // selected/resolved — correct routes back to select on round 1, select
    // resolves the SAME (irrelevant) "mcp:demo:lookup" key again, design
    // repeats the same unresolved-key mistake, and maxAttempts=2 is spent
    // without ever validating cleanly. Locks two catalog-path-only
    // mechanisms simultaneously: correctNode's exhaustion branch clearing a
    // previous round's correctTarget: 'select' back to undefined, and the
    // widened recursionLimit budget (maxAttempts*4+3) actually covering a
    // round that spends every one of its 4 super-steps.
    const model = new FakeChatModel([
      intentRaw(true, ['demo']),
      selectRaw(['mcp:demo:lookup']),
      unresolvedMcpKeyRawDraft(),
      selectRaw(['mcp:demo:lookup']), // re-entry after correct routes to select
      unresolvedMcpKeyRawDraft(), // still references the never-selected key
    ]);
    const catalogLoader = makeFakeCatalogLoader();
    const mcpNodeResolver = makeFakeMcpNodeResolver(
      new Map([[mcpGenericSpec.key, mcpGenericSpec]])
    );
    const planner = new PipelinePlanner({
      llmFactory: makeLlmFactory(model),
      modelId: 'test-model',
      specs: testSpecs,
      catalogLoader,
      mcpNodeResolver,
      maxAttempts: 2,
    });

    const result = await planner.plan({ instruction: 'do something with a tool' });

    expect(result.attempts).toBe(2);
    expect(result.unresolvedValidationErrors).toBeDefined();
    expect(result.unresolvedValidationErrors?.length ?? 0).toBeGreaterThan(0);
    expect(result.draft).toBeDefined();
    // Both design attempts + both select entries actually ran — the run was
    // not silently truncated by the recursion budget.
    expect(model.calls).toHaveLength(5);
  });
});
