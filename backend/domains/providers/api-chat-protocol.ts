/** OpenAI-compatible HTTP protocol and message validation for API chats. */
import { openaiTools, type WebChatToolCall } from '../../../contracts/chat-protocol.js';
import type { ApiProviderEndpoint } from './api-settings.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_CHARS = 4_000;

export interface ApiChatSettings {
  endpoint: ApiProviderEndpoint;
  baseUrl: string;
  model: string;
  key: string | null;
}

export type ApiToolCall = WebChatToolCall;
export type ApiTextPart = { type: 'text'; text: string };
export type ApiImagePart = { type: 'image_url'; image_url: { url: string } };
export type ApiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | Array<ApiTextPart | ApiImagePart>;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
};

function parseToolCall(value: unknown): ApiToolCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const call = value as Partial<ApiToolCall>;
  if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 256 ||
      !call.function || typeof call.function !== 'object' || typeof call.function.name !== 'string' ||
      !call.function.name || call.function.name.length > 120 || typeof call.function.arguments !== 'string' ||
      call.function.arguments.length > 80_000) return null;
  return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
}

async function readResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error('API response exceeded the local size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function providerError(raw: string, key: string | null): string {
  const parsed = (() => {
    try { return JSON.parse(raw) as { error?: { message?: unknown } | string }; }
    catch { return null; }
  })();
  const error = parsed?.error;
  const message = typeof error === 'string' ? error : error && typeof error === 'object' && typeof error.message === 'string' ? error.message : raw;
  const cleaned = message.replace(/\s+/g, ' ').replace(key ?? '\u0000', '[stored credential]');
  return key ? cleaned.split(key).join('[stored credential]').slice(0, MAX_ERROR_CHARS) : cleaned.slice(0, MAX_ERROR_CHARS);
}

/** Send a completion request and validate its assistant message and tool calls. */
export async function completeApiChat(
  messages: ApiMessage[], tools: ReturnType<typeof openaiTools>, settings: ApiChatSettings, signal: AbortSignal
): Promise<{ message: ApiMessage; finishReason: string | null }> {
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', ...(settings.key ? { authorization: `Bearer ${settings.key}` } : {}) },
    body: JSON.stringify({ model: settings.model, messages, ...(tools.length ? { tools } : {}) })
  });
  const raw = await readResponse(response, response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_CHARS * 4);
  if (!response.ok) throw new Error(`API request failed (HTTP ${response.status}): ${providerError(raw, settings.key)}`);
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new Error('The API returned a response that was not valid JSON.'); }
  if (!payload || typeof payload !== 'object') throw new Error('The API returned an empty completion.');
  const choices = (payload as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] as { message?: unknown; finish_reason?: unknown } | undefined : undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (!message || !['assistant'].includes(String(message.role))) throw new Error('The API response did not include an assistant message.');
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') throw new Error('The API returned an unsupported assistant message format.');
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new Error('The API returned malformed tool calls.');
  const rawCalls = (message.tool_calls ?? []) as unknown[];
  if (rawCalls.length > 16) throw new Error('The API requested too many local tools in one turn.');
  const calls = rawCalls.map(parseToolCall);
  if (calls.some(call => call === null)) throw new Error('The API returned a malformed tool call.');
  const validCalls = calls as ApiToolCall[];
  if (new Set(validCalls.map(call => call.id)).size !== validCalls.length) throw new Error('The API returned duplicate tool call ids.');
  return {
    message: { role: 'assistant', ...(typeof message.content === 'string' ? { content: message.content } : {}), ...(validCalls.length ? { tool_calls: validCalls } : {}) },
    finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : null
  };
}

export { parseToolCall };
