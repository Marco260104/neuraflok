/** Local persistence and context bounds for API conversation threads. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { parseToolCall, type ApiMessage, type ApiToolCall } from './api-chat-protocol.js';
import { sessionApiThreadPath, withSessionMutationFence } from '../sessions/history/store.js';

const MAX_THREAD_MESSAGES = 120;
const MAX_THREAD_CHARS = 120_000;
const MAX_THREAD_BYTES = 1_048_576;

export interface ApiThread {
  version: 1;
  sessionId: string;
  conversationId: string;
  messages: ApiMessage[];
  updatedAt: number;
}

function contentChars(content: ApiMessage['content']): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : part.image_url.url.length), 0);
}

function threadChars(messages: ApiMessage[]): number {
  return messages.reduce((sum, row) => sum + contentChars(row.content) + (row.tool_calls ?? []).reduce((n, call) => n + call.function.name.length + call.function.arguments.length, 0), 0);
}

/** Drop old complete user turns together so the API never receives an orphan tool result. */
export function trimApiThread(messages: ApiMessage[]): ApiMessage[] {
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  let rest = system ? messages.slice(1) : [...messages];
  while ((rest.length + (system ? 1 : 0) > MAX_THREAD_MESSAGES ||
    (system ? contentChars(system.content) : 0) + threadChars(rest) > MAX_THREAD_CHARS) && rest.length > 1) {
    const nextTurn = rest.findIndex((row, index) => index > 0 && row.role === 'user');
    if (nextTurn < 0) break;
    rest = rest.slice(nextTurn);
  }
  const result = system ? [system, ...rest] : rest;
  if (result.length > MAX_THREAD_MESSAGES || threadChars(result) > MAX_THREAD_CHARS) {
    throw new Error('This API conversation reached its local context limit. Start a new chat to continue.');
  }
  return result;
}

function parseMessage(value: unknown): ApiMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.role !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(row.role)) return null;
  if (row.content !== undefined && row.content !== null && (typeof row.content !== 'string' || row.content.length > MAX_THREAD_CHARS)) return null;
  if (row.role !== 'assistant' && row.tool_calls !== undefined) return null;
  if (row.role === 'tool' && (typeof row.tool_call_id !== 'string' || !row.tool_call_id || row.tool_call_id.length > 256)) return null;
  if (row.role !== 'tool' && row.tool_call_id !== undefined) return null;
  if (row.role !== 'assistant' && typeof row.content !== 'string') return null;
  if (row.tool_calls !== undefined) {
    if (!Array.isArray(row.tool_calls) || row.tool_calls.length > 16) return null;
    const calls = row.tool_calls.map(parseToolCall);
    if (calls.some(call => call === null)) return null;
    if (new Set((calls as ApiToolCall[]).map(call => call.id)).size !== calls.length) return null;
    return {
      role: 'assistant',
      ...(typeof row.content === 'string' ? { content: row.content } : row.content === null ? { content: null } : {}),
      tool_calls: calls as ApiToolCall[]
    };
  }
  if (row.role === 'assistant' && typeof row.content !== 'string' && row.content !== null) return null;
  return {
    role: row.role as ApiMessage['role'],
    ...(typeof row.content === 'string' ? { content: row.content } : row.content === null ? { content: null } : {}),
    ...(typeof row.tool_call_id === 'string' ? { tool_call_id: row.tool_call_id } : {})
  };
}

function parseThread(raw: unknown, sessionId: string, conversationId: string): ApiThread | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ApiThread>;
  if (value.version !== 1 || value.sessionId !== sessionId || value.conversationId !== conversationId || !Array.isArray(value.messages)) return null;
  const messages = value.messages.map(parseMessage);
  if (messages.some(row => row === null) || messages.length > MAX_THREAD_MESSAGES) return null;
  try {
    return {
      version: 1,
      sessionId,
      conversationId,
      messages: trimApiThread(messages as ApiMessage[]),
      updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now()
    };
  } catch { return null; }
}

export async function readApiThread(sessionId: string, conversationId: string): Promise<ApiThread | null> {
  try {
    const bytes = await fs.readFile(sessionApiThreadPath(sessionId), 'utf8');
    if (Buffer.byteLength(bytes) > MAX_THREAD_BYTES) return null;
    return parseThread(JSON.parse(bytes), sessionId, conversationId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function persistApiThread(thread: ApiThread): Promise<void> {
  thread.messages = trimApiThread(thread.messages);
  thread.updatedAt = Date.now();
  const bytes = JSON.stringify(thread);
  if (Buffer.byteLength(bytes) > MAX_THREAD_BYTES) throw new Error('API conversation exceeded its local storage limit.');
  const target = sessionApiThreadPath(thread.sessionId);
  await withSessionMutationFence(thread.sessionId, async () => {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, bytes, 'utf8'); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  });
}
