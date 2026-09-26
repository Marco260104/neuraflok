import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import {
  cancelPrimeTransfer,
  commitPrimeTransfer,
  freezePrimeTransfer,
  thawPrimeTransfer
} from '../../automation/agents.js';
import { moveChatWorkspace } from '../../workspace/workspace.js';
import { moveGoalObjective, moveGoalSwitch, retireGoalDraftsFor } from '../../automation/goal.js';
import { rebindConversation } from '../history/recorder.js';
import {
  ensureCommittedResumeHandoff,
  findSessionByConversation,
  getSession,
  rebindSession
} from '../history/store.js';
import type {
  Continuation,
  ContinuationCommitResult,
  ContinuationRecord,
  ContinuationRecoveryHooks
} from './continuation.js';

interface Runtime {
  continuationForToken: (token: string) => Continuation | null;
  isOpen: (entry: Continuation) => boolean;
  sweep: () => void;
  withCheckpointLock: <T>(token: string, work: () => Promise<T>) => Promise<T>;
  transitionNow: (entry: Continuation, derive: (current: ContinuationRecord) => ContinuationRecord) => Promise<ContinuationRecord>;
  recoveryHooks: () => ContinuationRecoveryHooks;
}

export const RESUME_SHADOW_COLLISION = 'the replacement chat already belongs to another local session';

