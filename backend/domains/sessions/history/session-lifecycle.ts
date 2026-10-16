import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isApiConversationId } from '../../../../contracts/chat-protocol.js';
import type { Handoff, ReasoningEffort, SessionOrigin, SessionSummary, WorkerAssignmentSummary } from '../../../../contracts/session.js';
import type { ApiProviderSettings } from '../../../../contracts/types.js';
import { isWebProviderConversationId } from '../../../../contracts/web-providers.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { automaticTitle, firstTitleMessage, projectPageTitle, providerTitleIgnored, userTitle } from './title.js';
import type { OpenSession } from './store.js';

interface Runtime {
  assertSessionId(id: string): void;
  ensureOpen(id: string): Promise<OpenSession>;
  enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T>;
  writeMeta(entry: OpenSession): Promise<void>;
  writeSummary(summary: SessionSummary, historySeq: number): Promise<void>;
  sessionDirectory(id: string): string;
  getOpenSession(id: string): OpenSession | undefined;
  deleteOpenSession(id: string, expected?: OpenSession): void;
  getSession(id: string): Promise<SessionSummary | null>;
  findSessionByConversation(id: string, options?: { requireUnique?: boolean }): Promise<SessionSummary | null>;
  clearMissingCurrentConversation(id: string): void;
  publishClosedSummary(summary: SessionSummary): void;
  publishAttachmentSummary(summary: SessionSummary): void;
  publishCachedSummary(summary: SessionSummary, reorder: boolean): void;
  publishAttachmentRemoval(id: string): void;
  invalidateAssetUsage(id: string): void;
  readEverySummary(): Promise<SessionSummary[]>;
}

