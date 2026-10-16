import type { GoalBackend, GoalMode } from '../../../contracts/types.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { writeDurableSoon } from '../../persistence/durable.js';
import { notifyGoalChange } from './goal-events.js';
import {
  invalidateGoalControlWrites,
  pendingGoalSwitchWrites,
  saveGoalControl
} from './goal-control-writes.js';

export const GOAL_SWITCHES_STATE = 'goal-switches';

type GoalSwitchRow = {
  enabled: boolean;
  mode: GoalMode;
  afterTurn?: boolean;
  at: number;
  role?: 'decision';
  sourceSessionId?: string;
  context?: { count: number; hash: string; instructions: string };
};

export interface GoalSwitchesSnapshot {
  version: 1;
  savedAt: number;
  switches: Array<{ conversationId: string } & GoalSwitchRow>;
}

const MAX_GOAL_SWITCHES = 400;
const switches = new Map<string, GoalSwitchRow>();

function boundSwitches(target: Map<string, GoalSwitchRow> = switches): void {
  if (target.size <= MAX_GOAL_SWITCHES) return;
  const removable = [...target.entries()]
    .filter(([, row]) => row.role !== 'decision')
    .sort((left, right) => left[1].at - right[1].at);
  const excess = target.size - MAX_GOAL_SWITCHES;
  for (const [conversationId] of removable.slice(0, excess)) target.delete(conversationId);
}

function makeSnapshot(source: ReadonlyMap<string, GoalSwitchRow>): GoalSwitchesSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    switches: [...source].map(([conversationId, row]) => ({ conversationId, ...row }))
  };
}

export function snapshotGoalSwitches(): GoalSwitchesSnapshot {
  boundSwitches();
  return makeSnapshot(switches);
}

function publishSwitches(next: ReadonlyMap<string, GoalSwitchRow>): void {
  switches.clear();
  for (const [conversationId, row] of next) switches.set(conversationId, row);
}

export function restoreGoalSwitches(snapshot: GoalSwitchesSnapshot | null): void {
  invalidateGoalControlWrites(pendingGoalSwitchWrites);
  switches.clear();
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.switches)) return;
  for (const row of snapshot.switches) {
    if (!row || typeof row.conversationId !== 'string' || !/^[0-9a-z-]{8,256}$/i.test(row.conversationId)) continue;
    if (typeof row.enabled !== 'boolean' || (row.mode !== 'goal' && row.mode !== 'loop')) continue;
    const at = Number.isSafeInteger(row.at) && row.at > 0 ? row.at : Date.now();
    const hasUniqueSource = row.role === 'decision' && typeof row.sourceSessionId === 'string' &&
      /^[\w-]{8,64}$/.test(row.sourceSessionId) &&
      ![...switches.values()].some(existing => existing.sourceSessionId === row.sourceSessionId);
    const sourceSessionId = hasUniqueSource ? row.sourceSessionId : undefined;
    const context = sourceSessionId && row.context && Number.isSafeInteger(row.context.count) && row.context.count >= 0 &&
      /^[a-f0-9]{64}$/.test(row.context.hash) && /^[a-f0-9]{64}$/.test(row.context.instructions)
      ? row.context
      : undefined;
    switches.set(row.conversationId, {
      enabled: row.role === 'decision' ? false : row.enabled,
      mode: row.mode,
      at,
      ...(row.afterTurn === true && row.role !== 'decision' ? { afterTurn: true } : {}),
      ...(row.role === 'decision' ? { role: 'decision' as const, sourceSessionId, context } : {})
    });
  }
  boundSwitches();
}

function persistSwitches(): void {
  writeDurableSoon(GOAL_SWITCHES_STATE, snapshotGoalSwitches());
}

export function goalSwitchFor(conversationId: string): {
  enabled: boolean;
  mode: GoalMode;
  own: boolean;
  afterTurn: boolean;
} {
  const current = switches.get(conversationId);
  if (current) {
    return {
      enabled: current.role !== 'decision' && current.enabled,
      mode: current.mode,
      own: true,
      afterTurn: current.afterTurn === true
    };
  }
  const configured = getConfig().goal;
  return { enabled: configured.enabled, mode: configured.mode, own: false, afterTurn: false };
}

export function goalDrivingMode(conversationId?: string): GoalMode {
  const current = conversationId ? goalSwitchFor(conversationId) : getConfig().goal;
  return current.enabled && current.mode === 'loop' ? 'loop' : 'goal';
}

export function automaticFinishEnabled(conversationId: string): boolean {
  return goalSwitchFor(conversationId).enabled;
}

export function isGoalDecisionChat(conversationId: string): boolean {
  return switches.get(conversationId)?.role === 'decision';
}

