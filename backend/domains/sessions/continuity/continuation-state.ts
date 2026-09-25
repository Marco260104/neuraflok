// Stores continuation state and publishes durable transitions before exposing them in memory.

import { writeDurableNow, writeDurableSoon } from '../../../persistence/durable.js';
import { releaseReplacementChatClaim } from './replacement-chat-gate.js';
import {
  CONTINUATIONS_STATE,
  durableRecord,
  normalizeRequestedModel as requestedModel,
  type Continuation,
  type ContinuationRecord,
  type ContinuationSnapshot
} from './continuation-records.js';
import { handoffAsked } from './continuation-lifecycle-policy.js';

export const byToken = new Map<string, Continuation>();

function snapshotWith(token?: string, replacement?: ContinuationRecord): ContinuationSnapshot {
  let replaced = false;
  const entries = [...byToken.values()].map((entry) => {
    if (entry.token === token && replacement) {
      replaced = true;
      return replacement;
    }
    return durableRecord(entry);
  });
  if (replacement && token && !replaced) entries.push(replacement);
  return {
    version: 1,
    savedAt: Date.now(),
    entries
  };
}

export function snapshotContinuations(): ContinuationSnapshot {
  return snapshotWith();
}

export function changed(): void {
  writeDurableSoon(CONTINUATIONS_STATE, snapshotContinuations());
}

export async function changedNow(): Promise<void> {
  await writeDurableNow(CONTINUATIONS_STATE, snapshotContinuations());
}

export async function persistNewContinuation(entry: Continuation): Promise<void> {
  try {
    await writeDurableNow(CONTINUATIONS_STATE, snapshotWith(entry.token, durableRecord(entry)));
  } catch (err) {
    writeDurableSoon(CONTINUATIONS_STATE, snapshotContinuations());
    throw err;
  }
  byToken.set(entry.token, entry);
}

function publishRecord(entry: Continuation, record: ContinuationRecord): void {
  if (record.state === 'committed' || record.state === 'aborted') releaseReplacementChatClaim(entry.token);
  entry.to = record.to;
  entry.requestedModel = requestedModel(record.requestedModel);
  entry.touchedAt = Math.max(entry.touchedAt, record.touchedAt ?? record.openedAt);
  entry.sourceProgress = record.sourceProgress ?? 0;
  entry.automatic = record.automatic === true;
  entry.state = record.state;
  entry.summary = record.summary;
  entry.handoffId = record.handoffId;
  entry.claimedBy = record.claimedBy;
  entry.sourceSend = record.sourceSend
    ? { ...record.sourceSend }
    : { state: 'not-attempted', messageId: null };
  entry.destinationSend = record.destinationSend
    ? { ...record.destinationSend }
    : { state: 'not-attempted', conversationId: null, messageId: null };
  entry.error = record.error;
  if (entry.askedAt === null && handoffAsked(entry)) {
    entry.askedAt = typeof record.askedAt === 'number' && Number.isFinite(record.askedAt) ? record.askedAt : Date.now();
  }
}

export async function transitionNow(
  entry: Continuation,
  derive: (current: ContinuationRecord) => ContinuationRecord
): Promise<ContinuationRecord> {
  const current = durableRecord(entry);
  const next = derive(current);
  if (JSON.stringify(next) !== JSON.stringify(current)) next.touchedAt = Date.now();
  try {
    await writeDurableNow(CONTINUATIONS_STATE, snapshotWith(entry.token, next));
  } catch (err) {
    writeDurableSoon(CONTINUATIONS_STATE, snapshotContinuations());
    throw err;
  }
  publishRecord(entry, next);
  return next;
}
