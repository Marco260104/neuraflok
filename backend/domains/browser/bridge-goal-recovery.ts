import type { GoalWait } from '../../../contracts/automation/goal-progress.js';
import type { RecoveryCountdown } from '../../../contracts/recovery.js';
import { waitingForSubAgents } from '../automation/agents.js';
import {
  consumeGoalReplyForInputNow,
  goalPendingReplyFor,
  goalReplySourceTurn,
  goalViewFor,
  loopAfterTurnFor,
  setGoalReplyActiveNow,
  withdrawSilenceGoalReplyNow
} from '../automation/goal.js';
import { runningToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { inputBeforeGoal } from '../sessions/input/input.js';
import {
  findSessionByConversation,
  getSession,
  readCompletedFinal,
  readRecentEvents,
  turnHasMcpCall
} from '../sessions/history/store.js';
import type { ActivityGrant } from './session-activity.js';

type Runtime = {
  activeUntil: Map<string, ActivityGrant>;
  chatIsWorking: (conversationId: string) => boolean;
  lastAttributedCallAt: Map<string, number>;
  sessionRecoveryCountdowns: (sessionId: string, conversationId: string) => Promise<RecoveryCountdown[]>;
};

export function createBridgeGoalRecovery(runtime: Runtime) {
  const { activeUntil, chatIsWorking, lastAttributedCallAt, sessionRecoveryCountdowns } = runtime;

  async function extendedSilenceWindowFor(conversationId: string, sessionId?: string): Promise<boolean> {
    const grant = activeUntil.get(conversationId);
    return Boolean(grant && (!sessionId || grant.sessionId === sessionId) && grant.model === 'pro');
  }

  async function silenceContinuationAllowed(conversationId: string, sessionId?: string): Promise<boolean> {
    const session = sessionId ? await getSession(sessionId) : await findSessionByConversation(conversationId, { requireUnique: true });
    if (!session || session.conversationId !== conversationId) return false;
    const grant = activeUntil.get(conversationId);
    const pending = goalPendingReplyFor(conversationId);
    // Historical automatic silence decisions cannot be reused as current Goal replies.
    if (pending && !pending.explicitActivation) return false;
    if (pending?.silencePro && !loopAfterTurnFor(conversationId)) return false;
    const sourceTurnId = pending ? pending.silenceSourceTurnId :
      grant?.sessionId === session.id && (grant.model !== 'pro' || loopAfterTurnFor(conversationId)) ? grant.turnId : null;
    if (!sourceTurnId) return false;
    const starts = await readRecentEvents(session.id, 1, { kinds: ['turn_start'] });
    const start = starts[0];
    if (!start || start.turnId !== sourceTurnId) return false;
    if (!await turnHasMcpCall(session.id, conversationId, sourceTurnId)) return false;
    if (pending && loopAfterTurnFor(conversationId)) {
      const work = await readRecentEvents(session.id, 1, { kinds: ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start'] });
      // Replayed or revised historical events are not new authored work.
      if (work.some(event => event.time > pending.acceptedAt)) return false;
      // A late failed-view observation must retain the ticket earned by the confirmed reload.
      if (grant?.turnId === sourceTurnId && !grant.thinkingFailed && grant.evidenceAt > pending.acceptedAt) return false;
    }
    return !pending || goalPendingReplyFor(conversationId)?.replyId === pending.replyId;
  }

  async function suppressProSilence(conversationId: string): Promise<boolean> {
    const pending = goalPendingReplyFor(conversationId);
    const draft = goalViewFor(conversationId);
    if (!(pending?.turnId.startsWith('g-silence-') || pending?.replyId.startsWith('silence:') ||
        draft?.turnId.startsWith('g-silence-'))) return false;
    if (await silenceContinuationAllowed(conversationId)) return false;
    const latest = goalPendingReplyFor(conversationId);
    const currentDraft = goalViewFor(conversationId);
    if (latest?.replyId !== pending?.replyId || currentDraft?.token !== draft?.token) return false;
    if (latest) await withdrawSilenceGoalReplyNow(conversationId, latest.replyId);
    else await setGoalReplyActiveNow(conversationId, false);
    return true;
  }

  async function revokeSilenceLoop(conversationId: string): Promise<void> {
    const pending = goalPendingReplyFor(conversationId);
    if (pending?.silenceSourceTurnId) await withdrawSilenceGoalReplyNow(conversationId, pending.replyId);
  }

  async function goalInputPriority(conversationId: string, sessionId: string, turnId?: string): Promise<'queued' | 'consumed' | null> {
    const pending = goalPendingReplyFor(conversationId);
    const original = pending && pending.turnId === turnId ? pending.silenceSourceTurnId ?? turnId : turnId;
    const source = original ? await goalReplySourceTurn(sessionId, original) : undefined;
    const priority = await inputBeforeGoal(sessionId, source);
    if (priority === 'consumed' && source) await consumeGoalReplyForInputNow(conversationId, sessionId, source);
    return priority;
  }

  async function goalWaitFor(conversationId: string, sessionId: string, now = Date.now(), closed = false): Promise<GoalWait | null> {
    const pending = goalPendingReplyFor(conversationId);
    if (!pending) {
      const countdowns = await sessionRecoveryCountdowns(sessionId, conversationId);
      const visible = countdowns.find(row => row.kind === 'silence' && (row.visibleAt ?? 0) <= now && row.deadline > now);
      return visible ? { reason: 'silence', until: visible.deadline } : null;
    }
    if (runningToolCalls(conversationId) > 0) return { reason: 'tools' };
    // The next automatic instruction waits until the exact chat's workers finish.
    if (waitingForSubAgents(conversationId)) return { reason: 'workers' };
    // A closed page cannot settle the reply; recovery will collect it when the page returns.
    if (closed) return { reason: 'closed' };
    if ((pending.listenUntil ?? 0) > now) return { reason: pending.silenceSourceTurnId ? 'listening' : 'native-busy', until: pending.listenUntil };
    const grant = activeUntil.get(conversationId);
    if (grant?.sessionId === sessionId && grant.mcpBacked && !grant.thinkingFailed && grant.until > now)
      return { reason: 'quiet', until: grant.until };
    return { reason: 'settling' };
  }

  async function chatStillWorking(conversationId: string, turnId: string, sessionId: string, now = Date.now()): Promise<boolean> {
    if (runningToolCalls(conversationId) > 0) return true;
    const workGrant = activeUntil.get(conversationId);
    if (workGrant?.sessionId === sessionId && workGrant.mcpBacked && !workGrant.thinkingFailed && workGrant.until > now) return true;
    if (!turnId.startsWith('g-silence-') && chatIsWorking(conversationId)) return true;
    const last = lastAttributedCallAt.get(conversationId);
    const pro = await extendedSilenceWindowFor(conversationId, sessionId);
    const pending = goalPendingReplyFor(conversationId);
    if (pending?.turnId === turnId && (pending.listenUntil ?? 0) > now) return true;
    if (pending?.turnId === turnId && pending.replyId.startsWith('activation:')) {
      const [end] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end', 'user_message'] });
      // Explicit activation is valid only for the exact failed or stopped answer it names.
      return end?.kind !== 'turn_end' || end.turnId !== turnId || end.seq !== pending.eventSeq ||
        !(end.outcome === 'stopped' || (end.outcome === 'failed' && end.reason === 'thinking_failed')) ||
        (last !== undefined && last > end.time) || runningToolCalls(conversationId) > 0 ||
        chatIsWorking(conversationId) || goalPendingReplyFor(conversationId)?.acceptedAt !== pending.acceptedAt;
    }
    if (pro && turnId.startsWith('g-silence-') && !loopAfterTurnFor(conversationId)) return true;
    if (turnId.startsWith('g-silence-') && await silenceContinuationAllowed(conversationId, sessionId)) return false;
    if (!await readCompletedFinal(sessionId, conversationId, turnId)) return true;
    // Durable reads may race with new calls, so recheck live evidence before delivery.
    return runningToolCalls(conversationId) > 0 || chatIsWorking(conversationId) ||
      lastAttributedCallAt.get(conversationId) !== last;
  }

  async function failedCompactionTurnCurrent(conversationId: string, sessionId: string, turnId: string): Promise<boolean> {
    // A historical failure is not eligible; the exact current failed turn must still be the session tail.
    const before = await getSession(sessionId);
    if (!before || before.conversationId !== conversationId || before.activeTurnId) return false;
    const [last] = await readRecentEvents(sessionId, 1, {
      kinds: ['turn_start', 'turn_end', 'user_message', 'assistant_message', 'tool_call', 'page_tool']
    });
    if (last?.kind !== 'turn_end' || last.turnId !== turnId || last.outcome !== 'failed') return false;
    if (await readCompletedFinal(sessionId, conversationId, turnId)) return false;
    const after = await getSession(sessionId);
    return !!after && after.conversationId === conversationId && !after.activeTurnId && after.events === before.events;
  }

  return {
    chatStillWorking,
    extendedSilenceWindowFor,
    failedCompactionTurnCurrent,
    goalInputPriority,
    goalWaitFor,
    revokeSilenceLoop,
    silenceContinuationAllowed,
    suppressProSilence
  };
}
