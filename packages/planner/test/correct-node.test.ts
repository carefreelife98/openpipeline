import { NOOP_LOGGER } from '@openpipeline/core';
import { describe, expect, it } from 'vitest';

import { correctNode } from '../src/nodes/correct.node.js';
import type { PlannerRuntime } from '../src/runtime.js';
import type { PlannerState } from '../src/state.js';

import { makeFakeCatalogLoader, makeFakeMcpNodeResolver } from './helpers/fake-catalog.js';
import { FakeChatModel, makeLlmFactory } from './helpers/fake-chat-model.js';
import { mcpGenericSpec, testSpecs } from './helpers/fixtures.js';

/** A catalog-path-active runtime (`catalogLoader`/`mcpNodeResolver` both set) — `correctNode` only ever considers routing to `'select'` on this path. */
function catalogRuntime(): PlannerRuntime {
  return {
    llmFactory: makeLlmFactory(new FakeChatModel([{ nodes: [], edges: [] }])),
    modelId: 'm',
    temperature: 0.3,
    specs: testSpecs,
    catalog: { text: '', warnings: [] },
    logger: NOOP_LOGGER,
    context: {},
    mcpCatalogBox: {},
    catalogLoader: makeFakeCatalogLoader(),
    mcpNodeResolver: makeFakeMcpNodeResolver(new Map([[mcpGenericSpec.key, mcpGenericSpec]])),
  };
}

/**
 * A draft + validationIssues pair that DOES reference an unresolved `mcp:`
 * key — the exact shape `issuesReferenceUnresolvedMcpKey` matches, and, on
 * its own (no `designError`), correctly routes `correctTarget` to `'select'`
 * (D2b). Used as the STALE payload quality-batch item 5 is about: a round
 * whose `design` call fails to PARSE never touches `state.draft`/
 * `state.validationIssues` beyond appending its own schema-failure issue (see
 * `design.node.ts`'s catch branch), so an earlier round's unresolved-mcp-key
 * issue and draft survive UNCHANGED into a `designError` round.
 */
function staleUnresolvedMcpKeyPayload(): {
  draft: PlannerState['draft'];
  validationIssues: PlannerState['validationIssues'];
} {
  return {
    draft: {
      name: 'x',
      description: 'x',
      nodes: [
        { id: 'uuid-1', nodeType: 'TOOL', key: 'mcp:demo:other', label: 'Ghost', inputs: {} },
      ],
      edges: [],
    },
    validationIssues: [
      { code: 'NODE_TYPE_MISMATCH', message: 'unresolved mcp key', nodeId: 'uuid-1' },
    ],
  };
}

describe('correctNode — designError routing (quality-batch item 5)', () => {
  it("routes to 'select' for a genuine unresolved-mcp-key validation issue when designError is NOT set (baseline D2b behavior, unchanged)", async () => {
    const { draft, validationIssues } = staleUnresolvedMcpKeyPayload();
    const state: PlannerState = {
      instruction: 'x',
      attempts: 1,
      idMap: {},
      validationIssues,
      plannerWarnings: [],
      draft,
      designError: undefined,
    };

    const result = await correctNode(state, catalogRuntime(), 3);

    expect(result.correctTarget).toBe('select');
  });

  it("routes to 'design' — not 'select' — when THIS round's designError is set, even though state.validationIssues/state.draft still carry an EARLIER round's unresolved-mcp-key issue (the fix)", async () => {
    // Simulates exactly the state design.node.ts's schema-parse catch branch
    // produces on a round AFTER an earlier round already routed correct ->
    // select for a real unresolved-mcp-key issue: validationIssues/draft are
    // untouched leftovers from that earlier round (design.node.ts never
    // updates `draft` and only APPENDS to `validationIssues` on a parse
    // failure), so a routing check that still inspects them here is
    // examining STALE data that has nothing to do with THIS round's actual
    // failure (a schema-shape defect, not a tool-selection problem).
    const { draft, validationIssues } = staleUnresolvedMcpKeyPayload();
    const state: PlannerState = {
      instruction: 'x',
      attempts: 2,
      idMap: {},
      validationIssues,
      plannerWarnings: [],
      draft,
      designError: 'your previous response did not match the required schema: ...',
    };

    const result = await correctNode(state, catalogRuntime(), 3);

    expect(result.correctTarget).toBe('design');
  });

  it('a designError round still increments attempts and builds designFeedback normally (only correctTarget changes)', async () => {
    const { draft, validationIssues } = staleUnresolvedMcpKeyPayload();
    const state: PlannerState = {
      instruction: 'x',
      attempts: 2,
      idMap: {},
      validationIssues,
      plannerWarnings: [],
      draft,
      designError: 'schema mismatch',
    };

    const result = await correctNode(state, catalogRuntime(), 3);

    expect(result.attempts).toBe(3);
    expect(result.designFeedback).toBeDefined();
  });
});
