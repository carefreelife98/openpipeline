import type { GraphValidationIssue } from '@openpipeline/nodes';
import { describe, expect, it } from 'vitest';

import { buildDesignFeedback, buildIdAssignment } from '../src/id-map.js';
import type { PlannerDraft } from '../src/schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function draft(nodeIds: string[], edges: Array<[string, string]> = []): PlannerDraft {
  return {
    nodes: nodeIds.map((id) => ({ id, key: 'tool.x', label: id, inputs: {} })),
    edges: edges.map(([from, to]) => ({ from, to })),
  };
}

describe('buildIdAssignment (D4)', () => {
  it('mints a fresh UUID for every previously-unseen short id', () => {
    const { idMap } = buildIdAssignment(draft(['n1', 'n2']), {});
    expect(idMap['n1']).toMatch(UUID_RE);
    expect(idMap['n2']).toMatch(UUID_RE);
    expect(idMap['n1']).not.toBe(idMap['n2']);
  });

  it('reuses an existing mapping instead of minting a new UUID', () => {
    const existing = { n1: 'fixed-uuid-1' };
    const { idMap } = buildIdAssignment(draft(['n1', 'n2']), existing);
    expect(idMap['n1']).toBe('fixed-uuid-1');
    expect(idMap['n2']).toMatch(UUID_RE);
  });

  it('resolves an edge endpoint that names no declared node too (dangling edge), stably', () => {
    const { idMap, resolve } = buildIdAssignment(draft(['n1'], [['n1', 'n404']]), {});
    expect(idMap['n404']).toMatch(UUID_RE);
    expect(resolve('n404')).toBe(idMap['n404']);
  });

  it('resolve() called after construction still mutates the same returned idMap object', () => {
    const assignment = buildIdAssignment(draft(['n1']), {});
    const uuid = assignment.resolve('n99'); // e.g. discovered later, inside a state-binding path
    expect(assignment.idMap['n99']).toBe(uuid);
  });
});

describe('buildDesignFeedback (D4 — UUID -> short id rewrite)', () => {
  it('rewrites a UUID nodeId back to its short id and numbers each issue', () => {
    const idMap = { n1: 'uuid-1', n2: 'uuid-2' };
    const issues: GraphValidationIssue[] = [
      {
        code: 'REF_SOURCE_MISSING',
        nodeId: 'uuid-2',
        message: 'edge references unknown node "uuid-2"',
      },
    ];

    const feedback = buildDesignFeedback(issues, idMap);

    expect(feedback).toContain('1. [REF_SOURCE_MISSING]');
    expect(feedback).toContain('node "n2"');
    expect(feedback).not.toContain('uuid-2');
  });

  it('never leaks a raw UUID into the rendered feedback across multiple issues', () => {
    const idMap = { n1: 'uuid-1', n2: 'uuid-2', n3: 'uuid-3' };
    const issues: GraphValidationIssue[] = [
      {
        code: 'NODE_TYPE_MISMATCH',
        nodeId: 'uuid-1',
        message: 'node "uuid-1" references unknown key',
      },
      {
        code: 'INPUTS_REQUIRED_MISSING',
        nodeId: 'uuid-3',
        slot: 'true',
        message: 'IF node "uuid-3" must have exactly one "true"-labeled outgoing edge (found 0)',
      },
    ];

    const feedback = buildDesignFeedback(issues, idMap);

    for (const uuid of Object.values(idMap)) {
      expect(feedback).not.toContain(uuid);
    }
    expect(feedback).toContain('n1');
    expect(feedback).toContain('n3');
    expect(feedback).toContain('(slot "true")');
  });

  it('leaves an issue with no nodeId as a plain, unaddressed line', () => {
    const issues: GraphValidationIssue[] = [
      { code: 'TOPOLOGY_CYCLE', message: 'cycle detected among 2 node(s)' },
    ];
    const feedback = buildDesignFeedback(issues, {});
    expect(feedback).toBe('1. [TOPOLOGY_CYCLE]: cycle detected among 2 node(s)');
  });
});
