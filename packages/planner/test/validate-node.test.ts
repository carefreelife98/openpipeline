import { NOOP_LOGGER, type NodeSpec, type PipelineWithGraph } from '@openpipeline/core';
import { describe, expect, it } from 'vitest';

import { validateIfBranches, validateNode } from '../src/nodes/validate.node.js';
import type { PlannerRuntime } from '../src/runtime.js';
import type { PlannerState } from '../src/state.js';

import { FakeChatModel, makeLlmFactory } from './helpers/fake-chat-model.js';
import { branchSpec, echoSpec, testSpecs } from './helpers/fixtures.js';

function graphOf(
  nodes: Array<{ id: string; key: string; label?: string }>,
  edges: Array<{ from: string; to: string; label?: 'true' | 'false' }>
): PipelineWithGraph {
  return {
    pipeline: { id: 'p', name: 'p', createdAt: new Date(0), updatedAt: new Date(0) },
    nodes: nodes.map((n) => ({
      id: n.id,
      pipelineId: 'p',
      nodeType: 'TOOL',
      key: n.key,
      label: n.label ?? n.id,
      inputs: {},
    })),
    edges: edges.map((e, i) => ({
      id: `e${String(i)}`,
      pipelineId: 'p',
      fromNodeId: e.from,
      toNodeId: e.to,
      label: e.label,
    })),
  };
}

describe('validateIfBranches (D2 — mirrors the compiler IF-branch check)', () => {
  it('passes an IF node with exactly one true and one false outgoing edge', () => {
    const graph = graphOf(
      [
        { id: 'if1', key: branchSpec.key },
        { id: 't', key: echoSpec.key },
        { id: 'f', key: echoSpec.key },
      ],
      [
        { from: 'if1', to: 't', label: 'true' },
        { from: 'if1', to: 'f', label: 'false' },
      ]
    );
    const specs = new Map<string, NodeSpec>([
      ['if1', branchSpec],
      ['t', echoSpec],
      ['f', echoSpec],
    ]);

    expect(validateIfBranches(graph, specs)).toEqual([]);
  });

  it('flags a missing false branch', () => {
    const graph = graphOf(
      [
        { id: 'if1', key: branchSpec.key },
        { id: 't', key: echoSpec.key },
      ],
      [{ from: 'if1', to: 't', label: 'true' }]
    );
    const specs = new Map<string, NodeSpec>([
      ['if1', branchSpec],
      ['t', echoSpec],
    ]);

    const issues = validateIfBranches(graph, specs);
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'INPUTS_REQUIRED_MISSING',
        nodeId: 'if1',
        slot: 'false',
      }),
    ]);
  });

  it('flags a duplicate true branch even though both targets exist', () => {
    const graph = graphOf(
      [
        { id: 'if1', key: branchSpec.key },
        { id: 't1', key: echoSpec.key },
        { id: 't2', key: echoSpec.key },
        { id: 'f', key: echoSpec.key },
      ],
      [
        { from: 'if1', to: 't1', label: 'true' },
        { from: 'if1', to: 't2', label: 'true' },
        { from: 'if1', to: 'f', label: 'false' },
      ]
    );
    const specs = new Map<string, NodeSpec>([
      ['if1', branchSpec],
      ['t1', echoSpec],
      ['t2', echoSpec],
      ['f', echoSpec],
    ]);

    const issues = validateIfBranches(graph, specs);
    expect(issues).toEqual([
      expect.objectContaining({ code: 'INPUTS_REQUIRED_MISSING', nodeId: 'if1', slot: 'true' }),
    ]);
  });

  it('is a no-op when the graph has no IF nodes', () => {
    const graph = graphOf([{ id: 'a', key: echoSpec.key }], []);
    const specs = new Map<string, NodeSpec>([['a', echoSpec]]);
    expect(validateIfBranches(graph, specs)).toEqual([]);
  });
});

describe('validateNode — unknown spec key (D2 draft->graph conversion)', () => {
  it('flags a node whose key has no matching NodeSpec, reusing NODE_TYPE_MISMATCH', async () => {
    const runtime: PlannerRuntime = {
      llmFactory: makeLlmFactory(new FakeChatModel([{ nodes: [], edges: [] }])),
      modelId: 'm',
      temperature: 0.3,
      specs: testSpecs,
      catalog: { text: '', warnings: [] },
      logger: NOOP_LOGGER,
    };
    const state: PlannerState = {
      instruction: 'x',
      attempts: 1,
      idMap: { n1: 'uuid-1' },
      validationIssues: [],
      plannerWarnings: [],
      draft: {
        name: 'x',
        description: 'x',
        nodes: [
          { id: 'uuid-1', nodeType: 'TOOL', key: 'tool.nonexistent', label: 'Ghost', inputs: {} },
        ],
        edges: [],
      },
    };

    const result = await validateNode(state, runtime);

    expect(result.validationIssues).toEqual([
      expect.objectContaining({ code: 'NODE_TYPE_MISMATCH', nodeId: 'uuid-1' }),
    ]);
  });

  it('throws a plain Error (not a validation issue) when reached with no draft — a wiring bug, not something correctable', () => {
    const runtime: PlannerRuntime = {
      llmFactory: makeLlmFactory(new FakeChatModel([{ nodes: [], edges: [] }])),
      modelId: 'm',
      temperature: 0.3,
      specs: testSpecs,
      catalog: { text: '', warnings: [] },
      logger: NOOP_LOGGER,
    };
    const state: PlannerState = {
      instruction: 'x',
      attempts: 1,
      idMap: {},
      validationIssues: [],
      plannerWarnings: [],
    };

    expect(() => validateNode(state, runtime)).toThrow(/no draft in state/);
  });
});
