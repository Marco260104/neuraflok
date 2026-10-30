/** OpenAI-compatible HTTP protocol and message validation for API chats. */
import { openaiTools, type WebChatToolCall } from '../../../contracts/chat-protocol.js';
import type { ApiProviderEndpoint } from './api-settings.js';
import { apiRequestHeaders, apiRequestUrl } from './api-settings.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_CHARS = 4_000;

export interface ApiChatSettings {
  endpoint: ApiProviderEndpoint;
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

type AnthropicContentBlock = Record<string, unknown>;

function anthropicImage(dataUrl: string): AnthropicContentBlock {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('This API format requires images as base64 JPEG, PNG, GIF, or WebP data URLs.');
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

function anthropicMessages(messages: ApiMessage[]): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }> } {
  const system = messages.filter(message => message.role === 'system')
    .map(message => typeof message.content === 'string' ? message.content : '')
    .filter(Boolean).join('\n\n');
  const result: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }> = [];
  const append = (role: 'user' | 'assistant', content: AnthropicContentBlock[]) => {
    if (!content.length) return;
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      append('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: typeof message.content === 'string' ? message.content : '' }]);
      continue;
    }
    const role = message.role;
    const blocks: AnthropicContentBlock[] = [];
    if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content });
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
        else blocks.push(anthropicImage(part.image_url.url));
      }
    }
    for (const call of message.tool_calls ?? []) {
      let input: unknown;
      try { input = JSON.parse(call.function.arguments); }
      catch { throw new Error('A saved assistant tool call could not be read by the Anthropic-compatible API.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A saved assistant tool call has invalid input.');
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
    }
    append(role, blocks);
  }
  return { system, messages: result };
}

async function completeAnthropicApiChat(
  messages: ApiMessage[], tools: ReturnType<typeof openaiTools>, settings: ApiChatSettings, signal: AbortSignal, url: string,
  headers: Record<string, string>
): Promise<{ message: ApiMessage; finishReason: string | null }> {
  const conversation = anthropicMessages(messages);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal,
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 8192,
      ...(conversation.system ? { system: conversation.system } : {}),
      messages: conversation.messages,
      ...(tools.length ? { tools: tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
      })) } : {})
    })
  });
  const raw = await readResponse(response, response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_CHARS * 4);
  if (!response.ok) throw new Error(`API request failed (HTTP ${response.status}): ${providerError(raw, settings.key)}`);
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { throw new Error('The API returned a response that was not valid JSON.'); }
  if (!payload || typeof payload !== 'object') throw new Error('The API returned an empty completion.');
  const record = payload as { role?: unknown; content?: unknown; stop_reason?: unknown };
  if (record.role !== 'assistant' || !Array.isArray(record.content)) throw new Error('The API response did not include an assistant message.');
  const text: string[] = [];
  const calls: ApiToolCall[] = [];
  for (const block of record.content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') text.push(item.text);
    if (item.type === 'tool_use') {
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || !item.input || typeof item.input !== 'object' || Array.isArray(item.input)) {
        throw new Error('The API returned a malformed tool call.');
      }
      calls.push({ id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.input) } });
    }
  }
  if (calls.length > 16 || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('The API returned too many or duplicate tool calls.');
  return {
    message: { role: 'assistant', ...(text.length ? { content: text.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) },
    finishReason: typeof record.stop_reason === 'string' ? record.stop_reason : null
  };
}

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
  const url = apiRequestUrl(settings.endpoint, 'chat');
  if (!url) throw new Error('The configured API has no chat endpoint.');
  const headers = await apiRequestHeaders(settings.endpoint, settings.key);
  if (settings.endpoint.kind === 'custom' && settings.endpoint.protocol === 'anthropic-messages') {
    return completeAnthropicApiChat(messages, tools, settings, signal, url, headers);
  }
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal,
    headers,
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
