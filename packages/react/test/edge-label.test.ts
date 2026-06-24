import { describe, it, expect } from 'vitest';

import { branchLabelOf } from '../src/lib/edge-label.js';

// The DeletableEdge component itself only renders inside a real <ReactFlow>
// graph (BaseEdge + EdgeLabelRenderer portal), which jsdom can't measure — so
// its branch-label decision is extracted here as a pure function and tested
// directly. Full edge render + delete-click is a tracked E2E follow-up.
describe('branchLabelOf', () => {
  it('returns "true" for a true-branch edge', () => {
    expect(branchLabelOf('true')).toBe('true');
  });

  it('returns "false" for a false-branch edge', () => {
    expect(branchLabelOf('false')).toBe('false');
  });

  it('returns null for a plain edge (no branch label)', () => {
    expect(branchLabelOf(null)).toBeNull();
    expect(branchLabelOf(undefined)).toBeNull();
    expect(branchLabelOf('')).toBeNull();
  });

  it('returns null for any non-branch label string', () => {
    expect(branchLabelOf('maybe')).toBeNull();
    expect(branchLabelOf('TRUE')).toBeNull();
  });
});
