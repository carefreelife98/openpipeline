import type { NodeSpec, PipelineEdgeRow, PipelineNodeRow } from '@openpipeline/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { applyAutoFill, isGenericUnknownOutputSpec } from '../src/auto-fill.js';

import { consumerSpec, echoSpec, mcpGenericSpec } from './helpers/fixtures.js';

type DraftNode = Omit<PipelineNodeRow, 'pipelineId'>;
type DraftEdge = Omit<PipelineEdgeRow, 'pipelineId'>;

function node(id: string, key: string, inputs: DraftNode['inputs'] = {}): DraftNode {
  return { id, nodeType: 'TOOL', key, label: id, inputs };
}

function edge(from: string, to: string): DraftEdge {
  return { id: `${from}->${to}`, fromNodeId: from, toNodeId: to };
}

describe('isGenericUnknownOutputSpec (D5 detection)', () => {
  it('recognizes an MCP-origin spec whose output field is z.unknown()', () => {
    expect(isGenericUnknownOutputSpec(mcpGenericSpec)).toBe(true);
  });

  it('rejects a spec with no meta.mcp, even with an identically-shaped output schema', () => {
    const lookalike: NodeSpec = {
      ...mcpGenericSpec,
      meta: undefined,
    };
    expect(isGenericUnknownOutputSpec(lookalike)).toBe(false);
  });

  it('rejects an MCP-origin spec whose output field is a concrete (non-unknown) type', () => {
    const declaredOutput: NodeSpec = {
      ...mcpGenericSpec,
      outputSchema: z.object({
        kind: z.literal('mcp_tool'),
        providerKey: z.string(),
        toolName: z.string(),
        output: z.object({ value: z.string() }),
      }),
    };
    expect(isGenericUnknownOutputSpec(declaredOutput)).toBe(false);
  });

  it('rejects a plain static spec entirely', () => {
    expect(isGenericUnknownOutputSpec(echoSpec)).toBe(false);
  });
});

describe('applyAutoFill (D5)', () => {
  it('fills the required, unbound slot of a node downstream of a generic-output MCP spec', () => {
    const nodes = [node('src', mcpGenericSpec.key), node('dst', consumerSpec.key)];
    const edges = [edge('src', 'dst')];
    const specsByNodeId = new Map<string, NodeSpec>([
      ['src', mcpGenericSpec],
      ['dst', consumerSpec],
    ]);

    const filled = applyAutoFill(nodes, edges, specsByNodeId);
    const dst = filled.find((n) => n.id === 'dst');

    expect(dst?.inputs['value']).toEqual({ kind: 'auto' });
  });

  it('never overwrites a slot that already has an explicit binding', () => {
    const nodes = [
      node('src', mcpGenericSpec.key),
      node('dst', consumerSpec.key, { value: { kind: 'literal', value: 'author-provided' } }),
    ];
    const edges = [edge('src', 'dst')];
    const specsByNodeId = new Map<string, NodeSpec>([
      ['src', mcpGenericSpec],
      ['dst', consumerSpec],
    ]);

    const filled = applyAutoFill(nodes, edges, specsByNodeId);
    const dst = filled.find((n) => n.id === 'dst');

    expect(dst?.inputs['value']).toEqual({ kind: 'literal', value: 'author-provided' });
  });

  it('is idempotent — running it twice over its own output changes nothing further', () => {
    const nodes = [node('src', mcpGenericSpec.key), node('dst', consumerSpec.key)];
    const edges = [edge('src', 'dst')];
    const specsByNodeId = new Map<string, NodeSpec>([
      ['src', mcpGenericSpec],
      ['dst', consumerSpec],
    ]);

    const once = applyAutoFill(nodes, edges, specsByNodeId);
    const twice = applyAutoFill(once, edges, specsByNodeId);

    expect(twice).toEqual(once);
  });

  it('does nothing when the source spec is not a generic-unknown-output spec', () => {
    const nodes = [node('src', echoSpec.key), node('dst', consumerSpec.key)];
    const edges = [edge('src', 'dst')];
    const specsByNodeId = new Map<string, NodeSpec>([
      ['src', echoSpec],
      ['dst', consumerSpec],
    ]);

    const filled = applyAutoFill(nodes, edges, specsByNodeId);
    expect(filled).toEqual(nodes);
  });

  it('skips an edge whose endpoint has no resolved spec instead of throwing', () => {
    const nodes = [node('src', mcpGenericSpec.key), node('dst', 'unknown.key')];
    const edges = [edge('src', 'dst')];
    const specsByNodeId = new Map<string, NodeSpec>([['src', mcpGenericSpec]]);

    expect(() => applyAutoFill(nodes, edges, specsByNodeId)).not.toThrow();
    const filled = applyAutoFill(nodes, edges, specsByNodeId);
    expect(filled.find((n) => n.id === 'dst')?.inputs).toEqual({});
  });
});