export function createContinuationCommitter(runtime: Runtime) {
  const commitLocks = new Map<string, { to: string; promise: Promise<ContinuationCommitResult> }>();

  function publishCommittedProjection(
    entry: Continuation,
    toConversationId: string,
    swarm: 'absent' | 'frozen' | 'recovery'
  ): void {
    rebindConversation(entry.sessionId, entry.from, toConversationId);
    moveChatWorkspace(entry.from, toConversationId);
    moveGoalObjective(entry.from, toConversationId);
    moveGoalSwitch(entry.from, toConversationId);
    retireGoalDraftsFor(entry.from);
    if (swarm === 'frozen' || swarm === 'absent') {
      if (!commitPrimeTransfer(entry.from, toConversationId) && swarm === 'frozen') {
        logWarn(`continuation ${entry.token.slice(0, 8)} committed after its run ended; no prime to move`);
      }
    } else if (swarm === 'recovery') {
      const hooks = runtime.recoveryHooks();
      const repaired = hooks.repairPrimeTransfer?.(entry.from, toConversationId) ?? false;
      if (!repaired && !commitPrimeTransfer(entry.from, toConversationId)) {
        if (!hooks.repairPrimeTransfer) {
          logWarn(`continuation ${entry.token.slice(0, 8)} recovered without a broker prime repair hook`);
        } else if (hooks.hasPrimeFleet?.(entry.from)) {
          logWarn(`continuation ${entry.token.slice(0, 8)} recovered, but its sub-agent fleet is still led from ${entry.from}`);
        }
      }
    }
  }

  async function rollbackCommitting(entry: Continuation, error: string): Promise<boolean> {
    try {
      await runtime.transitionNow(entry, current => ({
        ...current,
        state: entry.claimedBy ? 'claimed' : 'awaiting-chat',
        to: null,
        error
      }));
      return true;
    } catch (err) {
      logWarn(`continuation ${entry.token.slice(0, 8)} could not persist its retry state — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async function finishCommittedRecord(entry: Continuation, toConversationId: string): Promise<void> {
    try {
      await runtime.transitionNow(entry, current => ({ ...current, state: 'committed', to: toConversationId, error: null }));
    } catch (err) {
      logWarn(`continuation ${entry.token.slice(0, 8)} moved its session but could not persist the completion record — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function reconcileCommitting(entry: Continuation, toConversationId: string): Promise<ContinuationCommitResult> {
    let session;
    try {
      session = await getSession(entry.sessionId);
    } catch (err) {
      return { status: 'retryable', reason: `the local session could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!session) return { status: 'rejected', reason: 'the local session no longer exists' };

    if (session.conversationId === toConversationId) {
      if (entry.handoffId) {
        try {
          if (!(await ensureCommittedResumeHandoff(entry.sessionId, toConversationId, entry.handoffId))) {
            return { status: 'retryable', reason: 'the committed resume handoff provenance could not be repaired' };
          }
        } catch (err) {
          return { status: 'retryable', reason: `the committed resume handoff provenance could not be repaired: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      publishCommittedProjection(entry, toConversationId, 'recovery');
      await finishCommittedRecord(entry, toConversationId);
      return { status: 'already-committed', conversationId: toConversationId };
    }
    if (session.conversationId !== entry.from) {
      const reason = 'the local session is attached to an unexpected chat, so recovery refused to guess';
      try {
        await runtime.transitionNow(entry, current => ({ ...current, state: 'aborted', error: reason }));
      } catch {
        return { status: 'retryable', reason };
      }
      cancelPrimeTransfer(entry.from);
      return { status: 'rejected', reason };
    }

    if (/^[0-9a-f-]{8,64}$/i.test(toConversationId)) {
      let target;
      try {
        target = await findSessionByConversation(toConversationId, { requireUnique: true });
      } catch (err) {
        return { status: 'retryable', reason: `the destination chat ownership could not be checked: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (target && target.id !== entry.sessionId) {
        const rolledBack = await rollbackCommitting(entry, RESUME_SHADOW_COLLISION);
        return rolledBack
          ? { status: 'rejected', reason: RESUME_SHADOW_COLLISION }
          : { status: 'retryable', reason: RESUME_SHADOW_COLLISION };
      }
    }

    const swarm = freezePrimeTransfer(entry.from);
    if (swarm === 'unavailable') {
      const reason = 'no swarm handover is open for this chat, so the session stayed in the current chat';
      const rolledBack = await rollbackCommitting(entry, reason);
      if (rolledBack) {
        logWarn(`continuation ${entry.token.slice(0, 8)} refused: no usable prime handover from ${entry.from}`);
        return { status: 'rejected', reason };
      }
      return { status: 'retryable', reason };
    }

    let moved = false;
    try {
      moved = await rebindSession(entry.sessionId, entry.from, toConversationId, entry.handoffId ?? undefined);
    } catch (err) {
      logWarn(`continuation ${entry.token.slice(0, 8)} rebind threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!moved) {
      let after = null;
      try {
        after = await getSession(entry.sessionId);
      } catch {
        // The result stays retryable after the frozen handover is released.
      }
      if (after?.conversationId === toConversationId) {
        if (entry.handoffId) {
          try {
            if (!(await ensureCommittedResumeHandoff(entry.sessionId, toConversationId, entry.handoffId))) {
              return { status: 'retryable', reason: 'the committed resume handoff provenance could not be repaired' };
            }
          } catch (err) {
            return { status: 'retryable', reason: `the committed resume handoff provenance could not be repaired: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        publishCommittedProjection(entry, toConversationId, swarm === 'frozen' ? 'frozen' : 'absent');
        await finishCommittedRecord(entry, toConversationId);
        return { status: 'committed', conversationId: toConversationId };
      }
      if (swarm === 'frozen') thawPrimeTransfer(entry.from);
      if (after && after.conversationId !== entry.from) {
        const reason = 'the local session changed ownership while the continuation was committing';
        try {
          await runtime.transitionNow(entry, current => ({ ...current, state: 'aborted', error: reason }));
        } catch {
          return { status: 'retryable', reason };
        }
        cancelPrimeTransfer(entry.from);
        return { status: 'rejected', reason };
      }
      const reason = 'the local session could not be moved to the new chat';
      await rollbackCommitting(entry, reason);
      logWarn(`continuation ${entry.token.slice(0, 8)} could not rebind session ${entry.sessionId}`);
      return { status: 'retryable', reason };
    }

    publishCommittedProjection(entry, toConversationId, swarm === 'frozen' ? 'frozen' : 'absent');
    await finishCommittedRecord(entry, toConversationId);
    logInfo(`continuation ${entry.token.slice(0, 8)} committed: session ${entry.sessionId} is now chat ${toConversationId}`);
    return { status: 'committed', conversationId: toConversationId };
  }

  async function commitUnlocked(entry: Continuation, toConversationId: string): Promise<ContinuationCommitResult> {
    if (!toConversationId || toConversationId === entry.from) {
      return { status: 'rejected', reason: 'the replacement chat is not a distinct conversation' };
    }
    if (entry.state === 'committed') {
      if (entry.to && entry.to !== toConversationId) {
        return { status: 'rejected', reason: 'the continuation already committed to a different chat' };
      }
      const committedTo = entry.to ?? toConversationId;
      if (entry.handoffId) {
        try {
          if (!(await ensureCommittedResumeHandoff(entry.sessionId, committedTo, entry.handoffId))) {
            return { status: 'retryable', reason: 'the committed resume handoff provenance could not be repaired' };
          }
        } catch (err) {
          return { status: 'retryable', reason: `the committed resume handoff provenance could not be repaired: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      return { status: 'already-committed', conversationId: committedTo };
    }
    if (entry.state === 'committing') {
      if (entry.to !== toConversationId) {
        return { status: 'rejected', reason: 'another replacement chat already owns the commit' };
      }
      return reconcileCommitting(entry, toConversationId);
    }
    if (!runtime.isOpen(entry) || (entry.state !== 'awaiting-chat' && entry.state !== 'claimed')) {
      return { status: 'rejected', reason: 'the continuation is not ready to commit' };
    }

    try {
      await runtime.transitionNow(entry, current => ({ ...current, state: 'committing', to: toConversationId, error: null }));
    } catch (err) {
      return { status: 'retryable', reason: `the continuation intent could not be persisted: ${err instanceof Error ? err.message : String(err)}` };
    }
    return reconcileCommitting(entry, toConversationId);
  }

  async function commitContinuationResult(token: string, toConversationId: string): Promise<ContinuationCommitResult> {
    runtime.sweep();
    const entry = runtime.continuationForToken(token);
    if (!entry) return { status: 'rejected', reason: 'the continuation no longer exists' };
    const locked = commitLocks.get(token);
    if (locked) {
      if (locked.to !== toConversationId) {
        return { status: 'rejected', reason: 'another replacement chat already owns the commit' };
      }
      return locked.promise;
    }

    const work = runtime.withCheckpointLock(token, () => commitUnlocked(entry, toConversationId));
    commitLocks.set(token, { to: toConversationId, promise: work });
    try {
      return await work;
    } finally {
      if (commitLocks.get(token)?.promise === work) commitLocks.delete(token);
    }
  }

  async function commitContinuation(token: string, toConversationId: string): Promise<boolean> {
    const result = await commitContinuationResult(token, toConversationId);
    return result.status === 'committed' || result.status === 'already-committed';
  }

  return {
    commitContinuation,
    commitContinuationResult,
    publishRecoveryProjection: (entry: Continuation, toConversationId: string): void =>
      publishCommittedProjection(entry, toConversationId, 'recovery'),
    hasCommitLock: (token: string): boolean => commitLocks.has(token),
    reset: (): void => commitLocks.clear()
  };
}
