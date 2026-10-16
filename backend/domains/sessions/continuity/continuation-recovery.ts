import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { beginPrimeTransfer, cancelPrimeTransfer, thawPrimeTransfer } from '../../automation/agents.js';
import { handoffMatchesContinuation } from './handoff.js';
import { recordReplacementChatClaim, recordReplacementDispatch } from './replacement-chat-gate.js';
import { ensureHandoffRecorded } from '../history/recorder.js';
import { ensureCommittedResumeHandoff, getSession, readHandoff } from '../history/store.js';
import { normalizeRequestedModel, type Continuation, type ContinuationSendState, type ContinuationSnapshot, type ContinuationState, type RequestedModel } from './continuation-records.js';

interface Runtime {
  byToken: Map<string, Continuation>;
  changedNow: () => Promise<void>;
  expired: (entry: Continuation, now?: number) => boolean;
  handoffAsked: (entry: Continuation) => boolean;
  manualWaitingTtlMs: (state: ContinuationState, requested: RequestedModel | null) => number;
  publishRecoveryProjection: (entry: Continuation, conversationId: string) => void;
}

const SEND_STATES = new Set<ContinuationSendState>([
  'not-attempted',
  'attempted-unresolved',
  'dispatched-unresolved',
  'sent'
]);

export function createContinuationRecovery(runtime: Runtime) {
  async function restoreContinuations(snapshot: ContinuationSnapshot | null): Promise<void> {
    const { byToken } = runtime;
    byToken.clear();
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) return;
    const now = Date.now();
    const validStates = new Set<ContinuationState>([
      'awaiting-summary',
      'awaiting-chat',
      'claimed',
      'committing',
      'committed',
      'aborted'
    ]);
    for (const raw of snapshot.entries.slice(0, 32)) {
      if (!raw) continue;
      const retentionMs = runtime.manualWaitingTtlMs(raw.state, normalizeRequestedModel(raw.requestedModel)) * 2;
      const lastTouchedAt = Number.isFinite(raw.touchedAt) && raw.touchedAt! <= now ? raw.touchedAt! : raw.openedAt;
      if (
        !/^[A-Za-z0-9_-]{16,64}$/.test(raw.token) ||
        !/^[0-9a-z-]{8,64}$/i.test(raw.sessionId) ||
        typeof raw.from !== 'string' ||
        raw.from.length === 0 || raw.from.length > 256 ||
        !validStates.has(raw.state) ||
        !Number.isFinite(raw.openedAt) ||
        ((raw.state === 'committed' || raw.state === 'aborted') && now - lastTouchedAt >= retentionMs) ||
        (raw.automatic !== true && now - lastTouchedAt >= retentionMs)
      ) {
        continue;
      }
      const entry: Continuation = {
        requestedModel: normalizeRequestedModel(raw.requestedModel),
        sourceTurnId: typeof raw.sourceTurnId === 'string' ? raw.sourceTurnId : null,
        token: raw.token,
        sessionId: raw.sessionId,
        from: raw.from,
        to: typeof raw.to === 'string' && raw.to ? raw.to : null,
        openedAt: raw.openedAt,
        sourceProgress: Number.isSafeInteger(raw.sourceProgress) && raw.sourceProgress! >= 0 && raw.sourceProgress! <= 4_000_000 ? raw.sourceProgress! : 0,
        touchedAt: Number.isFinite(raw.touchedAt) && raw.touchedAt! >= raw.openedAt && raw.touchedAt! <= now ? Number(raw.touchedAt) : raw.openedAt,
        automatic: raw.automatic === true,
        askedAt: null,
        state: raw.state,
        summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 512 * 1024) : '',
        handoffId: typeof raw.handoffId === 'string' ? raw.handoffId : null,
        capture: null,
        handoff: null,
        claimedBy: typeof raw.claimedBy === 'string' ? raw.claimedBy : null,
        sourceSend:
          raw.sourceSend && SEND_STATES.has(raw.sourceSend.state as ContinuationSendState)
            ? {
                state: raw.sourceSend.state as ContinuationSendState,
                messageId: typeof raw.sourceSend.messageId === 'string' ? raw.sourceSend.messageId.slice(0, 200) : null
              }
            : {
                state: raw.armed === true ? 'dispatched-unresolved' : 'not-attempted',
                messageId: null
              },
        destinationSend:
          raw.destinationSend && SEND_STATES.has(raw.destinationSend.state as ContinuationSendState)
            ? {
                state: raw.destinationSend.state as ContinuationSendState,
                conversationId:
                  typeof raw.destinationSend.conversationId === 'string'
                    ? raw.destinationSend.conversationId.slice(0, 256)
                    : null,
                messageId:
                  typeof raw.destinationSend.messageId === 'string'
                    ? raw.destinationSend.messageId.slice(0, 200)
                    : null
              }
            : { state: 'not-attempted', conversationId: null, messageId: null },
        error: typeof raw.error === 'string' ? raw.error : null
      };
      if (runtime.handoffAsked(entry)) {
        entry.askedAt = typeof raw.askedAt === 'number' && Number.isFinite(raw.askedAt) ? raw.askedAt : now;
      }
      const waitingExpired = entry.state !== 'committed' && entry.state !== 'aborted' && runtime.expired(entry, now);
      let handoffProvenanceConflict = false;
      if (entry.handoffId) {
        try {
          entry.handoff = await readHandoff(entry.sessionId, entry.handoffId);
          if (entry.handoff && !handoffMatchesContinuation(entry.handoff, entry.token, entry.from, entry.sourceTurnId)) {
            handoffProvenanceConflict = true;
            logWarn(`continuation ${entry.token.slice(0, 8)} refused handoff ${entry.handoff.id}: stored provenance belongs to another transaction`);
            entry.handoff = null;
          }
        } catch (err) {
          logWarn(`continuation ${entry.token.slice(0, 8)} handoff recovery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (entry.handoff && entry.state !== 'awaiting-summary') {
        try {
          await ensureHandoffRecorded(entry.sessionId, entry.handoff.id, entry.handoff.text.length, 'compact and resume');
        } catch (err) {
          logWarn(`continuation ${entry.token.slice(0, 8)} could not repair handoff event ${entry.handoff.id} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (entry.state === 'committing' || entry.state === 'committed') {
        let session = null;
        try {
          session = await getSession(entry.sessionId);
        } catch (err) {
          logWarn(`continuation ${entry.token.slice(0, 8)} session recovery failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (session && entry.to && session.conversationId === entry.to) {
          if (entry.handoffId && !handoffProvenanceConflict) {
            try {
              await ensureCommittedResumeHandoff(entry.sessionId, entry.to, entry.handoffId);
            } catch (err) {
              logWarn(`continuation ${entry.token.slice(0, 8)} could not repair committed resume provenance — ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          runtime.publishRecoveryProjection(entry, entry.to);
          entry.state = 'committed';
          entry.error = null;
          logInfo(`continuation ${entry.token.slice(0, 8)} recovered after durable commit`);
        } else if (entry.state === 'committing' && session && session.conversationId === entry.from) {
          if (!entry.handoff) {
            entry.state = 'aborted';
            entry.to = null;
            entry.error = handoffProvenanceConflict
              ? 'The saved handoff belongs to a different continuation.'
              : 'The saved handoff could not be recovered.';
            cancelPrimeTransfer(entry.from);
          } else if (waitingExpired) {
            entry.state = 'aborted';
            entry.to = null;
            entry.error = 'Recovery found the continuation had already expired before the durable session move.';
            cancelPrimeTransfer(entry.from);
          } else {
            thawPrimeTransfer(entry.from);
            entry.state = entry.claimedBy ? 'claimed' : 'awaiting-chat';
            entry.to = null;
            entry.error = 'Recovered before the durable session move; the continuation can be retried.';
            beginPrimeTransfer(entry.from);
          }
        } else if (entry.state === 'committed') {
          logInfo(`continuation ${entry.token.slice(0, 8)} stays committed although its session moved on again`);
        } else {
          entry.state = 'aborted';
          entry.error = 'Recovery found an unexpected session attachment and refused to guess a chat.';
          cancelPrimeTransfer(entry.from);
        }
      } else if (entry.state !== 'aborted') {
        if (waitingExpired) {
          entry.state = 'aborted';
          entry.error = 'Recovery found the continuation had already expired.';
          cancelPrimeTransfer(entry.from);
        } else if (entry.state !== 'awaiting-summary' && !entry.handoff) {
          entry.state = 'aborted';
          entry.error = handoffProvenanceConflict
            ? 'The saved handoff belongs to a different continuation.'
            : 'The saved handoff could not be recovered.';
          cancelPrimeTransfer(entry.from);
        } else {
          beginPrimeTransfer(entry.from);
        }
      }
      if (entry.state === 'claimed') {
        if (entry.destinationSend.state === 'dispatched-unresolved' || entry.destinationSend.state === 'sent') {
          recordReplacementDispatch(entry.token);
        } else {
          recordReplacementChatClaim(entry.token);
        }
      }
      byToken.set(entry.token, entry);
    }
    try {
      await runtime.changedNow();
    } catch (err) {
      logWarn(`continuation recovery could not persist its repaired snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { restoreContinuations };
}
