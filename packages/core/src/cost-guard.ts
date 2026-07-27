import type { CostBundle } from './cost.js';

/**
 * Thrown by {@link CostGuard.check} once accumulated run spend exceeds the
 * configured cap. The cap is enforced at node boundaries (after a node's
 * SUCCESS step finishes) — it can never preempt a node mid-handler, so the
 * node that crosses the cap has already billed its own spend. This is an
 * intentional, documented limitation (a true mid-handler cutoff would require
 * cooperative cancellation inside every handler, which core cannot mandate),
 * not a bug (#K9).
 */
export class PipelineCostCapError extends Error {
  override readonly name = 'PipelineCostCapError';
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number
  ) {
    super(
      `COST_CAP: run spend $${spentUsd.toFixed(4)} exceeded cap $${capUsd.toFixed(2)}. ` +
        `Note: the cap is checked at node boundaries — the node that crossed it has already billed.`
    );
  }
}

/**
 * Per-run spend guard. `add` accumulates dollars from every node (success or
 * failure); `check` throws {@link PipelineCostCapError} once the running total
 * exceeds `capUsd`. `capUsd: undefined` means unlimited (never throws).
 *
 * Created fresh per run by the engine and flowed through
 * `RunnableConfig.configurable.costGuard` (never baked into compile-time node
 * deps) — compiled graphs are LRU-cached, so a closure-captured guard would
 * leak the first run's guard (and its budget) into every later run that hits
 * the same cache entry.
 */
export interface CostGuard {
  add(cost: CostBundle): void;
  /** @throws {PipelineCostCapError} if accumulated spend exceeds the cap. */
  check(): void;
}

export function createCostGuard(capUsd?: number): CostGuard {
  let spentUsd = 0;
  return {
    add(cost: CostBundle): void {
      spentUsd += cost.dollars;
    },
    check(): void {
      if (capUsd !== undefined && spentUsd > capUsd) {
        throw new PipelineCostCapError(spentUsd, capUsd);
      }
    },
  };
}
