import type { UsageEstimate, UsageFormula, UsageModelGroup, UsageModelTokens } from './types.js';

// Provider rates stay empty until a user supplies a rate for a recorded API model.
export const DEFAULT_USAGE_FORMULA: UsageFormula = { divisor: 2, multiplier: 1.2, rates: {} };

export function usageModelGroups(rows: readonly UsageModelTokens[]): UsageModelGroup[] {
  const groups = new Map<string, UsageModelGroup>();
  for (const row of rows) {
    const identity = { model: row.model, reasoningEffort: row.reasoningEffort, assumed: row.assumed };
    const key = usageModelKey(identity);
    const group = groups.get(key) ?? { ...identity, sources: [] };
    group.sources.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// Only an exact user-entered model rate can produce a cost estimate.
export function usageRate(model: string, formula: UsageFormula): number | null | undefined {
  return Object.hasOwn(formula.rates, model) ? formula.rates[model] : undefined;
}

export function usageModelKey(row: Pick<UsageModelTokens, 'model' | 'reasoningEffort' | 'assumed'>): string {
  return JSON.stringify([row.model, row.reasoningEffort, row.assumed]);
}

// Formula edits reproject cached token totals without rereading session history.
export function usageEstimate(rows: readonly UsageModelTokens[], formula: UsageFormula): UsageEstimate {
  let tokens = 0, cost = 0, unpricedTokens = 0;
  for (const row of rows) {
    const amount = row.tokens * 2 / formula.divisor;
    tokens += amount;
    const rate = usageRate(row.model, formula);
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) cost += amount / 1e6 * rate * formula.multiplier;
    else unpricedTokens += amount;
  }
  return { tokens, cost, unpricedTokens };
}
