import { dialog } from 'electron';
import { exportSessionMarkdown } from '../../infrastructure/desktop-shell/session-markdown-export.js';
import { z } from 'zod';
import { committedResumeAncestorsFromSummary, type SessionChange } from '../../../contracts/session.js';
import { sessionListCursorSchema, readSessionEvents, readSessionList } from '../../domains/sessions/history/read-model.js';
import { clearImageStorage, clearSessionName, createSession, deleteSession, getImageStorage, getSession, readHandoff, rebindSession, renameSession, withSessionMutationFence } from '../../domains/sessions/history/store.js';
import { forgetSession, notifyChanged } from '../../domains/sessions/history/recorder.js';
import { recordedInputImage } from '../../domains/sessions/input/input-history.js';
import { locateSearchMatch, searchSessions } from '../../domains/sessions/history/search.js';
import { blockedChatIds, setChatsBlocked } from '../../domains/sessions/continuity/blocked-chats.js';
import { setChatsTrusted, trustedChatIds } from '../../domains/sessions/continuity/trusted-chats.js';
import { inputArgs, listInputs, editQueuedInput, reorderQueuedInputs, setInputAutomation, pausedBrowserHelpers } from '../../domains/sessions/input/input.js';
import { stageInputAttachments, type AttachmentSource } from '../../domains/sessions/input/attachments/index.js';
import { validateInputImages } from '../../domains/sessions/input/input-images.js';
import { sendDesktopInput, cancelDesktopInput, retryQueuedInputBrowser } from '../../domains/sessions/input/start-input.js';
import { releaseSessionFinish, requestSessionFinishGoal } from '../../domains/sessions/input/finish.js';
import { runningToolActivity } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { runningExecProcesses, stopExecProcess } from '../../domains/workspace/execution/ownership.js';
import { keychainNoticeReady } from '../../infrastructure/desktop-shell/keychain-notice.js';
import { draftTaskPlan, retryGoalBrowserHelper } from '../../domains/automation/goal.js';
import { workerPrimeOwner } from '../../domains/automation/agents.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { UI_BASE_ZOOM } from '../../infrastructure/desktop-shell/window-layout.js';
import { randomUUID } from 'node:crypto';
import { runTaskRequest } from '../../domains/automation/task-requests/registry.js';
import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { webProviderConversationId } from '../../../contracts/web-providers.js';
import { assignSessionProject } from '../../domains/workspace/projects.js';
import { attachmentSchema, MAX_ATTACHMENTS } from '../../domains/sessions/input/attachments/index.js';
import { markFreshAttachmentUploadSession, preuploadDeepseekAttachments, removeDeepseekAttachments } from '../../domains/providers/preuploaded-attachments.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { loadIntegratedBrowser } from '../../domains/browser/embedded/selection.js';
import { sessionControlsFor, cancelAssistantRecovery, stopSessionTurn, setSessionAutomation, setSessionObjective, compactSession, cancelSessionCompaction, revealChatInBrowser, sweepStaleSwarm } from '../../domains/browser/bridge.js';
import type { IpcRouteContext } from './types.js';

const sessionIdArg = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i) });
const sessionNameArg = sessionIdArg.extend({ title: z.string().max(2000).nullable() });

export function cleanSessionName(title: string | null): string | null {
  const clean = (title ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
  return clean || null;
}

export async function openSessionChat(id: string): Promise<void> {
  const summary = await getSession(id);
  const conversationId = summary?.conversationId;
  if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(conversationId)) throw new Error('This session has no valid provider conversation');
  const provider = providerForConversationId(conversationId);
  if (!provider) {
    if (isApiConversationId(conversationId)) throw new Error('API conversations are available in the NEURAFLOK workspace, not in a provider browser.');
    throw new Error('This session is not linked to a supported browser provider.');
  }
  const integrated = getConfig().ui.chatBrowser === 'integrated';
  const integratedBrowser = integrated ? await loadIntegratedBrowser() : null;
  const opened = integratedBrowser
    ? await integratedBrowser.revealProviderConversation(provider, conversationId)
    : !integrated && await revealChatInBrowser(conversationId);
  if (!opened) throw new Error(`The exact ${provider} conversation page is not open in the selected browser.`);
}

