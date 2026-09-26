import { MAX_INPUT_IMAGES, queuedFollowup, type InputImage } from '../../../../contracts/input.js';
import { finishInstruction } from '../../../../contracts/automation/completion-policy.js';
import { isAstraModel } from '../../../../contracts/model-capabilities.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import { isChatBlocked } from '../continuity/blocked-chats.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import type { InputActivity } from './input-policy.js';
import type { InputEntry } from './input-schema.js';

export const TOOL_INPUT_TEXT_BYTES = 128000;
export const TOOL_INPUT_HEADER = '\n--- New instructions from the user ---\n';

export interface ToolInputBatch {
  messages: Array<{ text: string; images: InputImage[] }>;
  // One transport instruction follows the complete batch, including its images.
  reminder: string;
}

type Runtime = {
  serial<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<InputEntry[]>;
  getSession(sessionId: string): Promise<SessionSummary | null | undefined>;
  commit(next: InputEntry[]): Promise<void>;
  terminal(entry: InputEntry): boolean;
  offered: Map<string, number>;
  publishHistory(): Promise<void>;
  ordered(rows: InputEntry[]): InputEntry[];
  prepare(entry: InputEntry): Promise<InputEntry>;
  activity(session: SessionSummary): InputActivity | undefined;
  transition(current: InputEntry[], next: InputEntry[], automated: InputEntry[], phase: 'before-send' | 'after-send'): Promise<void>;
};

