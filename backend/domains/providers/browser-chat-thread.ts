// Owns bounded durable history for browser-backed provider conversations.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { WebChatMessage, WebChatThread } from '../../../contracts/chat-protocol.js';
import type { WebProviderId } from '../../../contracts/web-providers.js';
import { LEGACY_WEB_BOOTSTRAP_ACK, WEB_BOOTSTRAP_ACK } from '../sessions/input/provider-context.js';
import { sessionWebProviderThreadPath, withSessionMutationFence } from '../sessions/history/store.js';

const MAX_THREAD_MESSAGES = 120;
const MAX_THREAD_CHARS = 120_000;
const MAX_THREAD_BYTES = 1_048_576;

function messageChars(message: WebChatMessage): number {
  return (message.content?.length ?? 0)
    + (message.reasoning_content?.length ?? 0)
    + (message.tool_call_id?.length ?? 0)
    + (message.tool_calls?.reduce((sum, call) => sum + call.function.name.length + call.function.arguments.length, 0) ?? 0);
}

export function trimWebProviderThread(messages: WebChatMessage[]): WebChatMessage[] {
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  let rest = system ? messages.slice(1) : [...messages];
  while (rest.length + (system ? 1 : 0) > MAX_THREAD_MESSAGES) rest = rest.slice(1);
  const budget = () => (system ? messageChars(system) : 0) + rest.reduce((sum, row) => sum + messageChars(row), 0);
  while (rest.length > 2 && budget() > MAX_THREAD_CHARS) rest = rest.slice(1);
  return system ? [system, ...rest] : rest;
}

export function withWebProviderSystem(messages: WebChatMessage[], system: string): WebChatMessage[] {
  const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  return trimWebProviderThread([{ role: 'system', content: system }, ...rest]);
}

/** Rebuild the recent conversation in a new provider page when its remote chat history is unavailable. */
export function replayWebProviderTranscript(messages: WebChatMessage[], currentPrompt: string, maxChars = 96_000): string | null {
  const header = 'The original provider page for this same NEURAFLOK chat is unavailable. Continue from this saved transcript and answer the current request. Do not redo completed work unless the current request asks for it.';
  const current = `CURRENT REQUEST:\n${currentPrompt}`;
  const budget = maxChars - header.length - current.length - 8;
  if (budget < 160) return null;

  const setupMessage = messages.findIndex(row => row.role === 'user' &&
    String(row.content || '').includes('Initialize this NEURAFLOK conversation using the instructions below.'));
  const setupAck = messages.findIndex((row, index) => {
    const content = String(row.content || '').trim();
    return row.role === 'assistant' && (setupMessage < 0 || index > setupMessage) &&
      (content === WEB_BOOTSTRAP_ACK || content === LEGACY_WEB_BOOTSTRAP_ACK);
  });
  const historyStart = setupAck >= 0 ? setupAck + 1 : setupMessage >= 0 ? setupMessage + 1 : 0;
  const history = messages.slice(historyStart)
    .filter(row => row.role !== 'system')
    .map(row => {
      const role = row.role === 'tool' ? 'TOOL RESULT' : row.role.toUpperCase();
      const content = typeof row.content === 'string' ? row.content : '';
      const calls = row.tool_calls?.length ? `\nTOOL CALLS:\n${JSON.stringify(row.tool_calls)}` : '';
      const body = `${content}${calls}`.trim();
      return body ? `${role}:\n${body}` : '';
    })
    .filter(Boolean);

  let used = 0;
  const selected: string[] = [];
  for (const row of history.reverse()) {
    const separator = selected.length ? 2 : 0;
    const room = budget - used - separator;
    if (room < 160) break;
    if (row.length <= room) {
      selected.push(row);
      used += row.length + separator;
    } else if (!selected.length) {
      const splitAt = row.indexOf('\n');
      const label = splitAt >= 0 ? row.slice(0, splitAt) : 'PREVIOUS MESSAGE';
      const marker = '\n[Earlier content omitted]\n';
      const contentRoom = Math.max(0, room - label.length - marker.length - 1);
      const content = row.slice(splitAt + 1);
      const beginning = Math.ceil(contentRoom / 2);
      const ending = Math.floor(contentRoom / 2);
      selected.push(`${label}\n${content.slice(0, beginning)}${marker}${ending ? content.slice(-ending) : ''}`);
      used = room;
    }
  }
  if (!selected.length) return null;
  return `${header}\n\n${selected.reverse().join('\n\n')}\n\n${current}`;
}

function parseThread(raw: unknown, sessionId: string, conversationId: string): WebChatThread | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as WebChatThread;
  if (value.version !== 1 || value.sessionId !== sessionId) return null;
  if (typeof value.conversationId !== 'string' || value.conversationId !== conversationId) return null;
  if (!Array.isArray(value.messages)) return null;
  return {
    version: 1,
    sessionId,
    conversationId,
    messages: value.messages,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now()
  };
}

export async function readWebProviderThread(
  sessionId: string,
  conversationId: string,
  provider: WebProviderId
): Promise<WebChatThread | null> {
  try {
    const bytes = await fs.readFile(sessionWebProviderThreadPath(sessionId, provider), 'utf8');
    if (Buffer.byteLength(bytes) > MAX_THREAD_BYTES) return null;
    return parseThread(JSON.parse(bytes), sessionId, conversationId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function persistWebProviderThread(thread: WebChatThread, provider: WebProviderId): Promise<void> {
  const trimmed: WebChatThread = { ...thread, messages: trimWebProviderThread(thread.messages), updatedAt: Date.now() };
  const bytes = JSON.stringify(trimmed);
  if (Buffer.byteLength(bytes) > MAX_THREAD_BYTES) throw new Error('Provider conversation exceeds its storage budget');
  const target = sessionWebProviderThreadPath(trimmed.sessionId, provider);
  await withSessionMutationFence(trimmed.sessionId, async () => {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, 'utf8');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}
