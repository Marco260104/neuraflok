import { BROWSER_PICKUP_MAX_ATTEMPTS } from '../../../contracts/recovery.js';
import type { GoalMode } from '../../../contracts/types.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { getSession, readRecentEvents, turnHasMcpCall } from '../sessions/history/store.js';
import { goalArmedFor } from './goal-activation.js';
import { goalSwitchFor } from './goal-switches.js';
import { allGoalReplies, deleteGoalReply, goalReplyExpired, goalReplyFor, persistGoalRepliesNow, persistGoalRepliesSoon, replaceGoalReplies, setGoalReply, snapshotGoalReplies, updateGoalReply, type GoalReplyObligation } from './goal-reply-ledger.js';

type Runtime = {
  astraFinishOnly(sessionId: string, conversationId: string): Promise<boolean>;
  goalKeyPresent(mode: GoalMode): Promise<boolean>;
  setGoalReplyActiveNow(conversationId: string, active: boolean): Promise<boolean>;
};

export function createGoalReplyRecovery(runtime: Runtime) {
  const { astraFinishOnly, goalKeyPresent, setGoalReplyActiveNow } = runtime;
  function goalPendingReplyFor(
    conversationId: string
  ): Pick<GoalReplyObligation, 'replyId' | 'turnId' | 'eventSeq' | 'acceptedAt' | 'silenceSourceTurnId' | 'silencePro' | 'listenUntil' | 'explicitActivation' | 'pickupAttempts' | 'pickupNextAt' | 'pickupStoppedAt'> | null {
    const reply = goalReplyFor(conversationId);
    // Expiry is read here as well as pruned on write, because the ledger is only pruned when something writes to it. A chat reopened after the window must not be offered work the next prune would have thrown away.
    if (reply && goalReplyExpired(reply)) return null;
    return reply?.state === 'pending'
      ? { replyId: reply.replyId, turnId: reply.turnId, eventSeq: reply.eventSeq, acceptedAt: reply.acceptedAt,
        ...(reply.explicitActivation ? { explicitActivation: true as const } : {}),
        ...(reply.silenceSourceTurnId ? { silenceSourceTurnId: reply.silenceSourceTurnId } : {}),
        ...(reply.listenUntil ? { listenUntil: reply.listenUntil } : {}),
        ...(reply.silencePro ? { silencePro: true } : {}),
        ...(reply.pickupAttempts !== undefined ? { pickupAttempts: reply.pickupAttempts } : {}),
        ...(reply.pickupNextAt ? { pickupNextAt: reply.pickupNextAt } : {}),
        ...(reply.pickupStoppedAt ? { pickupStoppedAt: reply.pickupStoppedAt } : {}) }
      : null;
  }
  
  // Every chat that still owes one Goal decision, newest acceptance first. `goalPendingReplyFor` answers for a page that has come to ask. This answers for the app, which has to notice the chats that never will — the reason it exists at all is that the only trigger for a Goal draft lives in the page, so a conversation whose document died between the final answer and the draft request owes work that nothing was left alive to collect.
  function pendingGoalReplies(
    now = Date.now()
  ): Array<{ conversationId: string; sessionId: string; replyId: string; acceptedAt: number; pickupAttempts: number; pickupNextAt?: number; pickupStoppedAt?: number }> {
    const owed: Array<{ conversationId: string; sessionId: string; replyId: string; acceptedAt: number; pickupAttempts: number; pickupNextAt?: number; pickupStoppedAt?: number }> = [];
    for (const reply of allGoalReplies()) {
      if (reply.state !== 'pending' || goalReplyExpired(reply, now)) continue;
      owed.push({
        conversationId: reply.conversationId,
        sessionId: reply.sessionId,
        replyId: reply.replyId,
        acceptedAt: reply.acceptedAt,
        pickupAttempts: reply.pickupAttempts ?? 0,
        ...(reply.pickupNextAt ? { pickupNextAt: reply.pickupNextAt } : {}),
        ...(reply.pickupStoppedAt ? { pickupStoppedAt: reply.pickupStoppedAt } : {})
      });
    }
    return owed.sort((a, b) => b.acceptedAt - a.acceptedAt);
  }
  
  /** Durably reserves one reload for this exact Goal reply before the browser can act. */
  async function recordGoalPickupAttemptNow(conversationId: string, replyId: string, at: number, nextAt?: number): Promise<{
    attempts: number; nextAt?: number; stoppedAt?: number
  } | null> {
    const reply = goalReplyFor(conversationId);
    if (!reply || reply.state !== 'pending' || reply.replyId !== replyId || reply.pickupStoppedAt ||
        (reply.pickupAttempts ?? 0) >= BROWSER_PICKUP_MAX_ATTEMPTS) return null;
    const previous = { ...reply };
    const attempts = (reply.pickupAttempts ?? 0) + 1;
    updateGoalReply(conversationId, reply, current => {
      current.pickupAttempts = attempts;
      if (attempts >= BROWSER_PICKUP_MAX_ATTEMPTS) {
        current.pickupStoppedAt = at;
        delete current.pickupNextAt;
      } else if (nextAt !== undefined) current.pickupNextAt = nextAt;
    });
    try {
      await persistGoalRepliesNow();
    } catch (error) {
      if (goalReplyFor(conversationId) === reply) setGoalReply(conversationId, previous);
      persistGoalRepliesSoon();
      throw error;
    }
    return { attempts, ...(reply.pickupNextAt ? { nextAt: reply.pickupNextAt } : {}),
      ...(reply.pickupStoppedAt ? { stoppedAt: reply.pickupStoppedAt } : {}) };
  }
  
  /** Mirrors a shared source-turn pickup budget onto its Goal owner, including while Goal is Off. */
  async function syncGoalPickupRecoveryNow(conversationId: string, replyId: string, state: {
    attempts: number; nextAt?: number; stoppedAt?: number
  }): Promise<boolean> {
    const reply = goalReplyFor(conversationId);
    if (!reply || reply.replyId !== replyId || !Number.isSafeInteger(state.attempts) || state.attempts < 0) return false;
    const attempts = Math.min(BROWSER_PICKUP_MAX_ATTEMPTS, Math.max(reply.pickupAttempts ?? 0, state.attempts));
    const stoppedAt = reply.pickupStoppedAt ?? state.stoppedAt;
    const nextAt = stoppedAt || attempts >= BROWSER_PICKUP_MAX_ATTEMPTS ? undefined
      : state.attempts >= (reply.pickupAttempts ?? 0) ? state.nextAt ?? reply.pickupNextAt : reply.pickupNextAt;
    if (reply.pickupAttempts === attempts && reply.pickupStoppedAt === stoppedAt && reply.pickupNextAt === nextAt) return true;
    const previous = { ...reply };
    updateGoalReply(conversationId, reply, current => {
      current.pickupAttempts = attempts;
      if (stoppedAt || attempts >= BROWSER_PICKUP_MAX_ATTEMPTS) {
        current.pickupStoppedAt = stoppedAt ?? Date.now();
        delete current.pickupNextAt;
      } else if (nextAt !== undefined) current.pickupNextAt = nextAt;
    });
    try {
      await persistGoalRepliesNow();
    } catch (error) {
      if (goalReplyFor(conversationId) === reply) setGoalReply(conversationId, previous);
      persistGoalRepliesSoon();
      throw error;
    }
    return true;
  }
  
  /** Freezes Goal eligibility at the durable recorder boundary. */
  async function acceptGoalReplyNow(input: {
    silenceSourceTurnId?: string;
    silencePro?: boolean;
    listenUntil?: number;
    conversationId: string;
    sessionId: string;
    replyId: string;
    turnId: string;
    eventSeq: number;
    blocked: boolean;
    /** Retain proved exhausted silence while Off without creating active debt. */
    handledOnly?: true;
    current?: () => boolean;
  }): Promise<void> {
    if (!input.handledOnly && await astraFinishOnly(input.sessionId, input.conversationId)) return;
    if (input.silenceSourceTurnId &&
        !await turnHasMcpCall(input.sessionId, input.conversationId, input.silenceSourceTurnId)) return;
    const current = goalReplyFor(input.conversationId);
    if (current?.replyId === input.replyId || (current && current.eventSeq > input.eventSeq)) return;
    const provisionalUpgrade = Boolean(
      current &&
        current.eventSeq === 0 &&
        current.turnId === input.turnId &&
        current.replyId === `turn:${input.turnId}`.slice(0, 200)
    );
    const before = current ? { ...current } : null;
    const bounded = snapshotGoalReplies().replies;
    const active =
      !input.handledOnly && !input.blocked &&
      getConfig().sessions.record &&
      goalArmedFor(input.conversationId) &&
      await goalKeyPresent(goalSwitchFor(input.conversationId).mode) &&
      (goalSwitchFor(input.conversationId).mode !== 'loop' ||
        await automaticLoopHasMcpWork(input.sessionId, input.conversationId, input.silenceSourceTurnId ?? input.turnId));
    if (input.current && !input.current()) return;
    setGoalReply(input.conversationId, {
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      replyId: input.replyId.slice(0, 200),
      turnId: input.turnId.slice(0, 200),
      ...(input.silenceSourceTurnId ? { silenceSourceTurnId: input.silenceSourceTurnId.slice(0, 200) } : {}),
      ...(input.silencePro ? { silencePro: true } : {}),
      ...(input.listenUntil ? { listenUntil: input.listenUntil } : {}),
      ...(provisionalUpgrade && current?.pickupAttempts !== undefined ? { pickupAttempts: current.pickupAttempts } : {}),
      ...(provisionalUpgrade && current?.pickupNextAt ? { pickupNextAt: current.pickupNextAt } : {}),
      ...(provisionalUpgrade && current?.pickupStoppedAt ? { pickupStoppedAt: current.pickupStoppedAt } : {}),
      eventSeq: input.eventSeq,
      // A later canonical message id strengthens the provisional row without reopening an acknowledged decision.
      acceptedAt: provisionalUpgrade ? current!.acceptedAt : Date.now(),
      state: provisionalUpgrade ? current!.state : active ? 'pending' : 'handled'
    });
    try {
      await persistGoalRepliesNow();
    } catch (error) {
      // The rejected write is one whole revision, so the rollback is too: the row this accept added and the expired rows it pruned go back together, leaving the ledger exactly as the decision found it.
      replaceGoalReplies(bounded);
      if (before) setGoalReply(input.conversationId, before);
      else deleteGoalReply(input.conversationId);
      persistGoalRepliesSoon();
      throw error;
    }
  }
  
  function handleGoalReply(conversationId: string, turnId?: string): void {
    const reply = goalReplyFor(conversationId);
    if (!reply || reply.state !== 'pending' || (turnId && reply.turnId !== turnId)) return;
    updateGoalReply(conversationId, reply, current => { current.state = 'handled'; });
    persistGoalRepliesSoon();
  }
  
  // A queued user message spends the same completed/silence source as Goal. Keep the handled Goal tombstone after the outbox's bounded receipt history ages out.
  async function consumeGoalReplyForInputNow(conversationId: string, sessionId: string, sourceTurnId: string): Promise<void> {
    const reply = goalReplyFor(conversationId);
    if (!reply || reply.sessionId !== sessionId || reply.state !== 'pending') return;
    const source = await goalReplySourceTurn(sessionId, reply.silenceSourceTurnId ?? reply.turnId);
    if (source !== sourceTurnId || goalReplyFor(conversationId) !== reply) return;
    await setGoalReplyActiveNow(conversationId, false);
  }
  
  /** Resolve only the exact canonical answer; never infer an alias from the latest turn. */
  async function goalReplySourceTurn(sessionId: string, turnId: string): Promise<string | undefined> {
    if (!turnId.startsWith('reply:')) return turnId;
    const events = await readRecentEvents(sessionId, 256, { kinds: ['assistant_message'] });
    return events.find(event => event.kind === 'assistant_message' && event.messageId === turnId.slice(6))?.turnId ?? undefined;
  }
  
  /** Automatic Loop pickup needs local tool execution evidence from this exact source. */
  async function automaticLoopHasMcpWork(sessionId: string, conversationId: string, turnId: string): Promise<boolean> {
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId) return false;
    const source = await goalReplySourceTurn(sessionId, turnId);
    return !!source && await turnHasMcpCall(sessionId, conversationId, source);
  }
  return { goalPendingReplyFor, pendingGoalReplies, recordGoalPickupAttemptNow, syncGoalPickupRecoveryNow,
    acceptGoalReplyNow, handleGoalReply, consumeGoalReplyForInputNow, goalReplySourceTurn, automaticLoopHasMcpWork };
}
