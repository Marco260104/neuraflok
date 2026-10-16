import type { AgentMessage, StoredText } from '../../../../contracts/session.js';

type Runtime = Pick<typeof import('./store.js'), 'appendEvent' | 'readEvents' | 'findSessionByConversation'> & {
  recordingEnabled(): boolean;
  storeText(sessionId: string, text: string, cap: number): Promise<StoredText>;
  notifyChanged(sessionId: string): void;
  agentConversation(agent: string): string | null;
  sessionForConversation(conversationId: string, title?: string): Promise<string | null>;
  ensureUnattributedSession(): Promise<string | null>;
  logWarn(message: string): void;
  maxMessageChars: number;
};

const APP_EVENT_TEXT_LIMIT = 4000;

export function createRecorderAppEvents(runtime: Runtime) {
  async function recordNote(sessionId: string, text: string, continuation?: string): Promise<void> {
    if (!runtime.recordingEnabled()) return;
    await runtime.appendEvent(sessionId, {
      time: Date.now(),
      source: 'app',
      kind: 'note',
      message: await runtime.storeText(sessionId, text, APP_EVENT_TEXT_LIMIT),
      ...(continuation ? { continuation } : {})
    }).catch(() => undefined);
    runtime.notifyChanged(sessionId);
  }

  async function recordProgress(
    sessionId: string,
    progressId: string,
    text: string,
    anchor?: { seq: number; time: number },
    turnId?: string | null,
    finishControl?: { state: 'released' | 'notified' | 'decision'; conversationId: string; revision?: string; inputRevision?: string; workSeq?: number }
  ): Promise<{ seq: number; time: number } | null> {
    if (!runtime.recordingEnabled() || !progressId) return null;
    // Reuse the first durable row as the chronology anchor when later snapshots replace its text.
    const time = anchor?.time ?? Date.now();
    const event = await runtime.appendEvent(sessionId, {
      time,
      source: 'app',
      kind: 'progress',
      progressId,
      ...(finishControl ? { finishControl } : {}),
      ...(anchor ? { origin: anchor.seq } : {}),
      ...(turnId ? { turnId } : {}),
      message: await runtime.storeText(sessionId, text, APP_EVENT_TEXT_LIMIT)
    }).catch(() => null);
    if (!event) return null;
    runtime.notifyChanged(sessionId);
    return anchor ?? { seq: event.seq, time };
  }

  async function recordAgentMessage(
    message: AgentMessage,
    delivery: 'sent' | 'delivered',
    ownerConversationId: string | null = null
  ): Promise<void> {
    if (!runtime.recordingEnabled()) return;
    const owner = delivery === 'sent' ? message.from : message.to;
    try {
      // Resolve by the exact conversation when supplied because agent names can recur across dormant runs.
      const conversationId = ownerConversationId ?? runtime.agentConversation(owner);
      // Recording a broker report does not prove that a closed provider page has returned.
      const sessionId = conversationId
        ? (await runtime.findSessionByConversation(conversationId, { includeHistorical: true }))?.id ?? await runtime.sessionForConversation(conversationId)
        : await runtime.ensureUnattributedSession();
      if (!sessionId) return;
      await runtime.appendEvent(sessionId, {
        time: delivery === 'sent' ? message.time : Date.now(),
        source: 'app',
        kind: 'agent_message',
        agent: owner,
        messageId: message.id,
        from: message.from,
        to: message.to,
        ...(message.fromRunId ? { fromRunId: message.fromRunId } : {}),
        message: await runtime.storeText(sessionId, message.text, runtime.maxMessageChars),
        delivery
      });
      runtime.notifyChanged(sessionId);
    } catch (error) {
      runtime.logWarn(`session recorder could not store an agent message: ${(error as Error).message}`);
    }
  }

  async function recordHandoff(sessionId: string, handoffId: string, chars: number, reason: string): Promise<void> {
    await runtime.appendEvent(sessionId, {
      time: Date.now(),
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars,
      reason
    });
    runtime.notifyChanged(sessionId);
  }

  async function ensureHandoffRecorded(sessionId: string, handoffId: string, chars: number, reason: string): Promise<boolean> {
    // Repair the WAL-to-timeline crash window without duplicating a published handoff.
    const existing = await runtime.readEvents(sessionId, { kinds: ['handoff'] });
    if (existing.some((event) => event.kind === 'handoff' && event.handoffId === handoffId)) return false;
    await recordHandoff(sessionId, handoffId, chars, reason);
    return true;
  }

  return { recordNote, recordProgress, recordAgentMessage, recordHandoff, ensureHandoffRecorded };
}
