import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { isLocalExecutorRunning, sendDesktopInput } from '../sessions/input/start-input.js';
import { listInputs, type InputEntry } from '../sessions/input/input.js';
import { findSessionByConversation, getSession } from '../sessions/history/store.js';
import {
  agentInfoForOwnedConversation,
  failWorkerRevival,
  noteWorkerRevived,
  type WorkerRevival
} from './agents.js';
import { persistAgentChange, recordAgentDeliveryReport } from './local-agent-delivery-reports.js';
import { deterministicDeliveryUuid, routeForConversation, workerInput } from './local-agent-delivery-primitives.js';

interface PendingRevivalReceipt {
  revival: WorkerRevival;
  inputId: string;
}

export function createLocalAgentRevivalDelivery() {
  const pendingRevivalReceipts = new Map<string, PendingRevivalReceipt>();

  function revivalInputId(revival: WorkerRevival): string {
    const info = agentInfoForOwnedConversation(revival.conversationId);
    const epoch = info?.sleptAt ?? info?.createdAt ?? 0;
    return deterministicDeliveryUuid(`revival:${revival.runId}:${revival.id}:${revival.conversationId}:${epoch}:${revival.messageIds.join(':')}`);
  }

  async function acceptRevivalReceipt(entry: Readonly<InputEntry>): Promise<void> {
    const pending = pendingRevivalReceipts.get(entry.id);
    if (!pending) return;
    if (entry.conversationId !== pending.revival.conversationId) throw new Error('A worker wake was accepted by a different conversation.');
    const { revival, inputId } = pending;
    const noted = noteWorkerRevived(revival.id, revival.conversationId, revival.messageIds, inputId, revival.runId);
    if (!noted) {
      const current = agentInfoForOwnedConversation(revival.conversationId);
      if (current?.state === 'active') {
        pendingRevivalReceipts.delete(entry.id);
        return;
      }
      throw new Error('The worker wake no longer owns its exact broker reservation.');
    }
    if (!(await persistAgentChange())) {
      const report = failWorkerRevival(revival.id, 'its local wake could not be made durable', revival.runId);
      if (report) await recordAgentDeliveryReport(report, revival.conversationId);
      pendingRevivalReceipts.delete(entry.id);
      throw new Error('The worker wake could not cross its durable delivery barrier.');
    }
    pendingRevivalReceipts.delete(entry.id);
    logInfo(`multi-agent: local wake for ${revival.id} reached the durable input outbox`);
  }

  async function failRevival(revival: WorkerRevival, error: unknown): Promise<void> {
    pendingRevivalReceipts.delete(revivalInputId(revival));
    const reason = `The local provider could not deliver this wake: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
    await recordAgentDeliveryReport(failWorkerRevival(revival.id, reason, revival.runId), revival.conversationId);
  }

  async function deliverRevival(revival: WorkerRevival): Promise<void> {
    if (!getConfig().multiAgent.enabled) return;
    const current = agentInfoForOwnedConversation(revival.conversationId);
    if (!current || current.role !== 'worker' || current.id !== revival.id || current.runId !== revival.runId || current.state !== 'waking') return;
    const inputId = revivalInputId(revival);
    const existing = (await listInputs()).find(entry => entry.id === inputId);
    if (existing && existing.state !== 'queued' && existing.state !== 'sent') {
      await failRevival(revival, existing.error || `The stored wake is ${existing.state}.`);
      return;
    }
    try {
      const sessionSummary = await findSessionByConversation(revival.conversationId, { requireUnique: true });
      const session = sessionSummary ? await getSession(sessionSummary.id) : null;
      if (!session || session.conversationId !== revival.conversationId || session.origin?.kind !== 'worker' ||
          session.origin.agentId !== revival.id) {
        throw new Error('The worker chat has no matching durable session.');
      }
      if (existing?.state === 'sent' && !isLocalExecutorRunning(session.id)) {
        await failRevival(revival, 'the app restarted after this wake was accepted; the ambiguous input was not repeated');
        return;
      }
      const route = routeForConversation(revival.conversationId);
      pendingRevivalReceipts.set(inputId, { revival, inputId });
      const input = workerInput(inputId, session.id, revival.text, route, current.model, current.reasoningEffort);
      const entry = await sendDesktopInput(input);
      if (entry.state === 'sent') await acceptRevivalReceipt(entry);
      else if (entry.state === 'failed' || entry.state === 'cancelled') {
        await failRevival(revival, entry.error || `The stored wake is ${entry.state}.`);
      }
    } catch (error) {
      await failRevival(revival, error);
      logWarn(`multi-agent: could not wake ${revival.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    acceptRevivalReceipt,
    deliverRevival,
    clearPendingReceipts: () => pendingRevivalReceipts.clear()
  };
}
