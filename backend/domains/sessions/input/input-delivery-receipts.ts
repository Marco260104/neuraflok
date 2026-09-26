import type { InputEntry } from './input-schema.js';
import type { inputDeliveryReceiptRuntime } from './input.js';

type Runtime = typeof inputDeliveryReceiptRuntime;

const localExecutorAcceptanceListeners = new Set<(entry: Readonly<InputEntry>) => void | Promise<void>>();

export const RECOVERY_WITHDRAW_LIMIT_MS = 3 * 60_000;

export function onLocalExecutorInputAccepted(listener: (entry: Readonly<InputEntry>) => void | Promise<void>): () => void {
  localExecutorAcceptanceListeners.add(listener);
  return () => localExecutorAcceptanceListeners.delete(listener);
}

export function createInputDeliveryReceipts(runtime: Runtime) {
  const recoveryReleaseTold = new Map<string, string>();

  async function bindOpening(entry: InputEntry, conversationId: string): Promise<boolean> {
    if (!entry.opening || !entry.sessionId) return false;
    if (entry.conversationId && entry.conversationId !== conversationId) return false;
    if (await runtime.conversationWasSuperseded(conversationId)) return false;
    await runtime.materializeOpening(entry);
    const session = await runtime.getSession(entry.sessionId);
    if (!session || (session.conversationId && session.conversationId !== conversationId)) return false;
    const strictAtAuthoritativeBind = !session.conversationId && runtime.getConfig().multiAgent.strictChatAllowlist === true;
    let boundSessionNow = false;
    if (!session.conversationId) {
      if (!await runtime.rebindSession(session.id, null, conversationId)) return false;
      boundSessionNow = true;
    }
    if (boundSessionNow && strictAtAuthoritativeBind && runtime.getConfig().multiAgent.strictChatAllowlist === true) {
      if (!runtime.deliveryHooks()?.trustOpening || !await runtime.deliveryHooks()?.trustOpening?.(session.id, conversationId)) return false;
    }
    return true;
  }

  function bindBrowserInputProject(id: string, owner: string, conversationId: string): Promise<boolean> {
    return runtime.serial(async () => {
      if (!owner || !/^[0-9a-z-]{8,256}$/i.test(conversationId)) return false;
      const current = await runtime.load();
      const entry = current.find(row => row.id === id && row.owner === owner);
      if (!entry || !['browser', 'sent'].includes(entry.state) || (!entry.opening && !entry.projectId) || entry.purpose === 'decision') return false;
      if (entry.requiresAuthorization && entry.sendAuthorizedAt === undefined) return false;
      if (entry.conversationId && entry.conversationId !== conversationId) return false;
      if (await runtime.conversationWasSuperseded(conversationId)) return false;
      const bound = { ...entry, conversationId };
      if (!entry.conversationId) await runtime.commit(current.map(row => row === entry ? bound : row));
      if (entry.opening) return bindOpening(bound, conversationId);
      const heldSessionId = entry.sessionId ?? entry.deliveredSessionId;
      const session = heldSessionId ? await runtime.getSession(heldSessionId) :
        await runtime.findSessionByConversation(conversationId, { requireUnique: true }) ??
        await runtime.createSession({ conversationId, title: runtime.userTitle(entry.text, entry.text), titleSource: 'fallback' });
      if (!session || session.conversationId !== conversationId) return false;
      await runtime.assignSessionProject(session.id, entry.projectId!);
      const latest = await runtime.load();
      await runtime.commit(latest.map(row => row.id === id ? { ...row, deliveredSessionId: session.id } : row));
      return true;
    });
  }

  function acceptLocalExecutorInput(id: string, conversationId: string, messageId: string): Promise<boolean> {
    return runtime.serial(async () => {
      if (!conversationId || !/^[0-9a-z-]{8,256}$/i.test(conversationId)) return false;
      if (!messageId || messageId.length > 256) return false;
      const current = await runtime.load();
      const entry = current.find(row => row.id === id);
      if (!entry) return false;
      if (entry.localExecutor && (entry.localExecutor === 'api'
        ? !runtime.isApiConversationId(conversationId) : runtime.providerForConversationId(conversationId) !== entry.localExecutor)) return false;
      if (entry.state === 'sent' && entry.conversationId === conversationId && entry.messageId === messageId) {
        await runtime.publishHistory();
        return true;
      }
      if (entry.state !== 'queued') return false;
      if (entry.conversationId && entry.conversationId !== conversationId) return false;
      if (await runtime.conversationWasSuperseded(conversationId)) return false;
      const bound: InputEntry = { ...entry, conversationId };
      if (entry.opening) {
        if (!await bindOpening(bound, conversationId)) return false;
      } else if (entry.sessionId) {
        const session = await runtime.getSession(entry.sessionId);
        if (!session) return false;
        if (session.conversationId && session.conversationId !== conversationId) return false;
        if (!session.conversationId && !await runtime.rebindSession(session.id, null, conversationId)) return false;
      }
      const delivered = bound.sessionId ? await runtime.getSession(bound.sessionId)
        : await runtime.findSessionByConversation(conversationId, { requireUnique: true });
      const acknowledged: InputEntry = {
        ...bound,
        conversationId,
        deliveredSessionId: delivered?.id ?? null,
        state: 'sent',
        owner: null,
        messageId,
        deliveredAt: Date.now()
      };
      await runtime.transition(current, current.map(row => row.id === id ? acknowledged : row), [], 'after-send');
      runtime.logInfo(`input ${id}: local executor accepted after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
      await runtime.publishHistory();
      for (const listener of localExecutorAcceptanceListeners) await listener({ ...acknowledged });
      return true;
    });
  }

  function failLocalExecutorInput(id: string, error: string): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const entry = current.find(row => row.id === id && row.state === 'queued');
      if (!entry) return false;
      await runtime.commit(current.map(row => row.id === id
        ? { ...row, state: 'failed' as const, owner: null, error: error.slice(0, 200) } : row));
      return true;
    });
  }

  function acknowledgeBrowserInput(id: string, owner: string, conversationId?: string | null, messageId?: string): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const entry = current.find(row => row.id === id && row.owner === owner);
      if (entry && runtime.companionOf(current, entry)) return false;
      if (!owner || !entry || !['browser', 'sent', 'decision', 'cancelled'].includes(entry.state) ||
        (entry.state === 'cancelled' && entry.purpose === 'decision')) return false;
      if (conversationId !== undefined && !(entry.lifetime === 'temporary-planner' && conversationId === null) && (!conversationId || !/^[0-9a-z-]{8,256}$/i.test(conversationId))) return false;
      if (conversationId && entry.conversationId && entry.conversationId !== conversationId) return false;
      if ((entry.opening || !entry.sessionId) && entry.purpose !== 'decision' && !conversationId && !entry.conversationId) return false;
      if (messageId !== undefined && (!messageId || messageId.length > 256)) return false;
      if ((entry.state !== 'browser' && entry.state !== 'cancelled') || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) {
        await runtime.publishHistory();
        return true;
      }
      const deliveredConversation = conversationId ?? entry.conversationId;
      if (entry.opening && deliveredConversation) {
        if (entry.state === 'cancelled' && entry.requiresAuthorization && entry.sendAuthorizedAt === undefined) return false;
        if (!await bindOpening(entry, deliveredConversation)) return false;
      }
      if (!entry.sessionId && entry.purpose !== 'decision' && deliveredConversation) {
        await runtime.noteChatOrigin(deliveredConversation, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
      }
      const delivered = entry.sessionId ? await runtime.getSession(entry.sessionId) : deliveredConversation
        ? await runtime.findSessionByConversation(deliveredConversation, { requireUnique: true }) : null;
      if (entry.purpose === 'decision' && entry.lifetime !== 'temporary-planner' && deliveredConversation) {
        await runtime.deliveryHooks()?.bindHelper?.(deliveredConversation, entry.decisionSourceSessionId ?? null);
      }
      const acknowledged: InputEntry = {
        ...entry,
        conversationId: deliveredConversation,
        deliveredSessionId: delivered?.id ?? null,
        state: entry.state === 'cancelled' ? 'cancelled' : entry.purpose === 'decision' ? 'decision' : 'sent',
        ...(entry.state === 'cancelled' ? { error: 'Cancelled locally; delivery was later confirmed by the provider.' } : {}),
        ...(messageId ? { messageId } : {}),
        deliveredAt: Date.now()
      };
      await runtime.transition(current, current.map(row => row === entry ? acknowledged : row.id === entry.companionInputId ? {
        ...row,
        state: acknowledged.state,
        error: acknowledged.error,
        deliveredSessionId: acknowledged.deliveredSessionId,
        messageId: acknowledged.messageId,
        deliveredAt: acknowledged.deliveredAt
      } : row), entry.state !== 'cancelled' && (entry.opening || !entry.sessionId) && entry.automation && deliveredConversation && entry.purpose !== 'decision' ? [acknowledged] : [], 'after-send');
      if (entry.completedTurnId && entry.sessionId && deliveredConversation) {
        await runtime.consumeGoalReplyForInputNow(deliveredConversation, entry.sessionId, entry.completedTurnId);
      }
      runtime.logInfo(`input ${id}: browser acknowledged after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
      await runtime.publishHistory();
      return true;
    });
  }

  async function pausedBrowserHelpers(): Promise<Array<{ id: string; sourceSessionId: string }>> {
    return (await runtime.listInputs()).filter(row => row.purpose === 'decision' && row.state === 'cancelled' && row.cancelledByUser === true && !row.conversationId && row.decisionSourceSessionId)
      .map(row => ({ id: row.id, sourceSessionId: row.decisionSourceSessionId! }));
  }

  function authorizeBrowserHelperRetry(id: string, sourceSessionId: string): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === id && entry.decisionSourceSessionId === sourceSessionId
        && entry.purpose === 'decision' && entry.state === 'cancelled' && !entry.conversationId);
      if (!row || current.some(entry => entry.decisionSourceSessionId === sourceSessionId && !runtime.terminal(entry))) return false;
      await runtime.commit(current.map(entry => entry === row ? { ...entry, state: 'failed', error: 'User authorized a new helper' } : entry));
      return true;
    });
  }

  function endRecoveryInput(id: string, conversationId: string): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === id && entry.recovery && entry.state === 'queued' &&
        entry.offeredAt === undefined && entry.sendAuthorizedAt === undefined);
      if (!row?.sessionId || !row.recovery || (await runtime.getSession(row.sessionId))?.conversationId !== conversationId) return false;
      const error = 'Automatic Continue was not needed: the page shows a finished answer.';
      runtime.logWarn(`input ${row.id}: ${error}`);
      await runtime.commit(current.map(entry => entry === row
        ? { ...entry, state: 'cancelled', owner: null, error, recovery: { ...row.recovery!, ended: 'page-final' } } : entry));
      return true;
    });
  }

  function failBrowserInput(id: string, owner: string, error: string, detail?: string): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const entry = current.find(row => row.id === id && row.owner === owner && row.state === 'browser');
      if (!entry || runtime.companionOf(current, entry)) return false;
      if (entry.sendAuthorizedAt !== undefined && error === runtime.RECEIPT_UNCONFIRMED) {
        runtime.logWarn(`input ${entry.id}: native Send was clicked, but its receipt was not confirmed`);
        await runtime.commit(current.map(row => runtime.sameDelivery(entry, row) ? { ...row, state: 'cancelled', error: runtime.UNCONFIRMED_SEND } : row));
        runtime.browserDecisionService.rejectWaiter(id, new Error('goal_browser_send_failed: ' + runtime.UNCONFIRMED_SEND));
        return true;
      }
      if (entry.recovery && entry.requiresAuthorization === true && entry.sendAuthorizedAt === undefined) {
        const told = detail ? `${error} (${detail})` : error;
        if (recoveryReleaseTold.get(entry.id) !== told) {
          recoveryReleaseTold.set(entry.id, told);
          if (recoveryReleaseTold.size > 200) for (const old of [...recoveryReleaseTold.keys()].slice(0, 50)) recoveryReleaseTold.delete(old);
          runtime.logWarn(`input ${entry.id}: the browser could not send this recovery message — ${told.slice(0, 200)}`);
        }
        const now = Date.now();
        const since = entry.recovery.withdrawnSince ?? now;
        if (now - since >= RECOVERY_WITHDRAW_LIMIT_MS) {
          runtime.logWarn(`input ${entry.id}: automatic Continue ended — pages withdrew it before Send for ${Math.round((now - since) / 60_000)} minutes (last: ${told.slice(0, 160)})`);
          await runtime.commit(current.map(row => row === entry
            ? { ...row, state: 'failed', owner: null, error: `Automatic Continue was not sent: ${detail ?? 'withdrawn before Send'}`.slice(0, 200) } : row));
          return true;
        }
        await runtime.commit(current.map(row => row === entry
          ? { ...runtime.releaseRecoveryClaim(row, error), recovery: { ...runtime.releaseRecoveryClaim(row, error).recovery!, withdrawnSince: since } } : row));
        return true;
      }
      if (entry.recovery && entry.requiresAuthorization === true && error === 'After-turn pickup was withdrawn before Send.') {
        await runtime.commit(current.map(row => row === entry
          ? { ...row, state: 'failed', completedTurnId: undefined, error } : row));
        return true;
      }
      if (entry.recovery && entry.sendAuthorizedAt !== undefined) return false;
      const pickupCancelled = !!(entry.silenceBoundary || entry.completedTurnId) && entry.requiresAuthorization === true &&
        entry.sendAuthorizedAt === undefined && error === 'After-turn pickup was withdrawn before Send.';
      const preserveBoundary = pickupCancelled && await runtime.eligibleStageEnd(entry) === entry.completedTurnId;
      await runtime.commit(current.map(row => runtime.sameDelivery(entry, row) ? pickupCancelled
        ? runtime.withoutSilenceClaim(row, row === entry && preserveBoundary)
        : { ...row, state: entry.companionInputId ? 'cancelled' : 'failed', error: error.slice(0, 200) } : row));
      runtime.browserDecisionService.rejectWaiter(id, new Error('goal_browser_send_failed: ' + error.slice(0, 200)));
      return true;
    });
  }

  return {
    acceptLocalExecutorInput,
    acknowledgeBrowserInput,
    authorizeBrowserHelperRetry,
    bindBrowserInputProject,
    endRecoveryInput,
    failBrowserInput,
    failLocalExecutorInput,
    pausedBrowserHelpers
  };
}
