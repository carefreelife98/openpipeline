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
