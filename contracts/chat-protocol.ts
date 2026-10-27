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

const XML_TOOL_OPEN = new RegExp(`<(${WEB_CHAT_CORE_TOOLS.join('|')})\\b[^>]*>`, 'gi');

function xmlToolBody(name: string, raw: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const row = parsed as { name?: unknown; arguments?: unknown };
  if (typeof row.name === 'string' && row.name.trim()) return raw;
  return JSON.stringify({ name, arguments: parsed });
}

function wrapToolBlocks(source: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  const open = /<neuraflok-tool\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source))) {
    const obj = readJsonObject(source, match.index + match[0].length);
    if (!obj) continue;
    let end = obj.end;
    const close = source.slice(end).match(/^[ \t]*\r?\n?<\/neuraflok-tool\s*>/i);
    if (close) end += close[0].length;
    out.push({ start: match.index, end, body: obj.json });
    open.lastIndex = end;
  }
  return out;
}

function xmlToolBlocks(source: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  const open = new RegExp(XML_TOOL_OPEN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = open.exec(source))) {
    const name = match[1]!;
    const obj = readJsonObject(source, match.index + match[0].length);
    if (!obj) continue;
    const body = xmlToolBody(name, obj.json);
    if (!body) continue;
    let end = obj.end;
    const close = source.slice(end).match(new RegExp(`^[ \\t]*\\r?\\n?</${name}\\s*>`, 'i'));
    if (close) end += close[0].length;
    out.push({ start: match.index, end, body });
    open.lastIndex = end;
  }
  return out;
}

function xmlToolOpens(source: string): number {
  const open = new RegExp(XML_TOOL_OPEN.source, 'gi');
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source))) {
    const from = match.index + match[0].length;
    const brace = source.indexOf('{', from);
    if (brace >= 0 && brace - from <= 48) count++;
  }
  return count;
}