export function registerSessionIpc({ handle, getWindow, push, deletingSessionIds }: Pick<IpcRouteContext, 'handle' | 'getWindow' | 'push'> & { deletingSessionIds: Set<string> }): void {

  handle('sessions:list', async (payload) => {
    const { cursor, limit } = z
      .object({
        cursor: sessionListCursorSchema.optional(),
        // Keep one renderer payload small even when the store can index much more history.
        limit: z.number().int().min(1).max(60).optional()
      })
      .parse(payload ?? {});
    return readSessionList({ cursor, limit: limit ?? 60 });
  });

  handle('sessions:image', async (payload) => {
    const { id, assetId } = z.object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i), assetId: z.string().max(100).regex(/^[a-f0-9]{8,64}\.(?:bin|png|jpg)$/) }).parse(payload);
    return recordedInputImage(id, assetId);
  });
  handle('sessions:imageStorage', async () => getImageStorage());
  handle('sessions:clearImageStorage', async (payload) => {
    const { mode } = z.object({ mode: z.enum(['oldest-gib', 'all']) }).parse(payload);
    const result = await clearImageStorage(mode);
    // Retired images can belong to any transcript; this is the explicit global invalidation.
    push('session:changed', { allTranscripts: true } satisfies SessionChange);
    return result;
  });
  handle('sessions:events', async (payload) => {
    const { id, ...options } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        from: z.number().int().min(0).max(10_000_000).optional(),
        before: z.number().int().min(1).max(10_000_000).optional(),
        after: z.number().int().min(0).max(10_000_000).optional(),
        limit: z.number().int().min(1).max(1000).optional()
      })
      .parse(payload);
    const page = await readSessionEvents(id, options);
    if (!page) throw new Error('Session not found');
    return page;
  });

  const stageFiles = async (sources: AttachmentSource[]) => {
    const retained = new Set((await listInputs()).filter(row => !['sent', 'failed', 'cancelled'].includes(row.state)).flatMap(row => row.attachments?.map(file => file.id) ?? []));
    return stageInputAttachments(sources, retained);
  };
  handle('sessions:files', async () => {
    const chosen = await dialog.showOpenDialog({ title: 'Attach files', properties: ['openFile', 'multiSelections'] });
    if (chosen.canceled) return [];
    if (chosen.filePaths.length > MAX_ATTACHMENTS) throw new Error('Attach up to 50 files per message');
    return stageFiles(chosen.filePaths);
  });
  handle('sessions:dropFiles', async payload => {
    const { files } = z.object({ files: z.array(z.union([
      z.string().min(1).max(32768),
      z.object({ name: z.string().min(1).max(255), bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= 100 * 1024 * 1024) }).strict()
    ])).min(1).max(MAX_ATTACHMENTS) }).strict().parse(payload);
    return stageFiles(files);
  });
  handle('sessions:attachText', async payload => {
    const { text } = z.object({ text: z.string().min(1).max(4 * 1024 * 1024) }).parse(payload);
    return (await stageFiles([{ text }]))[0]!;
  });
  handle('sessions:ensureAttachmentSession', async payload => {
    const { sessionId, projectId } = z.object({
      sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i).nullable(),
      projectId: z.string().uuid().nullable()
    }).strict().parse(payload);
    let summary = sessionId ? await getSession(sessionId) : null;
    if (sessionId && !summary) throw new Error('The selected chat is no longer available.');
    if (!summary) {
      const conversationId = webProviderConversationId('deepseek', randomUUID());
      summary = await createSession({ title: 'New chat', conversationId });
      markFreshAttachmentUploadSession(summary.id, conversationId);
      if (projectId) await assignSessionProject(summary.id, projectId);
    } else if (!summary.conversationId) {
      const page = await readSessionEvents(summary.id, { limit: 1 });
      if (page?.events.length) throw new Error('This chat already has local history and cannot be changed into a DeepSeek chat.');
      const conversationId = webProviderConversationId('deepseek', randomUUID());
      if (!await rebindSession(summary.id, null, conversationId)) throw new Error('Could not prepare this chat for the file upload.');
      markFreshAttachmentUploadSession(summary.id, conversationId);
      if (projectId && !summary.projectId) await assignSessionProject(summary.id, projectId);
    }
    const ensuredId = summary.id;
    if (projectId && !summary.projectId) await assignSessionProject(ensuredId, projectId);
    summary = await getSession(ensuredId);
    if (!summary) throw new Error('The selected chat could not be loaded.');
    const conversationId = summary.conversationId;
    if (!conversationId || providerForConversationId(conversationId) !== 'deepseek') {
      throw new Error('Files can be pre-uploaded only to a DeepSeek Web chat.');
    }
    return summary;
  });
  handle('sessions:uploadProviderAttachments', async payload => {
    const { sessionId, attachments } = z.object({
      sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
      attachments: z.array(attachmentSchema).min(1).max(MAX_ATTACHMENTS)
    }).strict().parse(payload);
    const summary = await getSession(sessionId);
    if (!summary?.conversationId || providerForConversationId(summary.conversationId) !== 'deepseek') {
      throw new Error('The selected chat is not connected to DeepSeek Web.');
    }
    await preuploadDeepseekAttachments(sessionId, summary.conversationId, attachments);
    return { sessionId, attachmentIds: attachments.map(file => file.id), ready: true as const };
  });
  handle('sessions:removeProviderAttachments', async payload => {
    const { sessionId, attachments } = z.object({
      sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
      attachments: z.array(attachmentSchema).min(1).max(MAX_ATTACHMENTS)
    }).strict().parse(payload);
    const summary = await getSession(sessionId);
    if (!summary?.conversationId || providerForConversationId(summary.conversationId) !== 'deepseek') {
      throw new Error('The selected chat is not connected to DeepSeek Web.');
    }
    await removeDeepseekAttachments(summary.conversationId, attachments);
    return { sessionId, attachmentIds: attachments.map(file => file.id), removed: true as const };
  });
  handle('sessions:stopTurn', async payload => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    return stopSessionTurn(id, expectedTurnId);
  });
  handle('sessions:releaseFinish', async (payload) => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    await sessionControlsFor(id);
    await releaseSessionFinish(id, expectedTurnId);
    return sessionControlsFor(id);
  });
  handle('sessions:generateFinishGoal', async payload => {
    const { id, expectedTurnId } = sessionIdArg.extend({ expectedTurnId: z.string().min(1).max(256) }).parse(payload);
    return requestSessionFinishGoal(id, expectedTurnId);
  });
  handle('sessions:controls', async (payload) => sessionControlsFor(sessionIdArg.parse(payload).id));
  // Keep a confirmed answer from reloading until the browser claims it.
  handle('sessions:cancelRecovery', async (payload) => cancelAssistantRecovery(sessionIdArg.parse(payload).id));
  handle('sessions:automation', async (payload) => {
    const { id, automation, afterTurn } = sessionIdArg.extend({ automation: z.enum(['off', 'goal', 'loop']), afterTurn: z.boolean().optional() }).parse(payload);
    return setSessionAutomation(id, automation, afterTurn);
  });
  handle('sessions:objective', async (payload) => {
    const { id, text, mode } = sessionIdArg.extend({ text: z.string().max(16000), mode: z.enum(['goal', 'loop']) }).parse(payload);
    return setSessionObjective(id, text, mode);
  });
  handle('sessions:compact', async (payload) => compactSession(sessionIdArg.parse(payload).id));
  handle('sessions:cancelCompaction', async (payload) => cancelSessionCompaction(sessionIdArg.parse(payload).id));
  handle('sessions:plan', async (payload) => {
    const { text, backend, requestId } = z.object({ text: z.string().trim().min(1).max(16000), backend: z.enum(['api', 'web']), requestId: z.string().uuid().optional() }).parse(payload);
    const publish = (progress: import('../../../contracts/automation/task-progress.js').TaskProgressUpdate) => {
      const target = getWindow();
      if (requestId && target && !target.isDestroyed()) target.webContents.send('task:progress', { requestId, ...progress });
    };
    return runTaskRequest(requestId ?? randomUUID(), JSON.stringify(['plan', text, backend]), signal => draftTaskPlan(text, backend, publish, signal), publish);
  });
  handle('sessions:send', async (payload) => {
    const input = inputArgs.parse(payload);
    await validateInputImages(input.images ?? []);
    return sendDesktopInput(input);
  });
  handle('sessions:outbox', async () => (await listInputs()).filter((row) => row.purpose !== 'decision'));
  handle('sessions:reorderInputs', async (payload) => {
    const { sessionId, ids } = z.object({ sessionId: z.string().min(8).max(64), ids: z.array(z.string().uuid()).min(1).max(10000) }).parse(payload);
    return reorderQueuedInputs(sessionId, ids);
  });
  handle('sessions:retryBrowser', async (payload) => retryQueuedInputBrowser(z.object({ id: z.string().uuid() }).parse(payload).id));
  handle('sessions:pausedHelpers', async () => pausedBrowserHelpers());
  // What a working chat's tool calls are doing right now, for its live caption.
  handle('sessions:runningTools', async (payload) => {
    const { conversationIds } = z.object({ conversationIds: z.array(z.string().min(1).max(200)).max(16) }).parse(payload);
    return runningToolActivity(conversationIds);
  });
  handle('sessions:runningProcesses', async (payload) => {
    const { sessionId } = z.object({
      sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)
    }).parse(payload);
    return runningExecProcesses(sessionId);
  });
  handle('sessions:stopProcess', async (payload) => {
    const { sessionId, processId, incarnation } = z.object({
      sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
      processId: z.number().int().min(1_000).max(99_999),
      incarnation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
    }).parse(payload);
    return stopExecProcess(sessionId, processId, incarnation);
  });
  // The window armed its Keychain notice; the first Keychain read may start.
  handle('keychain:noticeReady', async () => keychainNoticeReady());
  handle('sessions:retryHelper', async (payload) => {
    const { id, sourceSessionId } = z.object({ id: z.string().uuid(), sourceSessionId: z.string().min(8).max(64) }).parse(payload);
    return retryGoalBrowserHelper(sourceSessionId, id);
  });
  handle('sessions:editInput', async (payload) => { const { id, text, afterTurn } = z.object({ id: z.string().uuid(), text: inputArgs.shape.text, afterTurn: z.boolean().optional() }).parse(payload); return editQueuedInput(id, text, afterTurn); });
  handle('sessions:cancelInput', async (payload) => cancelDesktopInput(z.object({ id: z.string().uuid() }).parse(payload).id));
  handle('sessions:inputAutomation', async payload => {
    const { id, mode, loopAfterTurn } = z.object({ id: z.string().uuid(), mode: z.enum(['off', 'goal', 'loop']), loopAfterTurn: z.boolean().optional() }).parse(payload);
    return setInputAutomation(id, mode, loopAfterTurn);
  });
  handle('window:getZoom', async () => (getWindow()?.webContents.getZoomFactor() ?? UI_BASE_ZOOM) / UI_BASE_ZOOM);
  handle('window:zoom', async (payload) => {
    const { factor } = z.object({ factor: z.number().min(0.75).max(1.5) }).parse(payload);
    getWindow()?.webContents.setZoomFactor(factor * UI_BASE_ZOOM);
    return factor;
  });

  handle('sessions:openChat', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    await openSessionChat(id);
    return true;
  });

  /** Blocks or releases the provider conversation bound to the requested session. */
  handle('sessions:block', async (payload) => {
    const { id, blocked } = z
      .object({ id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i), blocked: z.boolean() })
      .parse(payload);
    if (deletingSessionIds.has(id)) {
      throw new Error('This session is being deleted; its block cannot be changed');
    }
    const conversationId = await withSessionMutationFence(id, async (summary) => {
      if (deletingSessionIds.has(id)) {
        throw new Error('This session is being deleted; its block cannot be changed');
      }
      const currentConversationId = summary.conversationId;
      if (!currentConversationId || !/^[0-9a-z-]{8,64}$/i.test(currentConversationId)) {
        throw new Error('This session has no valid provider conversation');
      }
      setChatsBlocked(
        blocked
          ? [currentConversationId]
          : [currentConversationId, ...committedResumeAncestorsFromSummary(summary, currentConversationId)],
        blocked
      );
      return currentConversationId;
    });
    logInfo(
      blocked
        ? `conversation ${conversationId} blocked; its tool calls are refused until it is released`
        : `conversation ${conversationId} released; its tool calls run again`
    );
    // A blocked worker chat frees its swarm slot now, not on the next 30-second pass: the user pressing Block on a worker is usually about to start something in its place.
    if (blocked) await sweepStaleSwarm().catch(() => undefined);
    return blockedChatIds();
  });

  handle('sessions:trust', async (payload) => {
    const { id, expectedConversationId, trusted } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        expectedConversationId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        trusted: z.boolean()
      })
      .parse(payload);
    if (deletingSessionIds.has(id)) {
      throw new Error('This session is being deleted; its trust cannot be changed');
    }
    const conversationId = await withSessionMutationFence(id, async (summary) => {
      // Delete may have started while this operation was waiting behind an earlier session write. If Trust entered this queue first it linearizes before Delete; otherwise the tombstone wins.
      if (deletingSessionIds.has(id)) {
        throw new Error('This session is being deleted; its trust cannot be changed');
      }
      const currentConversationId = summary.conversationId;
      if (!currentConversationId || !/^[0-9a-z-]{8,64}$/i.test(currentConversationId)) {
        throw new Error('This session has no valid provider conversation');
      }
      if (currentConversationId !== expectedConversationId) {
        throw new Error('This session moved to another provider conversation; refresh the chat list before changing trust');
      }
      const workerOwner = workerPrimeOwner(currentConversationId);
      if (trusted && (workerOwner.owned || summary.origin?.kind === 'worker')) {
        throw new Error('Worker chats cannot be trusted directly; trust the owning prime chat instead');
      }
      // The current resumed row is the only UI handle left after A -> B. Its Untrust action must remove every explicit Trust entry that can still grant B through committed provenance; deleting only B would immediately fall through to a still-trusted A. Worker Untrust is deliberately exact-only so stale pre-fix worker entries can be cleaned without touching the owning prime.
      const trustTargets = !trusted && !workerOwner.owned
        ? [currentConversationId, ...committedResumeAncestorsFromSummary(summary, currentConversationId)]
        : [currentConversationId];
      await setChatsTrusted(trustTargets, trusted);
      return currentConversationId;
    });
    logInfo(trusted
      ? `conversation ${conversationId} trusted for strict chat allowlisting`
      : `conversation ${conversationId} removed from strict chat allowlisting`);
    return trustedChatIds();
  });

  // Search chats by title and message content.
  handle('sessions:search', async (payload) => {
    const { query } = z.object({ query: z.string().max(200) }).parse(payload);
    return searchSessions(query);
  });
  // Where a text match is in its chat, so opening the result shows that message.
  handle('sessions:locate-match', async (payload) => {
    const { id, query } = sessionIdArg.extend({ query: z.string().max(200) }).parse(payload);
    return locateSearchMatch(id, query);
  });
  handle('sessions:rename', async (payload) => {
    const { id, title } = sessionNameArg.parse(payload);
    if (!await getSession(id)) throw new Error('Session not found');
    const name = cleanSessionName(title);
    if (name) await renameSession(id, name, 'manual');
    else await clearSessionName(id);
    notifyChanged(id);
    return true;
  });
  handle('sessions:delete', async (payload) => {
    const { id } = sessionIdArg.parse(payload);
    if (deletingSessionIds.has(id)) throw new Error('This session is already being deleted');
    deletingSessionIds.add(id);
    try {
      const summary = await getSession(id);
      // Trust is permission. Revoke it durably before any other deletion side effect; otherwise a failed disk commit could leave this chat both trusted and newly unblocked, with its row already gone and no user control left to repair that authority.
      if (summary?.conversationId) {
        await setChatsTrusted([
          summary.conversationId,
          ...committedResumeAncestorsFromSummary(summary, summary.conversationId)
        ], false);
      }
      // Detach first so later provider observations cannot resolve to a deleted session. deleting the folder underneath a live one left it appending to a session that no longer existed — the events went to a resurrected half-session with no summary. Forgetting the mapping makes the next observation open a fresh session instead.
      const detached = forgetSession(id);
      // Release first. The current resumed row is also the only UI handle for a Block on one of its committed predecessors, so deleting the row must clear that whole policy lineage. Otherwise a hidden source block survives with no remaining row that can release it.
      if (summary?.conversationId) {
        setChatsBlocked([
          summary.conversationId,
          ...committedResumeAncestorsFromSummary(summary, summary.conversationId)
        ], false);
      }
      await deleteSession(id);
      logInfo(
        detached.length > 0
          ? `session ${id} deleted; ${detached.length} live conversation(s) will start a new session`
          : `session ${id} deleted`
      );
      return true;
    } finally {
      deletingSessionIds.delete(id);
    }
  });

  handle('handoff:get', async (payload) => {
    const { id, handoffId } = z
      .object({
        id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
        handoffId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i).optional()
      })
      .parse(payload);
    if (handoffId) return readHandoff(id, handoffId);
    const summary = await getSession(id);
    return summary?.lastHandoffId ? readHandoff(id, summary.lastHandoffId) : null;
  });

  handle('sessions:exportMarkdown', async (payload) => {
    const request = z.object({
      id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
      scope: z.enum(['answer', 'session']),
      turnId: z.string().min(1).max(200).optional(),
      target: z.enum(['clipboard', 'file'])
    }).parse(payload);
    return exportSessionMarkdown(request, getWindow());
  });

  // The Install button. The renderer decides nothing about what is installed - it cannot name a file, a version or a path - it only says "now", and only a staged, digest-checked artifact makes that mean anything. The quit is what applies it, at the end of the same shutdown sequence every other quit runs; refusing here is how a press with nothing staged avoids closing the app for no reason.

}
