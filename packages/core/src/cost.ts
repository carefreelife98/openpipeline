// Cost tracking primitives. The engine accumulates a CostBundle per node and
// per run; it never enforces quotas (a host concern). An optional per-run cost
// cap is the only built-in guard, wired in the runtime package.

export interface CostTokens {
  input: number;
  output: number;
  total: number;
}

export interface CostBundle {
  tokens: CostTokens;
  dollars: number;
  llmCalls: number;
}

export const ZERO_COST: CostBundle = {
  tokens: { input: 0, output: 0, total: 0 },
  dollars: 0,
  llmCalls: 0,
};

export function mergeCost(
  existing: CostBundle | undefined,
  updates: CostBundle | undefined
): CostBundle {
  const e = existing ?? ZERO_COST;
  const u = updates ?? ZERO_COST;
  return {
    tokens: {
      input: e.tokens.input + u.tokens.input,
      output: e.tokens.output + u.tokens.output,
      total: e.tokens.total + u.tokens.total,
    },
    dollars: e.dollars + u.dollars,
    llmCalls: e.llmCalls + u.llmCalls,
  };
}

export interface CostAccumulator {
  add(cost: CostBundle): void;
  total(): CostBundle;
}

export function createCostAccumulator(): CostAccumulator {
  let acc: CostBundle = { ...ZERO_COST, tokens: { ...ZERO_COST.tokens } };
  return {
    add(cost) {
      acc = {
        tokens: {
          input: acc.tokens.input + cost.tokens.input,
          output: acc.tokens.output + cost.tokens.output,
          total: acc.tokens.total + cost.tokens.total,
        },
        dollars: acc.dollars + cost.dollars,
        llmCalls: acc.llmCalls + cost.llmCalls,
      };
    },
    total() {
      return acc;
    },
  };
}