function dsmlToolBlocks(source: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  const invoke = /<[^>]*\binvoke\b[^>]*\bname\s*=\s*["']?(exec_command|read|apply_patch)["']?[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = invoke.exec(source))) {
    const name = match[1]!;
    const from = match.index + match[0].length;
    const close = source.slice(from).search(/<\s*\/[^>]*invoke\b/i);
    const chunk = close >= 0 ? source.slice(match.index, from + close) : source.slice(match.index, match.index + 4_000);
    const param = chunk.match(/<[^>]*parameter[^>]*name\s*=\s*["']arguments["'][^>]*>([\s\S]*?)<\s*\/[^>]*parameter/i);
    const raw = param ? param[1]!.trim() : readJsonObject(source, from)?.json;
    if (!raw) continue;
    const body = xmlToolBody(name, raw);
    if (!body) continue;
    const end = close >= 0 ? from + close + (source.slice(from + close).match(/<\s*\/[^>]*invoke[^>]*>/i)?.[0].length ?? 0) : from + chunk.length;
    out.push({ start: match.index, end, body });
    invoke.lastIndex = end;
  }
  return out;
}

function dsmlToolOpens(source: string): number {
  const invoke = /<[^>]*\binvoke\b[^>]*\bname\s*=\s*["']?(exec_command|read|apply_patch)["']?[^>]*>/gi;
  let count = 0;
  while (invoke.exec(source)) count++;
  return count;
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
  for (const block of wrapToolBlocks(source)) take(block.start, block.end, block.body);
  for (const block of xmlToolBlocks(source)) take(block.start, block.end, block.body);
  for (const block of dsmlToolBlocks(source)) take(block.start, block.end, block.body);
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

const DSML_TAG = /<\/?\s*[\|｜]{1,4}\s*DSML\s*[\|｜]{1,4}[^>]*>/gi;
const DSML_MARK = /[\|｜]{1,4}\s*DSML\s*[\|｜]{1,4}[^<\n]*/gi;
const DSML_ORPHAN = /<\/?\s*[\|｜]{1,4}\s*>/g;

/** Drop DeepSeek DSML special tokens so they never reach the user-visible reply. */
export function stripDsmlChrome(text: string): string {
  let value = String(text ?? '');
  value = value.replace(DSML_TAG, '');
  value = value.replace(DSML_MARK, '');
  value = value.replace(DSML_ORPHAN, '');
  value = value.replace(/<\/?\s*[\|｜]{1,4}(?=\s*$)/gm, '');
  value = value.replace(/^\s*calls>\s*/i, '');
  value = value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return value;
}

export function stripWebChatTools(text: string): string {
  return stripDsmlChrome(consumeToolRegions(text).remainder);
}

/** True when the reply started a provider tool fence that did not parse as JSON. */
export function incompleteWebChatTool(text: string): boolean {
  const source = text ?? '';
  let opens = 0;
  const fence = /```neuraflok-tool[^\n]*\r?\n/gi;
  while (fence.exec(source)) opens++;
  const banner = /(?:^|\n)neuraflok-tool[ \t]*\r?\n/gi;
  while (banner.exec(source)) opens++;
  const wrap = /<neuraflok-tool\b[^>]*>/gi;
  while (wrap.exec(source)) opens++;
  opens += xmlToolOpens(source);
  opens += dsmlToolOpens(source);
  if (opens) return parseWebChatTools(source).length < opens;
  return /\binvoke\b/i.test(source) && /exec_command|read|apply_patch/i.test(source) && parseWebChatTools(source).length === 0;
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

export function webChatConversationGuide(ctx?: WebChatGuideContext): string {
  const language = replyLanguageInstruction(ctx?.language);
  const root = webChatWriteRoot(ctx);
  return [
    language,
    'This is a conversation only. Answer the user directly in ordinary prose.',
    `The default workspace folder is ${root}. Do not list or send a file tree.`,
    'Do not use tools, commands, file reads, or project inspection.',
    'Do not emit neuraflok-tool fences, DSML, XML invoke tags, or special tokens.'
  ].filter(Boolean).join(' ');
}

export function webChatRoundReminder(ctx?: WebChatGuideContext): string {
  if (!ctx?.project) return webChatConversationGuide(ctx);
  const root = webChatWriteRoot(ctx);
  const listed = ctx.roots?.length ? ctx.roots.join(', ') : root;
  const language = replyLanguageInstruction(ctx.language);
  return [
    language,
    `Selected project directory: ${ctx.project}. Keep task work there.`,
    `Approved roots: ${listed}.`,
    `read takes a neuraflok-tool fence {"name":"read","arguments":{"paths":["${root}/file"]}}. Prefer read on the project folder. Do not run rg; it is not on this PowerShell PATH.`,
    `exec_command takes a neuraflok-tool fence {"name":"exec_command","arguments":{"cmd":"Get-ChildItem -Name","workdir":"${root}"}}. Set workdir to the virtual project path. Never put ${root} inside cmd; use relative paths such as lib/index.js.`,
    'Do not write PowerShell with $ in cmd; this chat renders $ as math and corrupts the command. Do not pipe to head, wc, cat, or ls.',
    `To create or edit files, emit a complete neuraflok-tool fence calling apply_patch under ${root}. Pasting source in the chat does not write files.`,
    'Do not write planning sentences such as Let me or We need. On the user task, first output must be a complete neuraflok-tool fence. The handshake reply NEURAFLOK_READY is exempt and must not include a tool fence. Never emit DSML, XML invoke tags, or special tokens in any reply. If the user asked a question or the work is done, answer after tools in a short friendly recap: what is done, how to open or try it, and what is left. No logs, fences, or protocol chrome in that answer. Only apply_patch when they asked to change files.'
  ].filter(Boolean).join(' ');
}

export function incompleteToolNotice(ctx?: WebChatGuideContext): string {
  const root = webChatWriteRoot(ctx);
  return [
    'INCOMPLETE_TOOL: A neuraflok-tool fence was cut off or was not valid JSON.',
    'Reply with one complete fence and nothing else.',
    `apply_patch: {"name":"apply_patch","arguments":{"patch":"*** Begin Patch\\n*** Add File: ${root}/hello.txt\\n+hello\\n*** End Patch"}}`,
    'exec_command arguments are cmd and workdir. read argument is paths (an array).'
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
  const execExample = JSON.stringify({ name: 'exec_command', arguments: { cmd: 'Get-ChildItem -Name', workdir: root } });
  const patchExample = JSON.stringify({
    name: 'apply_patch',
    arguments: { patch: `*** Begin Patch\n*** Add File: ${root}/hello.txt\n+hello\n*** End Patch` }
  });
  return [
    'You are working in this local workspace. Local Core tools run only when you emit a tool block.',
    'Only these listed Core tools exist here. Desktop, agents, session_finish and code-mode exec are not available on this executor.',
    webChatRoundReminder(ctx?.project ? ctx : { ...ctx, project: root }),
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
    execExample,
    '```',
    '```neuraflok-tool',
    patchExample,
    '```',
    'You will receive a neuraflok-result fence with that tool\'s output. After tools finish, answer the user with no fence unless another tool call is required. That final answer must be friendly and easy to read: what changed, how to try it, and what is still open. Never DSML or XML.'
  ].join('\n');
}

