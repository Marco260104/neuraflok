import { BROWSER_PICKUP_MAX_ATTEMPTS } from '../../../contracts/recovery.js';
import { writeDurableNow, writeDurableSoon } from '../../persistence/durable.js';

export interface GoalReplyObligation {
  explicitActivation?: true;
  silenceSourceTurnId?: string;
  silencePro?: boolean;
  listenUntil?: number;
  recoveryStopClaimed?: true;
  pickupAttempts?: number;
  pickupNextAt?: number;
  pickupStoppedAt?: number;
  conversationId: string;
  sessionId: string;
  replyId: string;
  turnId: string;
  eventSeq: number;
  acceptedAt: number;
  state: 'pending' | 'handled';
}

export const GOAL_REPLIES_STATE = 'goal-replies';

export interface GoalRepliesSnapshot {
  version: 1;
  savedAt: number;
  replies: GoalReplyObligation[];
}

const GOAL_REPLY_TTL_MS = 12 * 60 * 60_000;
const MAX_GOAL_REPLIES = 200;
const replies = new Map<string, GoalReplyObligation>();

function boundReplies(now: number): void {
  for (const reply of replies.values()) {
    if (reply.state === 'pending' && now - reply.acceptedAt >= GOAL_REPLY_TTL_MS) reply.state = 'handled';
  }
  if (replies.size <= MAX_GOAL_REPLIES) return;
  const oldestFirst = [...replies.values()].sort((a, b) => a.acceptedAt - b.acceptedAt);
  for (const reply of oldestFirst.slice(0, replies.size - MAX_GOAL_REPLIES)) replies.delete(reply.conversationId);
}

export function goalReplyFor(conversationId: string): Readonly<GoalReplyObligation> | undefined {
  return replies.get(conversationId);
}

export function allGoalReplies(): ReadonlyArray<Readonly<GoalReplyObligation>> {
  return [...replies.values()];
}

export function goalReplyCount(): number {
  return replies.size;
}

export function goalReplyExpired(reply: Readonly<GoalReplyObligation>, now = Date.now()): boolean {
  return now - reply.acceptedAt >= GOAL_REPLY_TTL_MS;
}

export function setGoalReply(conversationId: string, reply: GoalReplyObligation): void {
  replies.set(conversationId, reply);
}

export function updateGoalReply(
  conversationId: string,
  expected: Readonly<GoalReplyObligation>,
  update: (reply: GoalReplyObligation) => void
): boolean {
  const current = replies.get(conversationId);
  if (current !== expected) return false;
  update(current);
  return true;
}

export function deleteGoalReply(conversationId: string, expected?: Readonly<GoalReplyObligation>): boolean {
  if (expected && replies.get(conversationId) !== expected) return false;
  return replies.delete(conversationId);
}

export function clearGoalReplies(): void {
  replies.clear();
}

export function replaceGoalReplies(next: readonly GoalReplyObligation[]): void {
  replies.clear();
  for (const reply of next) replies.set(reply.conversationId, { ...reply });
}

export function snapshotGoalReplies(): GoalRepliesSnapshot {
  boundReplies(Date.now());
  return { version: 1, savedAt: Date.now(), replies: [...replies.values()].map(reply => ({ ...reply })) };
}

export function restoreGoalReplies(snapshot: GoalRepliesSnapshot | null): void {
  replies.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.replies)) return;
  for (const raw of snapshot.replies) {
    if (
      !raw ||
      !/^[0-9a-z-]{8,256}$/i.test(raw.conversationId) ||
      !raw.sessionId ||
      !raw.replyId ||
      !raw.turnId ||
      !Number.isSafeInteger(raw.eventSeq) ||
      raw.eventSeq < 0 ||
      (raw.eventSeq === 0 && raw.replyId !== `turn:${raw.turnId}`.slice(0, 200)) ||
      !Number.isSafeInteger(raw.acceptedAt) ||
      raw.acceptedAt <= 0 ||
      (raw.state !== 'pending' && raw.state !== 'handled')
    ) continue;
    replies.set(raw.conversationId, {
      conversationId: raw.conversationId,
      sessionId: String(raw.sessionId).slice(0, 200),
      replyId: String(raw.replyId).slice(0, 200),
      turnId: String(raw.turnId).slice(0, 200),
      ...(typeof raw.silenceSourceTurnId === 'string' && raw.silenceSourceTurnId ?
        { silenceSourceTurnId: raw.silenceSourceTurnId.slice(0, 200) } : {}),
      ...(Number.isSafeInteger(raw.listenUntil) && raw.listenUntil! > 0 ? { listenUntil: raw.listenUntil } : {}),
      ...(raw.silencePro === true ? { silencePro: true } : {}),
      ...(raw.recoveryStopClaimed === true ? { recoveryStopClaimed: true } : {}),
      ...(Number.isSafeInteger(raw.pickupAttempts) && raw.pickupAttempts! >= 0
        ? { pickupAttempts: Math.min(BROWSER_PICKUP_MAX_ATTEMPTS, raw.pickupAttempts!) } : {}),
      ...(Number.isSafeInteger(raw.pickupNextAt) && raw.pickupNextAt! > 0 ? { pickupNextAt: raw.pickupNextAt } : {}),
      ...(Number.isSafeInteger(raw.pickupStoppedAt) && raw.pickupStoppedAt! > 0
        ? { pickupStoppedAt: raw.pickupStoppedAt }
        : Number.isSafeInteger(raw.pickupAttempts) && raw.pickupAttempts! >= BROWSER_PICKUP_MAX_ATTEMPTS
          ? { pickupStoppedAt: raw.acceptedAt } : {}),
      ...(raw.explicitActivation === true ? { explicitActivation: true } : {}),
      eventSeq: raw.eventSeq,
      acceptedAt: raw.acceptedAt,
      state: raw.state
    });
  }
  boundReplies(Date.now());
}

export function persistGoalRepliesSoon(): void {
  writeDurableSoon(GOAL_REPLIES_STATE, snapshotGoalReplies());
}

export function persistGoalRepliesNow(): Promise<void> {
  return writeDurableNow(GOAL_REPLIES_STATE, snapshotGoalReplies());
}