export function registerGoalDecisionChat(conversationId: string, sourceSessionId?: string): Promise<void> {
  return saveGoalControl<void>(
    pendingGoalSwitchWrites,
    conversationId,
    GOAL_SWITCHES_STATE,
    snapshotGoalSwitches,
    targetConversationId => {
      if (!/^[0-9a-z-]{8,256}$/i.test(targetConversationId)) throw new Error('bad_conversation_id');
      const existing = switches.get(targetConversationId);
      if (sourceSessionId && !/^[\w-]{8,64}$/.test(sourceSessionId)) throw new Error('bad_source_session_id');
      if (sourceSessionId && existing?.sourceSessionId && existing.sourceSessionId !== sourceSessionId) {
        throw new Error('goal_helper_wrong_source');
      }
      const sourceUsedElsewhere = sourceSessionId && [...switches].some(([id, row]) =>
        id !== targetConversationId && row.sourceSessionId === sourceSessionId
      );
      if (sourceUsedElsewhere) throw new Error('goal_helper_already_bound');
      if (existing?.role === 'decision' && (!sourceSessionId || existing.sourceSessionId === sourceSessionId)) {
        return { result: undefined };
      }
      const decisionCount = [...switches.values()].filter(row => row.role === 'decision').length;
      if (existing?.role !== 'decision' && decisionCount >= MAX_GOAL_SWITCHES) throw new Error('goal_helper_capacity');

      const next = new Map(switches);
      next.set(targetConversationId, {
        enabled: false,
        mode: existing?.mode ?? 'goal',
        at: Date.now(),
        role: 'decision',
        sourceSessionId
      });
      boundSwitches(next);
      return { snapshot: makeSnapshot(next), publish: () => publishSwitches(next) };
    }
  );
}

export function goalSwitchEnabledFor(conversationId: string): boolean {
  return goalSwitchFor(conversationId).enabled;
}

export function applyGoalSwitch<T extends { enabled: boolean; mode: GoalMode }>(
  goal: T,
  which: 'goal' | 'loop' | null,
  on: boolean | null
): T {
  if (which === null || on === null) return goal;
  if (on) return { ...goal, enabled: true, mode: which };
  return goal.enabled && goal.mode === which ? { ...goal, enabled: false } : goal;
}

export async function setGoalSwitchNow(
  conversationId: string,
  which: 'goal' | 'loop',
  on: boolean,
  afterTurn?: boolean
): Promise<{ enabled: boolean; mode: GoalMode }> {
  if (!on && goalSwitchFor(conversationId).mode === which) {
    invalidateGoalControlWrites(pendingGoalSwitchWrites, [conversationId]);
  }
  return saveGoalControl<{ enabled: boolean; mode: GoalMode }>(
    pendingGoalSwitchWrites,
    conversationId,
    GOAL_SWITCHES_STATE,
    snapshotGoalSwitches,
    targetConversationId => {
      const existing = switches.get(targetConversationId);
      if (existing?.role === 'decision') return { result: { enabled: false, mode: existing.mode } };
      if (!existing && [...switches.values()].filter(row => row.role === 'decision').length >= MAX_GOAL_SWITCHES) {
        throw new Error('goal_switch_capacity');
      }

      const nextValue = applyGoalSwitch(goalSwitchFor(targetConversationId), which, on);
      const next = new Map(switches);
      next.set(targetConversationId, {
        enabled: nextValue.enabled,
        mode: nextValue.mode,
        afterTurn: afterTurn ?? existing?.afterTurn ?? false,
        at: Date.now()
      });
      boundSwitches(next);
      return {
        snapshot: makeSnapshot(next),
        publish: () => {
          publishSwitches(next);
          notifyGoalChange();
          return { enabled: nextValue.enabled, mode: nextValue.mode };
        }
      };
    }
  );
}

export function clearAllGoalSwitches(): void {
  invalidateGoalControlWrites(pendingGoalSwitchWrites);
  if (switches.size === 0) return;
  for (const [conversationId, row] of switches) {
    if (row.role !== 'decision') switches.delete(conversationId);
  }
  persistSwitches();
}

export function clearGoalSwitch(conversationId: string): void {
  if (isGoalDecisionChat(conversationId)) return;
  invalidateGoalControlWrites(pendingGoalSwitchWrites, [conversationId]);
  if (switches.delete(conversationId)) persistSwitches();
}

export function moveGoalSwitch(fromConversationId: string, toConversationId: string): boolean {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;
  if (isGoalDecisionChat(fromConversationId) || isGoalDecisionChat(toConversationId)) return false;
  invalidateGoalControlWrites(pendingGoalSwitchWrites, [fromConversationId]);
  const row = switches.get(fromConversationId);
  if (!row) return false;
  invalidateGoalControlWrites(pendingGoalSwitchWrites, [toConversationId]);
  switches.delete(fromConversationId);
  switches.set(toConversationId, row);
  persistSwitches();
  return true;
}

export function goalBackendFor(mode: GoalMode): GoalBackend {
  const settings = getConfig().goal;
  return mode === 'loop' ? settings.loopBackend ?? 'web' : settings.backend ?? 'web';
}

export function goalSwitchGuard(conversationId: string): () => boolean {
  const observed = switches.get(conversationId);
  return () => switches.get(conversationId) === observed;
}

export function resetGoalSwitchesForTests(): void {
  invalidateGoalControlWrites(pendingGoalSwitchWrites);
  pendingGoalSwitchWrites.clear();
  switches.clear();
}
