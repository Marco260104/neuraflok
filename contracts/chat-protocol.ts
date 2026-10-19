// Shared chat execution types and the bounded local-tool wire format.
import { replyLanguageInstruction } from './ui-language.js';

export const CHAT_EXECUTORS = ['web', 'api'] as const;
export type ChatExecutor = (typeof CHAT_EXECUTORS)[number];

/** Core tools supported by the browser-session executor. */
export const WEB_CHAT_CORE_TOOLS = [
  'read',
  'find',
  'apply_patch',
  'exec_command',
  'write_stdin',
  'update_plan'
] as const;
export type WebChatCoreTool = (typeof WEB_CHAT_CORE_TOOLS)[number];

export function isChatExecutor(value: unknown): value is ChatExecutor {
  return value === 'web' || value === 'api';
}

/** The selected web executor owns model choice and reasoning inside its provider page. */
export function usesBrowserProvider(executor: ChatExecutor | undefined | null): boolean {
  return executor === 'web';
}

export function usesApiProvider(executor: ChatExecutor | undefined | null): boolean {
  return executor === 'api';
}

export function apiConversationId(uuid: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error('Invalid API conversation UUID');
  }
  return `ap-${uuid}`;
}

export function isApiConversationId(value: string): boolean {
  return /^ap-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface WebChatToolDeclaration {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** OpenAI function parameters from a Zod JSON Schema: drop `$schema`, keep an object root. */
export function openaiToolParameters(schema: object): Record<string, unknown> {
  const rest = { ...(schema as Record<string, unknown>) };
  delete rest.$schema;
  if (rest.type !== 'object') return { type: 'object', properties: rest.properties ?? {}, required: rest.required };
  return rest;
}

export function openaiTools(declarations: Array<{ name: string; description: string; inputSchema: object }>): WebChatToolDeclaration[] {
  return declarations.map((entry) => ({
    type: 'function',
    function: {
      name: entry.name,
      description: entry.description,
      parameters: openaiToolParameters(entry.inputSchema)
    }
  }));
}

export interface WebChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WebChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: WebChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface WebChatThread {
  version: 1;
  sessionId: string;
  conversationId: string;
  messages: WebChatMessage[];
  updatedAt: number;
}

export interface WebChatCompletionChoice {
  finish_reason?: string | null;
  message?: WebChatMessage;
}

export interface WebChatCompletion {
  choices?: WebChatCompletionChoice[];
  error?: { message?: string };
}

const MAX_TOOL_JSON = 80_000;

function readJsonObject(source: string, from: number): { json: string; end: number } | null {
  const start = source.indexOf('{', from);
  if (start < 0 || start - from > 48) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  const last = Math.min(source.length, start + MAX_TOOL_JSON);
  for (let i = start; i < last; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: source.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function overlaps(ranges: Array<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

function acceptToolJson(
  raw: string,
  calls: WebChatToolCall[],
  seen: Set<string>
): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const row = parsed as { name?: unknown; arguments?: unknown; id?: unknown };
  if (typeof row.name !== 'string' || !row.name.trim()) return false;
  const name = row.name.trim();
  const args = row.arguments === undefined ? {} : row.arguments;
  const argsText = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `call_${calls.length + 1}`;
  const key = `${name}\0${argsText}`;
  if (seen.has(id) || seen.has(key)) return false;
  seen.add(id);
  seen.add(key);
  calls.push({
    id,
    type: 'function',
    function: { name, arguments: argsText }
  });
  return true;
}

function taggedToolBlocks(source: string, tag: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  const open = new RegExp('```' + tag + '[^\\n]*\\r?\\n', 'gi');
  let match: RegExpExecArray | null;
  while ((match = open.exec(source))) {
    const obj = readJsonObject(source, match.index + match[0].length);
    if (!obj) continue;
    let end = obj.end;
    const close = source.slice(end).match(/^[ \t]*\r?\n?```/);
    if (close) end += close[0].length;
    out.push({ start: match.index, end, body: obj.json });
    open.lastIndex = end;
  }
  return out;
}

function consumeToolRegions(text: string): { calls: WebChatToolCall[]; remainder: string } {
  const source = text ?? '';
  const calls: WebChatToolCall[] = [];
  const seen = new Set<string>();
  const consumed: Array<[number, number]> = [];
  const take = (start: number, end: number, body: string) => {
    if (overlaps(consumed, start, end)) return;
    if (!acceptToolJson(body, calls, seen)) return;
    consumed.push([start, end]);
  };
  for (const block of taggedToolBlocks(source, 'neuraflok-tool')) take(block.start, block.end, block.body);
  for (const block of taggedToolBlocks(source, 'json')) take(block.start, block.end, block.body);
  const banner = /(?:^|\n)neuraflok-tool[ \t]*\r?\n/gi;
  let match: RegExpExecArray | null;
  while ((match = banner.exec(source))) {
    const obj = readJsonObject(source, match.index + match[0].length);
    if (!obj) continue;
    take(match.index === 0 ? 0 : match.index + 1, obj.end, obj.json);
    banner.lastIndex = obj.end;
  }
  consumed.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of consumed) {
    if (start < cursor) continue;
    parts.push(source.slice(cursor, start));
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return { calls, remainder: parts.join('').trim() };
}

export function parseWebChatTools(text: string): WebChatToolCall[] {
  return consumeToolRegions(text).calls;
}

export function stripWebChatTools(text: string): string {
  return consumeToolRegions(text).remainder;
}

/** True when the reply started a provider tool fence that did not parse as JSON. */
export function incompleteWebChatTool(text: string): boolean {
  const source = text ?? '';
  let opens = 0;
  const fence = /```neuraflok-tool[^\n]*\r?\n/gi;
  while (fence.exec(source)) opens++;
  const banner = /(?:^|\n)neuraflok-tool[ \t]*\r?\n/gi;
  while (banner.exec(source)) opens++;
  if (!opens) return false;
  return parseWebChatTools(source).length < opens;
}

export function formatWebChatResult(name: string, content: string): string {
  return `\`\`\`neuraflok-result\n${JSON.stringify({ name, content })}\n\`\`\``;
}

export interface WebChatGuideContext {
  roots?: string[];
  project?: string;
  language?: import('./ui-language.js').UiLanguage;
}

export function webChatWriteRoot(ctx?: WebChatGuideContext): string {
  if (ctx?.project && ctx.project.trim()) return ctx.project.replace(/\/$/, '') || ctx.project;
  const writable = (ctx?.roots ?? []).filter(name => name && name !== '/skills');
  return writable[0] || '/workspace';
}

export function webChatRoundReminder(ctx?: WebChatGuideContext): string {
  const root = webChatWriteRoot(ctx);
  const listed = ctx?.roots?.length ? ctx.roots.join(', ') : root;
  const language = replyLanguageInstruction(ctx?.language);
  return [
    language,
    ctx?.project ? `Selected project directory: ${ctx.project}. Keep task work there.` : '',
    `Approved roots: ${listed}. Create files under ${root} with apply_patch.`,
    'To create or edit files you must emit a complete neuraflok-tool fence calling apply_patch.',
    'Pasting source in the chat does not write files.',
    `read takes {"paths":["${root}/file"]}. exec_command takes {"cmd":"..."}.`,
    'After listing a folder, the next reply must be apply_patch.',
    'When apply_patch has succeeded, answer the user with no fence.'
  ].filter(Boolean).join(' ');
}

export function incompleteToolNotice(ctx?: WebChatGuideContext): string {
  const root = webChatWriteRoot(ctx);
  return [
    'INCOMPLETE_TOOL: A neuraflok-tool fence was cut off or was not valid JSON.',
    'Reply with one complete fence and nothing else.',
    `apply_patch: {"name":"apply_patch","arguments":{"patch":"*** Begin Patch\\n*** Add File: ${root}/hello.txt\\n+hello\\n*** End Patch"}}`,
    'exec_command argument is cmd. read argument is paths (an array).'
  ].join(' ');
}

function compactToolLine(entry: { name: string; description: string; inputSchema: object }): string {
  const params = openaiToolParameters(entry.inputSchema);
  const required = Array.isArray(params.required) ? (params.required as string[]) : [];
  const props = params.properties && typeof params.properties === 'object'
    ? Object.keys(params.properties as object)
    : [];
  const args = (required.length ? required : props.slice(0, 4)).join(', ');
  const desc = entry.description.split('\n')[0]!.slice(0, 140);
  return `- ${entry.name}(${args}): ${desc}`;
}

export function webToolGuide(
  declarations: Array<{ name: string; description: string; inputSchema: object }>,
  ctx?: WebChatGuideContext
): string {
  const root = webChatWriteRoot(ctx);
  const readExample = JSON.stringify({ name: 'read', arguments: { paths: [`${root}/example.txt`] } });
  const patchExample = JSON.stringify({
    name: 'apply_patch',
    arguments: { patch: `*** Begin Patch\n*** Add File: ${root}/hello.txt\n+hello\n*** End Patch` }
  });
  return [
    'You are working in this local workspace. Local Core tools run only when you emit a tool block.',
    'Only these listed Core tools exist here. Desktop, agents, session_finish and code-mode exec are not available on this executor.',
    webChatRoundReminder(ctx),
    'Available tools:',
    declarations.map(compactToolLine).join('\n'),
    'Patch grammar (apply_patch argument "patch"):',
    '*** Begin Patch',
    `*** Add File: ${root}/name.ext`,
    '+file contents',
    '*** End Patch',
    '*** Begin Patch',
    `*** Update File: ${root}/name.ext`,
    '@@',
    '-old line',
    '+new line',
    '*** End Patch',
    'To call a tool, reply with one or more complete fenced blocks and no user-facing answer on that turn:',
    '```neuraflok-tool',
    readExample,
    '```',
    '```neuraflok-tool',
    patchExample,
    '```',
    'You will receive a neuraflok-result fence with that tool\'s output. When apply_patch has succeeded, write the answer with no neuraflok-tool fence.'
  ].join('\n');
}

