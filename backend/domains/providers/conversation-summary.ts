import type { SessionEvent } from '../../../contracts/session.js';
import { parseWebChatTools, stripWebChatTools, type WebChatMessage } from '../../../contracts/chat-protocol.js';
import type { ApiMessage } from './api-chat-protocol.js';

type SummaryLine = { role: 'user' | 'assistant' | 'tool'; content: string; tool?: string };
type ProviderMessage = WebChatMessage | ApiMessage;

const MAX_SUMMARY_CHARS = 8_000;

function compact(text: string, limit: number): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= limit) return normalized;
  const marker = '\n[… earlier details omitted …]\n';
  const room = Math.max(0, limit - marker.length);
  const head = Math.ceil(room * 0.65);
  return `${normalized.slice(0, head)}${marker}${normalized.slice(-(room - head))}`;
}

function visibleContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => {
    if (!part || typeof part !== 'object') return [];
    const row = part as { type?: unknown; text?: unknown };
    return row.type === 'text' && typeof row.text === 'string' ? [row.text] : [];
  }).join('\n');
}

function isApplicationControl(text: string): boolean {
  const normalized = text.trim();
  return normalized === 'NEURAFLOK_READY' || normalized === 'NEURAL_JAM_READY' ||
    normalized.includes('Initialize this NEURAFLOK conversation using the instructions below.') ||
    normalized.startsWith('NEURAFLOK_CONTEXT_CHECK') ||
    normalized.startsWith('COMPLETION REVIEW:') ||
    normalized.startsWith('INCOMPLETE_TOOL:');
}

function renderSummary(lines: SummaryLine[], includeTools = true): string {
  const meaningful = lines.filter(line => (includeTools || line.role !== 'tool') && line.content.trim() && !isApplicationControl(line.content));
  if (!meaningful.length) return '';

  // Keep the opening human goal alongside the newest exchanges, which is useful
  // when a long project session has many short follow-up questions.
  const firstUser = meaningful.find(line => line.role === 'user');
  const recent = meaningful.slice(-12);
  const selected = firstUser && !recent.includes(firstUser) ? [firstUser, ...recent] : recent;
  let rendered = selected.map((line, index) => {
    const label = line.role === 'user' ? (index === 0 && line === firstUser ? 'Original request' : 'User')
      : line.role === 'assistant' ? 'Assistant' : `Tool${line.tool ? ` ${line.tool}` : ''}`;
    return `${label}: ${compact(line.content, line.role === 'tool' ? 700 : 1_200)}`;
  });
  while (rendered.length > 1 && rendered.join('\n\n').length > MAX_SUMMARY_CHARS) {
    // Retain the original goal at the front while dropping the oldest middle
    // exchange. The newest request and answer always stay in the summary.
    rendered.splice(rendered.length > 2 ? 1 : 0, 1);
  }
  const result = rendered.join('\n\n');
  return result ? `RECENT CONVERSATION SUMMARY (historical context; follow the current request):\n${result}` : '';
}

/** Compact recent local provider history without copying image payloads or bootstrap checks. */
export function summarizeProviderConversation(messages: readonly ProviderMessage[], options: { includeTools?: boolean } = {}): string {
  const includeTools = options.includeTools !== false;
  const lines: SummaryLine[] = [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant') {
      const calls = message.tool_calls ?? (typeof message.content === 'string' ? parseWebChatTools(message.content) : []);
      for (const call of calls) toolNames.set(call.id, call.function.name);
      const content = typeof message.content === 'string' && calls.length
        ? stripWebChatTools(message.content).trim()
        : visibleContent(message.content);
      if (content && !isApplicationControl(content)) lines.push({ role: 'assistant', content });
      else if (calls.length && includeTools) lines.push({ role: 'assistant', content: `Used tools: ${calls.map(call => call.function.name).join(', ')}.` });
      continue;
    }
    const content = visibleContent(message.content);
    if (message.role === 'user') {
      if (!isApplicationControl(content)) lines.push({ role: 'user', content });
    } else if (includeTools && message.role === 'tool' && content) {
      lines.push({ role: 'tool', tool: toolNames.get(message.tool_call_id ?? ''), content });
    }
  }
  return renderSummary(lines, includeTools);
}

/** Fallback for older chats whose provider-local transcript file is unavailable. */
export function summarizeSessionHistory(events: readonly SessionEvent[], options: { includeTools?: boolean } = {}): string {
  const includeTools = options.includeTools !== false;
  const lines: SummaryLine[] = [];
  for (const event of events) {
    if (event.kind === 'user_message') {
      const content = event.authoredText?.trim() || event.message.text;
      if (content && !isApplicationControl(content)) lines.push({ role: 'user', content });
    } else if (event.kind === 'assistant_message' && event.final) {
      const content = event.message.text;
      if (content && !isApplicationControl(content)) lines.push({ role: 'assistant', content });
    } else if (includeTools && event.kind === 'tool_call') {
      const label = event.call.summary.title || event.call.tool;
      lines.push({ role: 'tool', tool: event.call.tool, content: label });
    }
  }
  return renderSummary(lines, includeTools);
}

/** Reconstructs the readable part of an older local chat when its provider thread file is absent. */
export function sessionHistoryMessages(events: readonly SessionEvent[], options: { includeTools?: boolean } = {}): Array<{ role: 'user' | 'assistant'; content: string }> {
  const includeTools = options.includeTools !== false;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const event of events) {
    if (event.kind === 'user_message') {
      const content = event.authoredText?.trim() || event.message.text;
      if (content && !isApplicationControl(content)) messages.push({ role: 'user', content });
    } else if (event.kind === 'assistant_message' && event.final) {
      const content = event.message.text;
      if (content && !isApplicationControl(content)) messages.push({ role: 'assistant', content });
    } else if (includeTools && event.kind === 'tool_call') {
      const label = event.call.summary.title || event.call.tool;
      if (label) messages.push({ role: 'assistant', content: `[Recorded project action: ${label}]` });
    }
  }
  return messages;
}

/** Remove historic local actions from projectless provider chats while preserving their human-readable conversation. */
export function textOnlyWebMessages(messages: readonly WebChatMessage[]): WebChatMessage[] {
  const output: WebChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue;
    if (message.role === 'user') { output.push({ role: 'user', content: message.content ?? '' }); continue; }
    const content = typeof message.content === 'string' ? stripWebChatTools(message.content).trim() : '';
    if (content) output.push({ role: 'assistant', content });
  }
  return output;
}

/** API images remain attached to user messages; historical tool traffic is never carried into a plain chat. */
export function textOnlyApiMessages(messages: readonly ApiMessage[]): ApiMessage[] {
  const output: ApiMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'tool') continue;
    if (message.role === 'user') { output.push({ role: 'user', content: message.content ?? '' }); continue; }
    const content = typeof message.content === 'string' ? stripWebChatTools(message.content).trim() : visibleContent(message.content);
    if (content) output.push({ role: 'assistant', content });
  }
  return output;
}