export function createSessionLifecycle(runtime: Runtime) {
  async function endSession(id: string, dismissBrowserRecovery = false, expectedConversationId?: string): Promise<void> {
    const entry = dismissBrowserRecovery ? await runtime.ensureOpen(id) : runtime.getOpenSession(id);
    if (!entry) return;
    const ended = await runtime.enqueueSessionOperation(entry, 'end', async () => {
      if (expectedConversationId !== undefined && entry.summary.conversationId !== expectedConversationId) return false;
      if (entry.metaTimer) {
        clearTimeout(entry.metaTimer);
        entry.metaTimer = null;
      }
      entry.summary.endedAt = Date.now();
      if (dismissBrowserRecovery) entry.summary.browserRecoveryDismissedAt = entry.summary.endedAt;
      await runtime.writeMeta(entry);
      runtime.publishClosedSummary(entry.summary);
      return true;
    });
    if (ended) runtime.deleteOpenSession(id, entry);
  }

  async function reopenSession(id: string, pageObservedAt?: number): Promise<void> {
    const entry = await runtime.ensureOpen(id);
    await runtime.enqueueSessionOperation(entry, 'reopen', async () => {
      const dismissedAt = entry.summary.browserRecoveryDismissedAt;
      const returned = dismissedAt !== undefined && pageObservedAt !== undefined && pageObservedAt > dismissedAt;
      if (entry.summary.endedAt === null && !returned) return;
      if (returned) delete entry.summary.browserRecoveryDismissedAt;
      entry.summary.endedAt = null;
      entry.summary.updatedAt = Date.now();
      await runtime.writeMeta(entry);
    });
  }

  async function renameSession(
    id: string,
    title: string,
    source: SessionSummary['titleSource'] = 'manual',
    conversationId?: string
  ): Promise<void> {
    const entry = await runtime.ensureOpen(id);
    await runtime.enqueueSessionOperation(entry, 'rename', async () => {
      if (source !== 'manual' && entry.summary.titleSource === 'manual') {
        if (source === undefined || (conversationId && entry.summary.conversationId !== conversationId)) return;
        if (entry.summary.origin && entry.summary.origin.kind !== 'desktop') return;
        const auto = entry.summary.autoTitle;
        if (source === 'fallback' && auto?.source === 'provider') return;
        if (source === 'provider' && (providerTitleIgnored(entry.summary) || projectPageTitle(title))) return;
        const next = { title: title.slice(0, 120), source };
        if (auto?.title === next.title && auto.source === next.source) return;
        entry.summary.autoTitle = next;
        await runtime.writeMeta(entry);
        return;
      }
      if (source === 'manual' && entry.summary.titleSource !== 'manual') {
        entry.summary.autoTitle = { title: entry.summary.title, source: entry.summary.titleSource === 'provider' ? 'provider' : 'fallback' };
      }
      if (source !== 'manual') {
        if (conversationId && entry.summary.conversationId !== conversationId) return;
        if (!automaticTitle(entry.summary, firstTitleMessage(entry.messages.values()))) return;
        if (source === 'fallback' && entry.summary.titleSource === 'provider') return;
        if (source === 'provider' && (providerTitleIgnored(entry.summary) || projectPageTitle(title))) return;
      }
      if (entry.summary.title === title.slice(0, 120) && entry.summary.titleSource === source) return;
      entry.summary.title = title.slice(0, 120);
      entry.summary.titleSource = source;
      await runtime.writeMeta(entry);
    });
  }

  async function clearSessionName(id: string): Promise<void> {
    const entry = await runtime.ensureOpen(id);
    await runtime.enqueueSessionOperation(entry, 'rename', async () => {
      if (entry.summary.titleSource !== 'manual') return;
      const auto = entry.summary.autoTitle;
      const first = firstTitleMessage(entry.messages.values());
      entry.summary.title = auto?.title || (first ? userTitle(first.message.text, first.authoredText) : '') || 'New chat';
      entry.summary.titleSource = auto?.source ?? 'fallback';
      delete entry.summary.autoTitle;
      await runtime.writeMeta(entry);
    });
  }

  async function observeSessionModel(
    id: string,
    conversationId: string,
    model: string,
    observedAt: number,
    reasoningEffort?: ReasoningEffort,
    apiProvider?: ApiProviderSettings
  ): Promise<void> {
    if (!/^[a-zA-Z0-9 ._~:/@-]{1,160}$/.test(model) || !Number.isFinite(observedAt) ||
        (apiProvider !== undefined && (!apiProvider || !['openai', 'openrouter', 'custom'].includes(apiProvider.kind) ||
          typeof apiProvider.baseUrl !== 'string' || apiProvider.baseUrl.length > 2048))) return;
    const entry = await runtime.ensureOpen(id);
    await runtime.enqueueSessionOperation(entry, 'model-selection', async () => {
      if (entry.summary.conversationId !== conversationId ||
          observedAt < (entry.summary.selectedModel?.observedAt ?? 0)) return;
      const selectedModel = {
        conversationId, model, observedAt,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(apiProvider ? { apiProvider: { kind: apiProvider.kind, baseUrl: apiProvider.baseUrl } } : {})
      };
      if (JSON.stringify(entry.summary.selectedModel) === JSON.stringify(selectedModel)) return;
      const staged = { ...entry.summary, selectedModel };
      await runtime.writeSummary(staged, entry.historySeq);
      entry.summary = staged;
      runtime.publishAttachmentSummary(staged);
    });
  }

  async function bindSessionProject(id: string, projectId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/i.test(projectId)) throw new Error('Invalid project id');
    const entry = await runtime.ensureOpen(id);
    await runtime.enqueueSessionOperation(entry, 'project', async () => {
      if (entry.summary.projectId === projectId) return;
      if (entry.summary.projectId) throw new Error('Session already belongs to another project');
      const staged = { ...entry.summary, projectId };
      await runtime.writeSummary(staged, entry.historySeq);
      entry.summary = staged;
      runtime.publishAttachmentSummary(staged);
    });
  }

  async function setSessionOrigin(id: string, origin: SessionOrigin, title: string): Promise<void> {
    const inheritedProject = origin.fromSessionId ? (await runtime.getSession(origin.fromSessionId))?.projectId : undefined;
    const entry = await runtime.ensureOpen(id);
    await runtime.enqueueSessionOperation(entry, 'origin write', async () => {
      if (inheritedProject && entry.summary.projectId && entry.summary.projectId !== inheritedProject) throw new Error('Session origin belongs to another project');
      const named = entry.summary.titleSource === 'manual';
      const staged = { ...entry.summary, origin, ...(named ? { autoTitle: { title: title.slice(0, 120), source: 'fallback' as const } } : { title: title.slice(0, 120) }),
        ...(inheritedProject ? { projectId: inheritedProject } : {}) };
      await runtime.writeSummary(staged, entry.historySeq);
      entry.summary = staged;
      runtime.publishAttachmentSummary(staged);
    });
  }

  async function recordWorkerAssignment(assignment: WorkerAssignmentSummary): Promise<void> {
    if (!assignment.conversationId || !assignment.agentId || assignment.label.length > 60 ||
        assignment.task.length > 8200 || !Number.isFinite(assignment.recordedAt)) return;
    const summary = await runtime.findSessionByConversation(assignment.conversationId, { requireUnique: true });
    if (!summary) return;
    const entry = await runtime.ensureOpen(summary.id);
    await runtime.enqueueSessionOperation(entry, 'worker assignment projection', async () => {
      const current = entry.summary;
      if (current.conversationId !== assignment.conversationId || current.origin?.kind !== 'worker' ||
          current.origin.agentId !== assignment.agentId) return;
      const previous = current.workerAssignment;
      if (previous && (previous.recordedAt > assignment.recordedAt ||
          (previous.conversationId === assignment.conversationId && previous.label === assignment.label &&
            previous.task === assignment.task))) return;
      const staged = { ...current, workerAssignment: { ...assignment } };
      await runtime.writeSummary(staged, entry.historySeq);
      entry.summary = staged;
      runtime.publishAttachmentSummary(staged);
    });
  }

  async function rebindSession(
    id: string,
    fromConversationId: string | null,
    toConversationId: string,
    committedResumeHandoffId?: string
  ): Promise<boolean> {
    if (!toConversationId || fromConversationId === toConversationId) return false;
    if (committedResumeHandoffId !== undefined && !/^[0-9a-z-]{8,64}$/i.test(committedResumeHandoffId)) return false;
    runtime.clearMissingCurrentConversation(toConversationId);
    const entry = runtime.getOpenSession(id) ?? await runtime.ensureOpen(id);
    return runtime.enqueueSessionOperation(entry, 'rebind', async () => {
      if (entry.summary.conversationId !== fromConversationId) return false;
      if (/^[0-9a-f-]{8,64}$/i.test(toConversationId) || isWebProviderConversationId(toConversationId) || isApiConversationId(toConversationId)) {
        const target = await runtime.findSessionByConversation(toConversationId);
        if (target && target.id !== id) {
          logWarn('Session ' + id + ' cannot move to ' + toConversationId + ': that conversation already belongs to ' + target.id);
          return false;
        }
      }
      const staged: SessionSummary = {
        ...entry.summary,
        conversationId: toConversationId,
        retiredChatAt: fromConversationId ? { ...entry.summary.retiredChatAt, [fromConversationId]: Date.now() } : entry.summary.retiredChatAt,
        chatIds: entry.summary.chatIds.includes(toConversationId)
          ? [...entry.summary.chatIds]
          : [...entry.summary.chatIds, toConversationId],
        contextTokens: 0,
        activeTurnId: null,
        finishTurn: null,
        browserRecoveryDismissedAt: undefined,
        ...(committedResumeHandoffId !== undefined
          ? { lastCommittedResumeHandoffId: committedResumeHandoffId }
          : {}),
        updatedAt: Date.now(),
        endedAt: null
      };
      try {
        await runtime.writeSummary(staged, entry.historySeq);
      } catch (err) {
        logWarn('Session ' + id + ' could not move to ' + toConversationId + ': ' + (err as Error).message);
        return false;
      }
      Object.assign(entry.summary, staged);
      entry.metaDirty = false;
      runtime.clearMissingCurrentConversation(toConversationId);
      runtime.publishAttachmentSummary(entry.summary);
      logInfo(fromConversationId
        ? 'Session ' + id + ' moved from provider conversation ' + fromConversationId + ' to ' + toConversationId
        : 'Session ' + id + ' is now provider conversation ' + toConversationId);
      return true;
    });
  }

  async function ensureCommittedResumeHandoff(id: string, conversationId: string, handoffId: string): Promise<boolean> {
    if (!conversationId || !/^[0-9a-z-]{8,64}$/i.test(handoffId)) return false;
    const entry = await runtime.ensureOpen(id);
    return runtime.enqueueSessionOperation(entry, 'committed resume provenance repair', async () => {
      if (entry.summary.conversationId !== conversationId) return false;
      if (entry.summary.lastCommittedResumeHandoffId === handoffId) return true;
      const staged: SessionSummary = { ...entry.summary, lastCommittedResumeHandoffId: handoffId };
      await runtime.writeSummary(staged, entry.historySeq);
      Object.assign(entry.summary, staged);
      entry.metaDirty = false;
      runtime.publishCachedSummary(entry.summary, false);
      return true;
    });
  }

  async function saveHandoff(handoff: Handoff): Promise<void> {
    runtime.assertSessionId(handoff.sessionId);
    const dir = path.join(runtime.sessionDirectory(handoff.sessionId), 'handoffs');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, handoff.id + '.json');
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(handoff, null, 2), 'utf8');
    await fs.rename(tmp, target);
  }

  async function readHandoff(sessionId: string, handoffId: string): Promise<Handoff | null> {
    runtime.assertSessionId(sessionId);
    if (!/^[0-9a-z-]{8,64}$/i.test(handoffId)) return null;
    try {
      const raw = await fs.readFile(path.join(runtime.sessionDirectory(sessionId), 'handoffs', handoffId + '.json'), 'utf8');
      const parsed = JSON.parse(raw) as Handoff;
      if (typeof parsed?.text !== 'string') return null;
      if (parsed.version !== undefined || parsed.provenance !== undefined) {
        const provenance = parsed.provenance;
        if (
          parsed.version !== 1 ||
          parsed.id !== handoffId ||
          parsed.sessionId !== sessionId ||
          !provenance ||
          (provenance.sourceConversationId !== null &&
            (typeof provenance.sourceConversationId !== 'string' ||
              provenance.sourceConversationId.length === 0 ||
              provenance.sourceConversationId.length > 256)) ||
          (provenance.sourceGeneration !== null &&
            (!Number.isSafeInteger(provenance.sourceGeneration) || provenance.sourceGeneration < 1)) ||
          (provenance.sourceTurnId !== null &&
            (typeof provenance.sourceTurnId !== 'string' || provenance.sourceTurnId.length > 256)) ||
          (provenance.continuationId !== null &&
            (typeof provenance.continuationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(provenance.continuationId)))
        ) return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async function latestHandoff(): Promise<Handoff | null> {
    const sessions = await runtime.readEverySummary();
    let best: Handoff | null = null;
    for (const summary of sessions) {
      if (!summary.lastHandoffId) continue;
      const handoff = await readHandoff(summary.id, summary.lastHandoffId);
      if (handoff && (!best || handoff.createdAt > best.createdAt)) best = handoff;
    }
    return best;
  }

  async function deleteSession(id: string): Promise<void> {
    runtime.assertSessionId(id);
    const entry = runtime.getOpenSession(id);
    if (entry) {
      if (entry.metaTimer) clearTimeout(entry.metaTimer);
      await entry.queue.catch(() => undefined);
      runtime.deleteOpenSession(id);
    }
    await fs.rm(runtime.sessionDirectory(id), { recursive: true, force: true });
    runtime.invalidateAssetUsage(id);
    runtime.publishAttachmentRemoval(id);
  }

  return {
    endSession,
    reopenSession,
    renameSession,
    clearSessionName,
    observeSessionModel,
    bindSessionProject,
    setSessionOrigin,
    recordWorkerAssignment,
    rebindSession,
    ensureCommittedResumeHandoff,
    saveHandoff,
    readHandoff,
    latestHandoff,
    deleteSession
  };
}