export function createInputToolDelivery(runtime: Runtime) {
  const { serial, load, getSession, commit, terminal, offered, publishHistory, ordered, prepare, activity, transition } = runtime;

  function toolInputReceipt(entry: InputEntry, sessionId: string, conversationId: string, startedAt: number): InputEntry {
    // A later exact call proves receipt of an earlier tool response, never of a queued task.
    const deliveredAt = offered.get(entry.id);
    return entry.sessionId === sessionId && entry.conversationId === conversationId && entry.state === 'tool' &&
      deliveredAt !== undefined && startedAt > deliveredAt
      ? { ...entry, state: 'sent', messageId: `input:${entry.id}`, deliveredAt, historyRecorded: false } : entry;
  }

  async function acknowledgeToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number): Promise<void> {
    return serial(async () => {
      if (!sessionId || !conversationId || !requestId || isChatBlocked(conversationId)) return;
      if ((await getSession(sessionId))?.conversationId !== conversationId) return;
      const current = await load();
      const next = current.map(entry => toolInputReceipt(entry, sessionId, conversationId, startedAt));
      if (!next.some((entry, index) => entry !== current[index])) return;
      // Persist receipt evidence before a handler decides whether user work remains.
      await commit(next);
      for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
      await publishHistory();
    });
  }

  async function offerToolInput(sessionId: string | null | undefined, conversationId: string | null | undefined, requestId: string | null | undefined, startedAt: number, finishBoundary = false): Promise<ToolInputBatch> {
    return serial(async () => {
      const batch: ToolInputBatch = { messages: [], reminder: '' };
      if (!sessionId || !conversationId || !requestId || isChatBlocked(conversationId)) return batch;
      const session = await getSession(sessionId);
      if (session?.conversationId !== conversationId) return batch;
      const finishSettings = getConfig().ui;
      finishBoundary = finishBoundary && finishSettings.finishTool === true && session.origin?.kind !== 'worker';
      const finishReminder = finishSettings.finishTool === true && !session.finishTurn?.released &&
        session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
        session.selectedModel?.conversationId === conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort)
        ? finishInstruction(finishSettings.finishLeadMinutes) : '';
      const current = await load();
      // A claimed browser send owns this session until its send outcome is known.
      if (current.some(entry => entry.sessionId === sessionId && entry.state === 'browser')) return batch;
      const head = ordered(current).find(row => row.sessionId === sessionId && queuedFollowup(row) &&
        ['queued', 'tool'].includes(row.state) && !terminal(toolInputReceipt(row, sessionId, conversationId, startedAt)));
      const delivered: string[] = [];
      let inputTaken = false;
      let payloadBytes = Buffer.byteLength(TOOL_INPUT_HEADER);
      let payloadImages = 0;
      let payloadFull = false;
      const observedActivity = activity(session);
      const activeToolTurn = session.activeTurnId ?? (observedActivity?.exact ? observedActivity.turnId : undefined);
      const prepareEntry = async (entry: InputEntry): Promise<InputEntry> => {
        if (entry.localExecutor || entry.sessionId !== sessionId || entry.dueAt > Date.now()) return entry;
        if (entry.attachments?.length && entry.attachmentDelivery !== 'tool' && entry.delivery !== 'tool') return entry;
        if (entry.delivery === 'tool' && entry.toolTurnId !== activeToolTurn) return entry;
        // A message for the running turn goes through the composer because the tool response did not show it.
        if (entry.directTurn && entry.state === 'queued') return entry;
        // Providers may reuse a request id for a whole turn, so receipt follows invocation start rather than grouping id.
        const received = toolInputReceipt(entry, sessionId, conversationId, startedAt);
        if (received !== entry) return received;
        if (payloadFull || (inputTaken && (entry.mode === 'finish' || entry.finishOwner)) || (entry.finishOwner && entry.createdAt >= startedAt)) return entry;
        if (entry.mode === 'finish' && !finishBoundary) return entry;
        if (entry.mode === 'finish' && entry !== head) return entry;
        // After-turn tasks own a future browser turn and cannot block an explicit Inject now message.
        if ((entry.state === 'queued' && (entry.mode === 'finish' || entry.mode === 'auto')) || entry.state === 'tool') {
          let prepared: InputEntry;
          try { prepared = await prepare({ ...entry, conversationId }); }
          catch (error) { return { ...entry, state: 'failed', error: (error as Error).message.slice(0, 200) }; }
          const message = prepared.deliveryText ?? prepared.text;
          const reminder = finishReminder || batch.reminder || (entry.mode === 'finish' ? 'Work on this user task now.' : '');
          const messageBytes = Buffer.byteLength(message) + (inputTaken ? 2 : 0);
          const reminderBytes = reminder ? Buffer.byteLength(reminder) + 2 : 0;
          const images = [...entry.images ?? [], ...entry.toolImages ?? []];
          if (payloadBytes + messageBytes + reminderBytes > TOOL_INPUT_TEXT_BYTES || payloadImages + images.length > MAX_INPUT_IMAGES) {
            payloadFull = true;
            return entry;
          }
          payloadBytes += messageBytes;
          payloadImages += images.length;
          inputTaken = true;
          batch.messages.push({ text: message, images });
          batch.reminder = reminder;
          delivered.push(entry.id);
          return { ...prepared, state: 'tool', toolTurnId: entry.toolTurnId ?? session.activeTurnId ?? activity(session)?.turnId,
            offeredAt: entry.offeredAt ?? Date.now(), owner: entry.state === 'tool' ? entry.owner : requestId, conversationId };
        }
        return entry;
      };
      const next: InputEntry[] = [];
      for (const entry of ordered(current).sort((a, b) => Number(a.mode === 'finish' || !!a.finishOwner) - Number(b.mode === 'finish' || !!b.finishOwner)))
        next.push(await prepareEntry(entry));
      if (next.some((entry, index) => entry !== current[index])) {
        const automated = next.filter(entry => entry.state === 'tool' && entry.automation && current.some(row => row.id === entry.id && row.state === 'queued'));
        await transition(current, next, automated, 'before-send');
      }
      for (const id of delivered) if (!offered.has(id)) offered.set(id, Date.now());
      for (const entry of next) if (terminal(entry)) offered.delete(entry.id);
      await publishHistory();
      return batch;
    });
  }

  return { acknowledgeToolInput, offerToolInput };
}
