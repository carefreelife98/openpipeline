import type { PipelineDraft } from '@openpipeline/core';
import type { GraphValidationIssue } from '@openpipeline/nodes';
import { describe, expect, it } from 'vitest';

import { issuesReferenceUnresolvedMcpKey, mergeSpecs } from '../src/mcp-routing.js';

import { echoSpec, mcpGenericSpec, shoutSpec } from './helpers/fixtures.js';

describe('mergeSpecs (T2)', () => {
  it('returns a fresh copy (not an alias) of the static specs array when there are no mcp specs', () => {
    const staticSpecs = [echoSpec, shoutSpec];
    const merged = mergeSpecs(staticSpecs, undefined);
    expect(merged).toEqual(staticSpecs);
    expect(merged).not.toBe(staticSpecs);
  });

  it('returns a fresh copy of the static specs when mcpSpecs is an empty array', () => {
    const merged = mergeSpecs([echoSpec], []);
    expect(merged).toEqual([echoSpec]);
  });

  it('appends mcp specs after the static specs', () => {
    const merged = mergeSpecs([echoSpec], [mcpGenericSpec]);
    expect(merged).toEqual([echoSpec, mcpGenericSpec]);
  });

  it('an mcp spec with a colliding key wins over the static spec (last one registered)', () => {
    const staticWithCollidingKey = { ...echoSpec, key: mcpGenericSpec.key };
    const merged = mergeSpecs([staticWithCollidingKey], [mcpGenericSpec]);
    const byKey = new Map(merged.map((spec) => [spec.key, spec] as const));
    expect(byKey.get(mcpGenericSpec.key)).toBe(mcpGenericSpec);
  });

  it('never mutates the input arrays', () => {
    const staticSpecs = [echoSpec];
    const mcpSpecs = [mcpGenericSpec];
    mergeSpecs(staticSpecs, mcpSpecs);
    expect(staticSpecs).toEqual([echoSpec]);
    expect(mcpSpecs).toEqual([mcpGenericSpec]);
  });
});

function draftWith(nodes: Array<{ id: string; key: string }>): PipelineDraft {
  return {
    name: 'd',
    description: 'd',
    nodes: nodes.map((n) => ({ id: n.id, nodeType: 'TOOL', key: n.key, label: n.id, inputs: {} })),
    edges: [],
  };
}

describe('issuesReferenceUnresolvedMcpKey (D2b)', () => {
  it('is false when there is no draft (nothing to cross-reference)', () => {
    expect(
      issuesReferenceUnresolvedMcpKey(
        [{ code: 'NODE_TYPE_MISMATCH', nodeId: 'n1', message: 'x' }],
        undefined
      )
    ).toBe(false);
  });

  it('is false when there are no issues', () => {
    expect(
      issuesReferenceUnresolvedMcpKey([], draftWith([{ id: 'n1', key: 'mcp:demo:lookup' }]))
    ).toBe(false);
  });

  it('is false when the issue is not NODE_TYPE_MISMATCH', () => {
    const issues: GraphValidationIssue[] = [
      { code: 'REF_SOURCE_MISSING', nodeId: 'n1', message: 'x' },
    ];
    expect(
      issuesReferenceUnresolvedMcpKey(issues, draftWith([{ id: 'n1', key: 'mcp:demo:lookup' }]))
    ).toBe(false);
  });

  it('is false when the referenced node key is not an mcp: key', () => {
    const issues: GraphValidationIssue[] = [
      { code: 'NODE_TYPE_MISMATCH', nodeId: 'n1', message: 'x' },
    ];
    expect(
      issuesReferenceUnresolvedMcpKey(issues, draftWith([{ id: 'n1', key: 'tool.nonexistent' }]))
    ).toBe(false);
  });

  it('is false when the issue names a nodeId absent from the draft', () => {
    const issues: GraphValidationIssue[] = [
      { code: 'NODE_TYPE_MISMATCH', nodeId: 'ghost', message: 'x' },
    ];
    expect(
      issuesReferenceUnresolvedMcpKey(issues, draftWith([{ id: 'n1', key: 'mcp:demo:lookup' }]))
    ).toBe(false);
  });

  it('is true when a NODE_TYPE_MISMATCH issue references a node whose key is an unresolved mcp: key', () => {
    const issues: GraphValidationIssue[] = [
      { code: 'NODE_TYPE_MISMATCH', nodeId: 'n1', message: 'x' },
    ];
    expect(
      issuesReferenceUnresolvedMcpKey(issues, draftWith([{ id: 'n1', key: 'mcp:demo:other' }]))
    ).toBe(true);
  });

  it('is true when the mcp: key issue is mixed in among other, unrelated issues', () => {
    const issues: GraphValidationIssue[] = [
      { code: 'REF_SOURCE_MISSING', nodeId: 'n2', message: 'dangling' },
      { code: 'NODE_TYPE_MISMATCH', nodeId: 'n1', message: 'x' },
    ];
    const draft = draftWith([
      { id: 'n1', key: 'mcp:demo:other' },
      { id: 'n2', key: 'tool.echo' },
    ]);
    expect(issuesReferenceUnresolvedMcpKey(issues, draft)).toBe(true);
  });
});
