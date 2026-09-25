import { writeDurableNow, writeDurableSoon } from '../../persistence/durable.js';

export type GoalControlWrite = {
  conversationId: string;
  invalidated: boolean;
  changed: boolean;
};

export type GoalControlStage<T> =
  | { snapshot: unknown; publish: () => T }
  | { result: T };

export const pendingGoalObjectiveWrites = new Set<GoalControlWrite>();
export const pendingGoalSwitchWrites = new Set<GoalControlWrite>();

let writeQueue: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(work: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(work, work);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function invalidateGoalControlWrites(
  pending: Set<GoalControlWrite>,
  conversations?: readonly string[]
): void {
  for (const write of pending) {
    write.changed = true;
    if (!conversations || conversations.includes(write.conversationId)) write.invalidated = true;
  }
}

export function retargetGoalControlWrites(
  pending: Set<GoalControlWrite>,
  fromConversationId: string,
  toConversationId: string
): number {
  let moved = 0;
  for (const write of pending) {
    write.changed = true;
    if (write.invalidated || write.conversationId !== fromConversationId) continue;
    write.conversationId = toConversationId;
    moved += 1;
  }
  return moved;
}

export function saveGoalControl<T>(
  pending: Set<GoalControlWrite>,
  conversationId: string,
  state: string,
  snapshot: () => unknown,
  stage: (targetConversationId: string) => GoalControlStage<T>
): Promise<T> {
  const write: GoalControlWrite = { conversationId, invalidated: false, changed: false };
  pending.add(write);
  return serializeWrite(async () => {
    let attempted = false;
    try {
      for (let revision = 0; revision < 8; revision++) {
        if (write.invalidated) throw new Error('Goal controls changed while saving; this request was superseded.');
        write.changed = false;
        const next = stage(write.conversationId);
        if ('result' in next) return next.result;
        attempted = true;
        await writeDurableNow(state, next.snapshot);
        if (write.invalidated) throw new Error('Goal controls changed while saving; this request was superseded.');
        if (!write.changed) return next.publish();
      }
      throw new Error('Goal controls kept changing during the save. No new control was accepted; retry when changes settle.');
    } catch (error) {
      if (attempted) await repairSnapshot(state, snapshot, write);
      throw error;
    } finally {
      pending.delete(write);
    }
  });
}

async function repairSnapshot(state: string, snapshot: () => unknown, write: GoalControlWrite): Promise<void> {
  for (let repair = 0; repair < 4; repair++) {
    write.changed = false;
    const accepted = snapshot();
    writeDurableSoon(state, accepted);
    try {
      await writeDurableNow(state, accepted);
    } catch {
      writeDurableSoon(state, snapshot());
      return;
    }
    if (!write.changed) return;
  }
  if (write.changed) writeDurableSoon(state, snapshot());
}

export function resetGoalControlWritesForTests(): void {
  invalidateGoalControlWrites(pendingGoalObjectiveWrites);
  invalidateGoalControlWrites(pendingGoalSwitchWrites);
  pendingGoalObjectiveWrites.clear();
  pendingGoalSwitchWrites.clear();
  writeQueue = Promise.resolve();
}
