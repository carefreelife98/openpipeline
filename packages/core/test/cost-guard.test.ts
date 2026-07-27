import { describe, it, expect } from 'vitest';

import { createCostGuard, PipelineCostCapError } from '../src/cost-guard.js';
import type { CostBundle } from '../src/cost.js';

function cost(dollars: number): CostBundle {
  return { tokens: { input: 0, output: 0, total: 0 }, dollars, llmCalls: 1 };
}

describe('createCostGuard', () => {
  it('never throws when capUsd is undefined (unlimited)', () => {
    const guard = createCostGuard(undefined);
    guard.add(cost(1_000_000));
    expect(() => {
      guard.check();
    }).not.toThrow();
  });

  it('does not throw while accumulated spend is within the cap', () => {
    const guard = createCostGuard(5);
    guard.add(cost(3));
    expect(() => {
      guard.check();
    }).not.toThrow();
  });

  it('throws PipelineCostCapError once accumulated spend exceeds the cap', () => {
    const guard = createCostGuard(5);
    guard.add(cost(3));
    guard.add(cost(3)); // 6 > 5
    expect(() => {
      guard.check();
    }).toThrow(PipelineCostCapError);
  });

  it('does not throw when spend equals the cap exactly (strictly-greater-than semantics)', () => {
    const guard = createCostGuard(5);
    guard.add(cost(5));
    expect(() => {
      guard.check();
    }).not.toThrow();
  });

  it('carries spentUsd/capUsd on the thrown error and mentions the node-boundary limitation', () => {
    const guard = createCostGuard(2);
    guard.add(cost(2.5));
    try {
      guard.check();
      throw new Error('expected guard.check() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineCostCapError);
      const capErr = err as PipelineCostCapError;
      expect(capErr.spentUsd).toBe(2.5);
      expect(capErr.capUsd).toBe(2);
      expect(capErr.message).toMatch(/node boundar/i);
    }
  });
});
