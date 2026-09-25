import type { continuationSendCheckpointRuntime } from './continuation.js';

type Runtime = typeof continuationSendCheckpointRuntime;
type Entry = NonNullable<ReturnType<Runtime['byToken']['get']>>;

export function createContinuationSendCheckpoints(runtime: Runtime) {
  const { byToken, withCheckpointLock } = runtime;

  async function beginContinuationSourceSendNow(token: string): Promise<{ allowed: boolean; checkpoint: Entry['sourceSend'] } | null> {
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !runtime.isOpen(entry) || entry.state !== 'awaiting-summary') return null;
      if (entry.sourceSend.state === 'attempted-unresolved') return { allowed: true, checkpoint: { ...entry.sourceSend } };
      if (entry.sourceSend.state !== 'not-attempted') return { allowed: false, checkpoint: { ...entry.sourceSend } };
      await runtime.transitionNow(entry, current => ({ ...current, sourceSend: { state: 'attempted-unresolved', messageId: null } }));
      return { allowed: true, checkpoint: { ...entry.sourceSend } };
    });
  }

  async function dispatchContinuationSourceSendNow(token: string): Promise<boolean> {
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !runtime.isOpen(entry) || entry.state !== 'awaiting-summary' || entry.sourceSend.state !== 'attempted-unresolved') return false;
      await runtime.transitionNow(entry, current => ({ ...current, sourceSend: { state: 'dispatched-unresolved', messageId: null } }));
      return true;
    });
  }

  async function abortContinuationSourceBeforeSendNow(token: string, reason: string): Promise<boolean> {
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !runtime.isOpen(entry) || entry.state !== 'awaiting-summary' || !runtime.sendUnattempted(entry.sourceSend)) return false;
      if (entry.automatic) await runtime.refuseAutomaticCompactionNow(entry.sessionId, entry.from, entry.sourceTurnId);
      await runtime.transitionNow(entry, current => ({ ...current, state: 'aborted', error: reason }));
      runtime.cancelPrimeTransfer(entry.from);
      runtime.logWarn(`continuation ${entry.token.slice(0, 8)} durably abandoned before source Send — ${reason}`);
      runtime.noteAbandoned(entry, reason);
      return true;
    });
  }

  async function bindContinuationSourceMessageNow(token: string, messageId: string, progress?: number): Promise<boolean> {
    if (!messageId || messageId.length > 200) return false;
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !runtime.isOpen(entry) || entry.state !== 'awaiting-summary') return false;
      if (entry.sourceSend.state === 'sent') {
        if (entry.sourceSend.messageId !== messageId) return false;
        if (!entry.automatic && Number.isSafeInteger(progress) && progress! > entry.sourceProgress &&
            progress! <= 4_000_000 && Date.now() - entry.touchedAt >= 30_000) {
          await runtime.transitionNow(entry, current => ({ ...current, sourceProgress: progress! }));
        }
        return true;
      }
      if (entry.sourceSend.state !== 'dispatched-unresolved') return false;
      await runtime.transitionNow(entry, current => ({
        ...current,
        sourceProgress: Number.isSafeInteger(progress) && progress! >= 0 && progress! <= 4_000_000 ? progress! : 0,
        sourceSend: { state: 'sent', messageId }
      }));
      return true;
    });
  }

  async function beginContinuationDestinationSendNow(token: string): Promise<{ allowed: boolean; checkpoint: Entry['destinationSend'] } | null> {
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !runtime.isOpen(entry) || !entry.handoffId || entry.state === 'awaiting-summary') return null;
      if (entry.destinationSend.state === 'attempted-unresolved') return { allowed: true, checkpoint: { ...entry.destinationSend } };
      if (entry.destinationSend.state !== 'not-attempted') return { allowed: false, checkpoint: { ...entry.destinationSend } };
      await runtime.transitionNow(entry, current => ({
        ...current,
        destinationSend: { state: 'attempted-unresolved', conversationId: null, messageId: null }
      }));
      return { allowed: true, checkpoint: { ...entry.destinationSend } };
    });
  }

  async function dispatchContinuationDestinationSendNow(token: string): Promise<boolean> {
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !runtime.isOpen(entry) || !entry.handoffId || entry.state === 'awaiting-summary' || entry.destinationSend.state !== 'attempted-unresolved') return false;
      await runtime.transitionNow(entry, current => ({
        ...current,
        destinationSend: { state: 'dispatched-unresolved', conversationId: null, messageId: null }
      }));
      runtime.recordReplacementDispatch(entry.token);
      return true;
    });
  }

  function continuationClaimedBy(token: string, claimant: string): boolean {
    return byToken.get(token)?.claimedBy === claimant;
  }

  async function releaseContinuationDestinationSendNow(token: string, unattemptedClaimant?: string): Promise<boolean> {
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !runtime.isOpen(entry) || !entry.handoffId || entry.state === 'awaiting-summary') return false;
      if (unattemptedClaimant !== undefined &&
          (entry.claimedBy !== unattemptedClaimant || entry.destinationSend.state !== 'not-attempted')) return false;
      if (entry.destinationSend.state === 'sent') return false;
      if (entry.destinationSend.state === 'not-attempted' && entry.claimedBy === null) return true;
      await runtime.transitionNow(entry, current => ({
        ...current,
        state: current.state === 'claimed' ? 'awaiting-chat' : current.state,
        claimedBy: null,
        destinationSend: { state: 'not-attempted', conversationId: null, messageId: null }
      }));
      runtime.releaseReplacementChatClaim(entry.token);
      return true;
    });
  }

  async function bindContinuationDestinationMessageNow(token: string, conversationId: string, messageId: string): Promise<boolean> {
    if (!conversationId || !messageId || conversationId.length > 256 || messageId.length > 200) return false;
    return withCheckpointLock(token, async () => {
      const entry = byToken.get(token);
      if (!entry || !entry.handoffId || conversationId === entry.from) return false;
      if (entry.destinationSend.state === 'sent') {
        return entry.destinationSend.conversationId === conversationId && entry.destinationSend.messageId === messageId;
      }
      const committedHere = entry.state === 'committed' && entry.to === conversationId;
      if (!runtime.isOpen(entry) && !committedHere) return false;
      if (entry.destinationSend.state !== 'dispatched-unresolved') return false;
      await runtime.transitionNow(entry, current => ({
        ...current,
        destinationSend: { state: 'sent', conversationId, messageId }
      }));
      return true;
    });
  }

  return {
    abortContinuationSourceBeforeSendNow,
    beginContinuationDestinationSendNow,
    beginContinuationSourceSendNow,
    bindContinuationDestinationMessageNow,
    bindContinuationSourceMessageNow,
    continuationClaimedBy,
    dispatchContinuationDestinationSendNow,
    dispatchContinuationSourceSendNow,
    releaseContinuationDestinationSendNow
  };
}
