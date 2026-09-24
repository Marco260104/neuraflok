import { GOAL_REASONING_LEVELS, type GoalReasoning } from '../types.js';

export type GoalEffort = Exclude<GoalReasoning, 'default'>;

export interface GoalModelReasoning {
  supportedEfforts?: GoalEffort[] | null;
  defaultEffort?: GoalEffort;
  mandatory: boolean;
}

export interface GoalModel {
  id: string;
  name: string;
  created: number;
  contextLength: number;
  reasoning?: GoalModelReasoning;
}

const MAX_CATALOG_EFFORTS = 32;
const EFFORTS = new Set<string>(GOAL_REASONING_LEVELS.filter(level => level !== 'default'));

function isGoalEffort(value: unknown): value is GoalEffort {
  return typeof value === 'string' && EFFORTS.has(value);
}

const STRONGEST_FIRST: readonly GoalEffort[] = Object.freeze(
  [...GOAL_REASONING_LEVELS].reverse().filter(isGoalEffort)
);

export function parseGoalModelReasoning(value: unknown): GoalModelReasoning | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  const parsed: GoalModelReasoning = { mandatory: source.mandatory === true };
  const rawEfforts = source.supported_efforts;

  if (rawEfforts === null) {
    parsed.supportedEfforts = null;
  } else if (Array.isArray(rawEfforts)) {
    const uniqueEfforts = new Set<GoalEffort>();
    for (const candidate of rawEfforts.slice(0, MAX_CATALOG_EFFORTS)) {
      if (isGoalEffort(candidate)) uniqueEfforts.add(candidate);
    }
    parsed.supportedEfforts = [...uniqueEfforts];
  }

  if (isGoalEffort(source.default_effort)) parsed.defaultEffort = source.default_effort;
  return parsed;
}

export function goalModelEfforts(model: GoalModel | undefined, custom = false): GoalEffort[] {
  const metadata = model?.reasoning;
  const catalogue = metadata?.supportedEfforts;
  const offered = custom || catalogue === null ? STRONGEST_FIRST : catalogue ?? [];
  const permitted = metadata?.mandatory === true ? offered.filter(effort => effort !== 'none') : offered;
  return [...permitted];
}
