import type { TimelineTurns } from '../../../contracts/chronology.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { getSession, readCompletedFinal, readLatestUserMessage, readRecentEvents } from '../sessions/history/store.js';
import type { Repair } from './bridge-recovery-types.js';

interface Runtime {
  repairsInFlight: Map<string, Repair>;
  turnRepairSpent: Map<string, { sessionId: string; turnKey: string; token: string; at: number }>;
  assistantRecoveryCancelled: Map<string, { sessionId: string; turnKey: string }>;
}

export function createBridgeAssistantRecovery(runtime: Runtime) {
  const { repairsInFlight, turnRepairSpent, assistantRecoveryCancelled } = runtime;

  function assistantRecoveryCancelledFor(conversationId: string, sessionId: string, turnKey: string): boolean {
    const cancelled = assistantRecoveryCancelled.get(conversationId);
    return cancelled?.sessionId === sessionId && cancelled.turnKey === turnKey;
  }

  async function cancelAssistantRecovery(sessionId: string): Promise<boolean> {
    const conversationId = (await getSession(sessionId))?.conversationId;
    if (!conversationId) return false;
    const repair = repairsInFlight.get(conversationId);
    if (!repair || repair.reason !== 'assistant-error' || repair.sessionId !== sessionId || repair.state === 'done' ||
        repair.claimed || !repair.assistantSource) return false;
    assistantRecoveryCancelled.set(conversationId, { sessionId, turnKey: repair.assistantSource.key });
    repairsInFlight.delete(conversationId);
    logInfo(`bridge: the user cancelled the interrupted-response reload for ${conversationId}`);
    return true;
  }

  function settledQuestionOf(turns: TimelineTurns | undefined): string | null {
    if (!turns) return null;
    let newest: TimelineTurns[string] | null = null;
    for (const turn of Object.values(turns)) if (!newest || turn.origin > newest.origin) newest = turn;
    return newest && newest.endTime !== undefined && typeof newest.questionId === 'string' ? newest.questionId : null;
  }

  async function assistantRepairSource(sessionId: string): Promise<NonNullable<Repair['assistantSource']>> {
    const [start] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start'] });
    const turnId = start?.turnId ?? null;
    const question = await readLatestUserMessage(sessionId, turnId);
    const session = await getSession(sessionId);
    return { key: question ? `user:${question.messageId}` : `turn:${turnId ?? 'page'}`, turnId,
      completed: !!session?.conversationId && !!await readCompletedFinal(sessionId, session.conversationId, turnId) };
  }

  async function assistantRepairCurrent(conversationId: string, repair: Repair): Promise<boolean> {
    if (repair.reason !== 'assistant-error') return true;
    const source = repair.assistantSource;
    if (!source) return false;
    const question = await readLatestUserMessage(repair.sessionId, source.turnId);
    const [start] = question ? [] : await readRecentEvents(repair.sessionId, 1, { kinds: ['turn_start'] });
    const key = question ? `user:${question.messageId}` : `turn:${start?.turnId ?? 'page'}`;
    if (key !== source.key) return false;
    if (!source.completed && await readCompletedFinal(repair.sessionId, conversationId, source.turnId)) return false;
    const spent = turnRepairSpent.get(conversationId);
    return repair.state === 'done' || !spent || spent.sessionId !== repair.sessionId || spent.turnKey !== source.key ||
      (repair.claimed === true && spent.token === repair.token);
  }

  return { assistantRecoveryCancelledFor, cancelAssistantRecovery, settledQuestionOf, assistantRepairSource, assistantRepairCurrent };
}
