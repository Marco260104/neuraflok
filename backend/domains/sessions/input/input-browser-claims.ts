import type { InputEntry } from './input-schema.js';
import type { inputBrowserClaimRuntime } from './input.js';

type Runtime = typeof inputBrowserClaimRuntime;

export function createInputBrowserClaims(runtime: Runtime) {
  function pendingBrowserInputs(): Promise<Array<{
    id: string;
    conversationId: string | null;
    recovery?: { questionId: string; stop: boolean };
    silenceTurnId?: string;
    directTurn?: InputEntry['directTurn'];
    supersededConversationId?: string;
    lifetime?: 'temporary-planner';
  }>> {
    return runtime.serial(async () => {
      const result: Array<{
        id: string;
        conversationId: string | null;
        recovery?: { questionId: string; stop: boolean };
        silenceTurnId?: string;
        directTurn?: InputEntry['directTurn'];
        supersededConversationId?: string;
        lifetime?: 'temporary-planner';
      }> = [];
      const current = await runtime.load();
      for (const entry of runtime.ordered(current)) {
        if (runtime.companionOf(current, entry)) continue;
        if (!runtime.preparable(entry) || entry.dueAt > Date.now()) continue;
        if (runtime.queuedFollowup(entry) && !(entry.state === 'browser' && entry.completedTurnId) && !(await runtime.completedStageBoundary(entry, current))) continue;
        if (!(await runtime.browserInputAllowed(entry))) continue;
        try {
          const conversationId = await runtime.target(entry);
          const [end] = !entry.silenceBoundary && runtime.manualInput(entry) && entry.sessionId
            ? await runtime.readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
          const silenceTurnId = entry.silenceBoundary?.turnId ?? (end?.kind === 'turn_end' && end.outcome === 'failed' &&
            end.reason === 'thinking_failed' && end.turnId && await runtime.eligibleStageEnd(entry) === end.turnId ? end.turnId : undefined);
          result.push({ id: entry.id, conversationId,
            ...(entry.recovery ? { recovery: { questionId: entry.recovery.questionId, stop: entry.silenceBoundary?.nativeBusy === true && entry.recovery.phase === 'ready' } } : {}),
            ...(silenceTurnId ? { silenceTurnId } : {}),
            ...(entry.directTurn ? { directTurn: entry.directTurn } : {}),
            ...(entry.state === 'queued' && entry.purpose !== 'decision' && entry.sessionId && entry.conversationId && entry.conversationId !== conversationId
              ? { supersededConversationId: entry.conversationId } : {}),
            ...(entry.lifetime ? { lifetime: entry.lifetime } : {}) });
        } catch {
          // Keep blocked or deleted destinations in the outbox without offering them to the browser.
          continue;
        }
      }
      return result;
    });
  }

  function claimBrowserInput(id: string, owner: string, conversationId: string | null, requiresAuthorization = false): Promise<InputEntry | null> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const entry = current.find(row => row.id === id);
      if (!entry || !runtime.preparable(entry) || (entry.state === 'browser' && !requiresAuthorization) || entry.dueAt > Date.now() || !owner) return null;
      if (entry.recovery && entry.state === 'browser' && entry.owner !== owner) return null;
      if (entry.recovery?.reloadOwner === owner) return null;
      if (runtime.companionOf(current, entry)) return null;
      const completedTurnId = entry.state === 'browser' ? entry.completedTurnId : runtime.queuedFollowup(entry)
        ? await runtime.completedStageBoundary(entry, current) : runtime.manualInput(entry) ? await runtime.eligibleStageEnd(entry) : undefined;
      if (runtime.queuedFollowup(entry) && !completedTurnId) return null;
      if (await runtime.target(entry) !== conversationId) return null;
      if (!(await runtime.browserInputAllowed(entry))) return null;
      if (entry.purpose === 'decision' && !runtime.hasDecisionWaiter(id)) return null;
      if (entry.projectId) await runtime.projectWorkspace(entry.projectId);
      if (entry.sessionId) {
        if (current.some(row => !runtime.sameDelivery(entry, row) && row.sessionId === entry.sessionId && ['browser', 'tool'].includes(row.state))) return null;
        const first = runtime.ordered(current).find(row => row.sessionId === entry.sessionId && row.state === 'queued' && runtime.queuedFollowup(row) === runtime.queuedFollowup(entry) && row.dueAt <= Date.now());
        // Follow-ups use their live transport election; direct messages keep their own FIFO.
        if (entry.state === 'queued' && !runtime.queuedFollowup(entry) && first !== entry) return null;
      }
      const session = entry.sessionId ? await runtime.getSession(entry.sessionId) : null;
      // A post-recovery checkpoint can share this browser claim only after its listening window closes.
      const queueHead = session && runtime.manualInput(entry) && entry.silenceBoundary && (entry.silenceBoundary.listenUntil ?? 0) <= Date.now() && entry.state === 'queued' &&
        await runtime.turnHasMcpCall(session.id, entry.silenceBoundary.conversationId, entry.silenceBoundary.turnId)
        ? runtime.ordered(current).find(row => row.sessionId === entry.sessionId && runtime.queuedFollowup(row) && row.state === 'queued') : undefined;
      let companion = entry.companionInputId ? current.find(row => row.id === entry.companionInputId)
        : queueHead && session && runtime.queuedAfterTurn(queueHead, session) && !queueHead.finishOwner && queueHead.purpose !== 'decision' && queueHead.attachmentDelivery !== 'tool' ? queueHead : undefined;
      if (entry.companionInputId && (!companion || companion.state !== 'browser' || companion.owner !== entry.owner || companion.sessionId !== entry.sessionId)) return null;
      // Optional queued work cannot make an otherwise deliverable correction too large.
      if (companion && !entry.companionInputId &&
          (!runtime.inputArgs.shape.images.safeParse([...entry.images ?? [], ...companion.images ?? []]).success ||
           !runtime.inputArgs.shape.attachments.safeParse([...entry.attachments ?? [], ...companion.attachments ?? []]).success)) companion = undefined;
      const observed = session?.selectedModel?.conversationId === conversationId ? session?.selectedModel : null;
      const selection = runtime.browserInputModel(entry);
      const settings = runtime.getConfig().ui;
      const instruction = settings.finishTool && entry.purpose !== 'decision' && session?.origin?.kind !== 'worker' && session?.origin?.kind !== 'helper' &&
        runtime.isAstraModel(selection.model ?? observed?.model, selection.model ? selection.reasoningEffort ?? undefined : observed?.reasoningEffort)
        ? runtime.finishInstruction(settings.finishLeadMinutes) : '';
      const suffix = instruction && !entry.text.includes(instruction) ? '\n\n' + instruction : '';
      let claimed: InputEntry;
      // Freeze the prepared bytes into the exclusive claim so retries cannot change its payload.
      const prepareClaim = (checkpoint?: InputEntry) => runtime.prepare({ ...runtime.combinedInput(entry, checkpoint), ...(checkpoint ? { companionInputId: checkpoint.id } : {}), ...(completedTurnId ? { completedTurnId } : {}),
        ...(entry.transportIntent === 'tool' ? { transportIntent: 'browser' } : {}),
        state: 'browser', owner, conversationId, offeredAt: entry.offeredAt ?? Date.now(), requiresAuthorization }, suffix);
      try {
        try { claimed = await prepareClaim(companion); }
        catch (error) {
          if (!companion || entry.companionInputId || !(error instanceof Error) || !error.message.includes('Prepared message exceeds the delivery limit')) throw error;
          companion = undefined;
          claimed = await prepareClaim();
        }
        claimed = { ...claimed, text: entry.text, images: entry.images, attachments: entry.attachments };
      } catch (error) {
        // Oversized legacy rows need a terminal result rather than endless browser claims.
        if (entry.state === 'queued') await runtime.commit(current.map(row => row === entry
          ? { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) } : row));
        throw error;
      }
      await runtime.transition(current, current.map(row => row === entry ? claimed : row === companion ? { ...row,
        state: 'browser', owner, conversationId, offeredAt: claimed.offeredAt, requiresAuthorization, completedTurnId: claimed.completedTurnId } : row),
        entry.state === 'queued' && entry.automation && conversationId && entry.purpose !== 'decision' ? [claimed] : [], 'before-send');
      if (!requiresAuthorization && completedTurnId && entry.sessionId && conversationId)
        await runtime.consumeGoalReplyForInputNow(conversationId, entry.sessionId, completedTurnId);
      runtime.logInfo(`input ${id}: browser claimed after ${Math.max(0, Date.now() - entry.createdAt)} ms`);
      return { ...runtime.combinedInput(claimed, companion), ...selection, text: claimed.deliveryText ?? claimed.text };
    });
  }

  return { claimBrowserInput, pendingBrowserInputs };
}
