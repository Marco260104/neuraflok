import { randomUUID } from 'node:crypto';
import { MAX_PROVIDER_MESSAGE_CHARS } from '../../../../contracts/messaging/provider-message-envelope.js';
import type { WebProviderId } from '../../../../contracts/web-providers.js';
import { conversationWasSuperseded, findSessionByConversation, readRecentEvents } from '../history/store.js';
import { isChatBlocked } from '../continuity/blocked-chats.js';
import { entrySchema, type InputEntry } from './input-schema.js';

export type BrowserDecisionOptions = {
  lifetime?: 'temporary-planner';
  sourceSessionId?: string;
  conversationId?: string | null;
  provider?: WebProviderId;
  providerConversationId?: string;
  publish?: (text: string) => void;
};

type BrowserDecisionRuntime = {
  load(): Promise<InputEntry[]>;
  listInputs(): Promise<InputEntry[]>;
  serial<T>(work: () => Promise<T>): Promise<T>;
  commit(next: InputEntry[]): Promise<void>;
  append(current: InputEntry[], entry: InputEntry): InputEntry[];
  wakeDecision(entry: Readonly<InputEntry>, signal: AbortSignal): Promise<void>;
};

type DecisionWaiter = {
  resolve(text: string): void;
  reject(reason: unknown): void;
  publish?: (text: string) => void;
};

export function createBrowserDecisionService(runtime: BrowserDecisionRuntime) {
  const waiters = new Map<string, DecisionWaiter>();
  const terminal = (row: InputEntry): boolean => ['sent', 'cancelled', 'failed'].includes(row.state);

  function rejectWaiter(id: string, reason: unknown): void {
    waiters.get(id)?.reject(reason);
    waiters.delete(id);
  }

  async function publishBrowserDecision(id: string, owner: string, conversationId: string | null, text: string): Promise<boolean> {
    if (text.length > 8000) return false;
    const entry = (await runtime.load()).find(row => row.id === id && row.owner === owner && row.purpose === 'decision' &&
      row.conversationId === conversationId && ['browser', 'decision'].includes(row.state));
    const waiter = waiters.get(id);
    if (!entry || !waiter) return false;
    waiter.publish?.(text);
    return true;
  }

  async function requestBrowserDecision(text: string, signal: AbortSignal, options: BrowserDecisionOptions = {}): Promise<string> {
    if (!text.trim() || text.length > MAX_PROVIDER_MESSAGE_CHARS) throw new Error('goal_context_too_large');
    signal.throwIfAborted();
    const id = randomUUID();
    let resolveAnswer!: (text: string) => void;
    let rejectAnswer!: (reason: unknown) => void;
    const answer = new Promise<string>((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
    void answer.catch(() => undefined);
    waiters.set(id, { resolve: resolveAnswer, reject: rejectAnswer, publish: options.publish });
    const cancel = () => rejectWaiter(id, new Error('goal_browser_cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const queued = await runtime.serial(async () => {
        signal.throwIfAborted();
        const current = await runtime.load();
        if (current.filter(row => row.purpose === 'decision' && ['queued', 'browser', 'decision'].includes(row.state)).length >= 4)
          throw new Error('goal_browser_busy');
        if (options.sourceSessionId && current.some(row => row.decisionSourceSessionId === options.sourceSessionId && !terminal(row)))
          throw new Error('goal_browser_busy');
        const ambiguousUserCancellation = options.sourceSessionId && !options.conversationId && current.some(row =>
          row.decisionSourceSessionId === options.sourceSessionId && row.state === 'cancelled' && row.cancelledByUser === true &&
          !row.conversationId && row.deliveredAt === undefined);
        if (ambiguousUserCancellation) throw new Error('goal_browser_send_unconfirmed');
        const entry = entrySchema.parse({
          id,
          sessionId: null,
          text,
          mode: 'after-turn',
          dueAt: Date.now(),
          model: null,
          reasoningEffort: null,
          decisionProvider: options.provider,
          decisionConversationId: options.providerConversationId,
          decisionSourceSessionId: options.sourceSessionId,
          lifetime: options.lifetime,
          purpose: 'decision',
          state: 'queued',
          owner: null,
          createdAt: Date.now(),
          conversationId: options.conversationId ?? null
        });
        await runtime.commit(runtime.append(current, entry));
        return entry;
      });
      signal.throwIfAborted();
      await runtime.wakeDecision(queued, signal);
      signal.throwIfAborted();
      return await answer;
    } finally {
      waiters.delete(id);
      signal.removeEventListener('abort', cancel);
      void answer.catch(() => undefined);
      await runtime.serial(async () => {
        const current = await runtime.load();
        if (current.some(row => row.id === id && !terminal(row)))
          await runtime.commit(current.map(row => row.id === id && !terminal(row) ? { ...row, state: 'cancelled' } : row));
      });
    }
  }

  function completeBrowserDecision(id: string, owner: string, response: string, conversationId?: string | null): Promise<boolean> {
    return runtime.serial(async () => {
      if (!response.trim() || response.length > 16000) return false;
      const current = await runtime.load();
      if (current.some(entry => entry.id === id && entry.owner === owner && entry.purpose === 'decision' &&
          entry.state === 'sent' && entry.response === response)) return true;
      if (!waiters.has(id)) return false;
      const row = current.find(entry => entry.id === id && entry.owner === owner && entry.purpose === 'decision' &&
        ['browser', 'decision'].includes(entry.state));
      if (!row || (conversationId && row.conversationId && conversationId !== row.conversationId)) return false;
      await runtime.commit(current.map(entry => entry === row
        ? { ...entry, conversationId: conversationId ?? row.conversationId, state: 'sent', response }
        : entry));
      const waiter = waiters.get(id);
      if (!waiter) await runtime.commit((await runtime.load()).map(entry =>
        entry.id === id ? { ...entry, state: 'cancelled', response: undefined } : entry));
      waiter?.resolve(response);
      return !!waiter;
    });
  }

  async function collectRecordedBrowserDecision(conversationId: string): Promise<void> {
    const pending = (await runtime.listInputs()).filter(row => row.purpose === 'decision' && row.state === 'decision' &&
      row.conversationId === conversationId && row.messageId && row.owner && waiters.has(row.id));
    if (pending.length !== 1 || isChatBlocked(conversationId) || await conversationWasSuperseded(conversationId)) return;
    const row = pending[0]!;
    const session = await findSessionByConversation(conversationId, { requireUnique: true });
    if (!session || (row.deliveredSessionId && session.id !== row.deliveredSessionId)) return;
    const events = await readRecentEvents(session.id, 32, { kinds: ['user_message', 'assistant_message'], maxBytes: 1_048_576 });
    const user = events.findLastIndex(event => event.kind === 'user_message');
    const prompt = events[user];
    const final = events.at(-1);
    if (user < 0 || prompt?.kind !== 'user_message' || prompt.messageId !== row.messageId ||
        final?.kind !== 'assistant_message' || !final.final || final.state !== 'final' || !final.messageId ||
        final.message.truncated || final.message.text.length > 16000) return;
    await completeBrowserDecision(row.id, row.owner!, final.message.text, conversationId);
  }

  return {
    hasWaiter: (id: string) => waiters.has(id),
    rejectWaiter,
    reset: () => waiters.clear(),
    publishBrowserDecision,
    requestBrowserDecision,
    completeBrowserDecision,
    collectRecordedBrowserDecision
  };
}
