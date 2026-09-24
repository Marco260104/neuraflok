import type { WebProviderId } from '../web-providers.js';

export interface UsageModelTokens {
  model: string;
  reasoningEffort: string | null;
  assumed: boolean;
  tokens: number;
}

export type UsageMessageProvider = WebProviderId | 'api';

export interface UsageMessageDay {
  date: string;
  sent: number;
}

export interface UsageOverview {
  contextTokenCap: number;
  messages: { through: number; days: UsageMessageDay[] };
  days: Array<{ date: string; tokens: number; models: UsageModelTokens[] }>;
  models: UsageModelTokens[];
  tokens: number;
  sessions: number;
}

export interface UsageFormula {
  divisor: number;
  multiplier: number;
  rates: Record<string, number | null>;
}

export interface UsageEstimate {
  tokens: number;
  cost: number;
  unpricedTokens: number;
}

export interface UsageModelGroup {
  model: string;
  reasoningEffort: string | null;
  assumed: boolean;
  sources: UsageModelTokens[];
}
