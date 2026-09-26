import type * as SessionHistory from '../history/store.js';
import type * as ToolCallContext from '../../../infrastructure/tool-gateway/protocol/call-context.js';
import type { InputEntry } from './input-schema.js';

type DeliveredRecorder = (entry: Readonly<InputEntry>, anchorCommitted: (seq: number) => void) => Promise<boolean>;

type Runtime = {
  serial: <T>(work: () => Promise<T>) => Promise<T>;
  load: () => Promise<InputEntry[]>;
  commit: (next: InputEntry[]) => Promise<void>;
  retireRemovedSessionReceipts: (current: InputEntry[], pendingOnly?: boolean) => Promise<InputEntry[]>;
  findSessionByConversation: typeof SessionHistory.findSessionByConversation;
  materializeStages: (current: InputEntry[], entry: InputEntry) => InputEntry[];
  ordered: (rows: InputEntry[]) => InputEntry[];
  needsHistory: (row: InputEntry) => boolean;
  companionOf: (rows: InputEntry[], row: InputEntry) => InputEntry | undefined;
  combinedInput: (root: InputEntry, companion?: InputEntry) => InputEntry;
  getSession: typeof SessionHistory.getSession;
  readRecentEvents: typeof SessionHistory.readRecentEvents;
  readCompletedFinal: typeof SessionHistory.readCompletedFinal;
  inFlightToolCalls: typeof ToolCallContext.inFlightToolCalls;
  deliveredRecorder: () => DeliveredRecorder | null;
};

export function createInputHistoryProjection(runtime: Runtime) {
  async function publishHistory(): Promise<void> {
    const current = await runtime.load();
    const recorded = new Set<string>();
    const anchored = new Map<string, number>();
    for (const row of current) {
      if (!runtime.needsHistory(row) || runtime.companionOf(current, row)) continue;
      const anchorCommitted = (seq: number) => {
        anchored.set(row.id, seq);
        if (row.companionInputId) anchored.set(row.companionInputId, seq);
      };
      const recordDelivered = runtime.deliveredRecorder();
      try { if (recordDelivered && await recordDelivered(runtime.combinedInput(row, current.find(other => other.id === row.companionInputId)), anchorCommitted)) {
        recorded.add(row.id);
        if (row.companionInputId) recorded.add(row.companionInputId);
      } }
      catch { /* delivered, retained, and still visible until canonical recording succeeds */ }
    }
    if (recorded.size || current.some(row => anchored.has(row.id) && (!row.historyAnchored || row.historySeq !== anchored.get(row.id)))) {
      try { await runtime.commit(current.map(row => recorded.has(row.id) || anchored.has(row.id)
        ? { ...row, ...(recorded.has(row.id) ? { historyRecorded: true } : {}), ...(anchored.has(row.id) ? { historyAnchored: true, historySeq: anchored.get(row.id) } : {}) } : row)); }
      catch { /* the durable delivery receipt remains; canonical retry is idempotent */ }
    }
  }

  async function listInputs(): Promise<InputEntry[]> {
    return runtime.serial(async () => {
      const current = await runtime.retireRemovedSessionReceipts(await runtime.load(), true);
      let next: InputEntry[] = [];
      for (const entry of current) {
        if (entry.purpose !== 'decision' && (entry.state === 'sent' || (entry.state === 'cancelled' && entry.deliveredAt !== undefined)) && !entry.sessionId && entry.conversationId && !entry.deliveredSessionId) {
          const session = await runtime.findSessionByConversation(entry.conversationId, { requireUnique: true });
          next.push(session ? { ...entry, deliveredSessionId: session.id } : entry);
        } else next.push(entry);
      }
      for (const entry of [...next]) {
        if (entry.state === 'sent') next = runtime.materializeStages(next, entry);
      }
      if (next.length !== current.length || next.some((entry, index) => entry !== current[index])) await runtime.commit(next);
      await publishHistory();
      return runtime.ordered(await runtime.load()).map(entry => ({ ...entry }));
    });
  }

  async function settleToolInputFromFinal(row: InputEntry): Promise<InputEntry> {
    if (!row.sessionId || !row.conversationId || !row.owner || row.offeredAt === undefined ||
        runtime.inFlightToolCalls(row.conversationId) > 0) return row;
    const session = await runtime.getSession(row.sessionId);
    if (session?.conversationId !== row.conversationId || session.lastAssistantFinalAt == null) return row;
    const calls = await runtime.readRecentEvents(row.sessionId, 256, { kinds: ['tool_call'] });
    const call = calls.find(event => event.kind === 'tool_call' && event.source === 'mcp' && event.turnId &&
      (!row.toolTurnId || event.turnId === row.toolTurnId) &&
      event.call.attribution === 'request_id' && event.call.requestId === row.owner &&
      event.call.conversationId === row.conversationId && event.time <= row.offeredAt!);
    if (!call?.turnId) return row;
    const final = await runtime.readCompletedFinal(row.sessionId, row.conversationId, call.turnId);
    if (!final || final.completedAt <= row.offeredAt || final.contentSeq <= call.seq ||
        runtime.inFlightToolCalls(row.conversationId) > 0) return row;
    return { ...row, state: 'sent', toolTurnId: call.turnId, messageId: `input:${row.id}`, deliveredAt: final.completedAt, historyRecorded: false };
  }

  return { listInputs, publishHistory, settleToolInputFromFinal };
}
