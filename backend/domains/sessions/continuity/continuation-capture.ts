import type { Handoff } from '../../../../contracts/session.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { ensureHandoffRecorded, recordHandoff } from '../history/recorder.js';
import type { Continuation, ContinuationRecord } from './continuation-records.js';
import { prepareHandoff } from './handoff.js';

interface Runtime {
  byToken: Map<string, Continuation>;
  sweep: () => void;
  isOpen: (entry: Continuation) => boolean;
  withCheckpointLock: <T>(token: string, work: () => Promise<T>) => Promise<T>;
  transitionNow: (
    entry: Continuation,
    derive: (current: ContinuationRecord) => ContinuationRecord
  ) => Promise<ContinuationRecord>;
}

export function createContinuationCapture(runtime: Runtime) {
  /** Awaits the one capture attempt shared by its starter and all duplicate callers, returning null consistently when durable storage rejects the transition. */
  async function settle(entry: Continuation, capture: Promise<Handoff | null>): Promise<Handoff | null> {
    try {
      return await capture;
    } catch (err) {
      // The handoff file may have been created, but its continuation transition was never published unless the WAL write succeeded. Clearing the single-flight lock makes the semantic step retryable without pretending the continuation advanced.
      if (entry.capture === capture) entry.capture = null;
      logWarn(`continuation ${entry.token.slice(0, 8)} could not store the brief — ${(err as Error).message}`);
      return null;
    }
  }

  /** Captures one brief per continuation with a lock held before the first await, so duplicate reports share the same handoff instead of overwriting it. */
  async function capture(
    token: string,
    text: string,
    produce: (entry: Continuation) => Promise<Handoff>
  ): Promise<Handoff | null> {
    runtime.sweep();
    const entry = runtime.byToken.get(token);
    if (!entry) return null;
    // Deliberately ahead of the liveness check: a handoff that was written stays answerable even once the transaction it belonged to has expired or been abandoned. The brief is on disk either way, and telling a retry "no such thing" would be a lie about durable state.
    if (entry.handoff) {
      if (entry.handoff.text.trim() !== text.trim()) {
        logWarn(`continuation ${entry.token.slice(0, 8)} re-captured a different brief; keeping handoff ${entry.handoffId}`);
      }
      try {
        await ensureHandoffRecorded(
          entry.sessionId,
          entry.handoff.id,
          entry.handoff.text.length,
          'compact and resume'
        );
      } catch (err) {
        // The WAL already committed this handoff. A retry is another chance to repair the session projection, but failure here still cannot make the committed capture false.
        logWarn(
          `continuation ${entry.token.slice(0, 8)} could not repair handoff event ${entry.handoff.id} on retry — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return entry.handoff;
    }
    if (entry.capture) return settle(entry, entry.capture);
    if (!runtime.isOpen(entry)) return null;
    if (entry.state !== 'awaiting-summary') return null;
    entry.capture = (async () => {
      const handoff = await produce(entry);
      const accepted = await runtime.withCheckpointLock(token, async () => {
        if (!runtime.isOpen(entry) || entry.state !== 'awaiting-summary') return false;
        await runtime.transitionNow(entry, (current) => ({
          ...current,
          summary: handoff.text,
          handoffId: handoff.id,
          state: 'awaiting-chat',
          error: null
        }));
        entry.handoff = handoff;
        return true;
      });
      if (!accepted) return null;
      // The handoff file was written before the continuation WAL record, but it is deliberately not in the session timeline yet. The WAL is the semantic commit for this capture: only after it lands may `lastHandoffId` advertise the brief to unrelated recovery callers.
      try {
        await recordHandoff(entry.sessionId, handoff.id, handoff.text.length, 'compact and resume');
      } catch (err) {
        // The continuation is already durable and can safely proceed. Recovery has the handoff id in that WAL and repairs this presentation/discovery event idempotently on restart.
        logWarn(
          `continuation ${entry.token.slice(0, 8)} committed handoff ${handoff.id} but could not publish its session event — ${err instanceof Error ? err.message : String(err)}`
        );
      }
      logInfo(`continuation ${entry.token.slice(0, 8)} captured handoff ${handoff.id}`);
      return handoff;
    })();
    return settle(entry, entry.capture);
  }

  /** Stores the assistant's final answer for the compaction turn as this session's handoff; the caller captures the answer for that exact generation. */
  async function attachSummary(token: string, text: string): Promise<Handoff | null> {
    const brief = text.trim();
    if (!brief) return null;
    return capture(token, brief, async (entry) =>
      prepareHandoff({
        sessionId: entry.sessionId,
        text: brief,
        continuationToken: entry.token,
        sourceConversationId: entry.from,
        sourceTurnId: entry.sourceTurnId
      })
    );
  }

  return { attachSummary };
}
