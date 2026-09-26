import { getConfig } from '../../infrastructure/settings/config.js';
import { writeDurableSnapshotSoon } from '../../persistence/durable.js';
import {
  invalidateGoalControlWrites,
  pendingGoalObjectiveWrites,
  retargetGoalControlWrites,
  saveGoalControl
} from './goal-control-writes.js';

export const GOAL_OBJECTIVES_STATE = 'goal-objectives';

export interface GoalObjectivesSnapshot {
  version: 1;
  savedAt: number;
  objectives: Array<{ conversationId: string; objective: string }>;
}

const objectives = new Map<string, string>();

export function goalObjectivePrompt(): string {
  return getConfig().goal.objectivePrompt;
}

export function goalLoopPrompt(): string {
  return getConfig().goal.loopPrompt;
}

function makeSnapshot(source: ReadonlyMap<string, string>): GoalObjectivesSnapshot {
  return {
    version: 1,
    savedAt: Date.now(),
    objectives: [...source].map(([conversationId, objective]) => ({ conversationId, objective }))
  };
}

export function snapshotGoalObjectives(): GoalObjectivesSnapshot {
  return makeSnapshot(objectives);
}

function persistObjectives(): void {
  writeDurableSnapshotSoon(GOAL_OBJECTIVES_STATE, snapshotGoalObjectives);
}

export function restoreGoalObjectives(snapshot: GoalObjectivesSnapshot | null): void {
  invalidateGoalControlWrites(pendingGoalObjectiveWrites);
  objectives.clear();
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.objectives)) return;
  for (const item of snapshot.objectives) {
    if (!item || typeof item.conversationId !== 'string' || !/^[0-9a-z-]{8,256}$/i.test(item.conversationId)) continue;
    if (typeof item.objective !== 'string') continue;
    const objective = item.objective.trim();
    if (objective) objectives.set(item.conversationId, objective);
  }
}

export function goalObjectiveFor(conversationId: string): string {
  return objectives.get(conversationId) ?? '';
}

export function setGoalObjective(conversationId: string, text: string): string {
  invalidateGoalControlWrites(pendingGoalObjectiveWrites, [conversationId]);
  const objective = text.trim();
  objectives.delete(conversationId);
  if (objective) objectives.set(conversationId, objective);
  persistObjectives();
  return objective;
}

export async function setGoalObjectiveNow(conversationId: string, text: string): Promise<string> {
  const objective = text.trim();
  return saveGoalControl(
    pendingGoalObjectiveWrites,
    conversationId,
    GOAL_OBJECTIVES_STATE,
    snapshotGoalObjectives,
    targetConversationId => {
      const staged = new Map(objectives);
      staged.delete(targetConversationId);
      if (objective) staged.set(targetConversationId, objective);
      return {
        snapshot: makeSnapshot(staged),
        publish: () => {
          objectives.delete(targetConversationId);
          if (objective) objectives.set(targetConversationId, objective);
          persistObjectives();
          return objective;
        }
      };
    }
  );
}

export function clearGoalObjective(conversationId: string): void {
  invalidateGoalControlWrites(pendingGoalObjectiveWrites, [conversationId]);
  if (objectives.delete(conversationId)) persistObjectives();
}

export function moveGoalObjective(fromConversationId: string, toConversationId: string): boolean {
  if (!fromConversationId || !toConversationId || fromConversationId === toConversationId) return false;
  invalidateGoalControlWrites(pendingGoalObjectiveWrites, [toConversationId]);
  const movedWrites = retargetGoalControlWrites(pendingGoalObjectiveWrites, fromConversationId, toConversationId);
  const objective = objectives.get(fromConversationId);
  if (!objective && movedWrites === 0) return false;
  objectives.delete(fromConversationId);
  if (objective) {
    objectives.delete(toConversationId);
    objectives.set(toConversationId, objective);
  }
  persistObjectives();
  return true;
}

export function resetGoalObjectivesForTests(): void {
  invalidateGoalControlWrites(pendingGoalObjectiveWrites);
  pendingGoalObjectiveWrites.clear();
  objectives.clear();
}
