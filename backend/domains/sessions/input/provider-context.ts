import type { InputAttachment } from '../../../../contracts/input.js';
import { readProviderTextAttachment } from './attachments/index.js';
import { prepareProviderSessionPrompt, prepareProviderSkillFollowup } from './prompt.js';
import type { InputEntry } from './input.js';
import { getSessionProject } from '../../workspace/projects.js';
import { listDirectory } from '../../workspace/file-ops/directory.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readRecentEvents, sessionDir } from '../../sessions/history/store.js';
import type { SessionEvent } from '../../../../contracts/session.js';

/** Leave room for the web adapter's transport guide inside its own message ceiling. */
export const LOCAL_PROVIDER_PROMPT_LIMITS = { maxChars: 72_000, maxBytes: 288_000 } as const;
export const WEB_BOOTSTRAP_ACK = 'NEURAFLOK_READY';
export const LEGACY_WEB_BOOTSTRAP_ACK = 'NEURAL_JAM_READY';
const WEB_BOOTSTRAP_REQUEST = `Initialize this NEURAFLOK conversation using the instructions below. This is configuration only, not a user task. Do not run tools or execute examples. Reply with exactly ${WEB_BOOTSTRAP_ACK} and wait for the next user message.`;
const MAX_INLINE_ATTACHMENT_BYTES = 500_000;
const RECAP_LIMIT = 12_000;
const CONTINUATION_LIMIT = 20_000;
const TREE_EXCLUDE = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', '.turbo', 'out'];
const ERROR_TEXT = /provider_page_timeout|no verified browser tab|did not accept the message|took too long|servidor no (está|esta) disponible|temporarily unavailable|the provider reported a problem/i;
const TOOL_DUMP = /```(?:neuraflok-tool|json)\b|<neuraflok-tool\b|<\/?invoke\b|DSML/;
const DONE_BANNER = /no quedan tareas pendientes|est[aá] completo y verificado|no pending tasks|the project is complete|ya est[aá] (todo )?listo(;|,|\.|$)|nothing (else )?to (do|change)/i;
const hydratedLocalSessions = new Set<string>();
const sessionWorkPlans = new Map<string, SessionWorkPlan>();

export interface SessionWorkPlan {
  task: string;
  steps: string[];
  index: number;
}

/** Bare continue/resume, including Spanish CONTINUA without an accent. */
export function looksLikeContinueRequest(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value) return false;
  return /^(contin[uú]a(?:r)?|continue|sigue|seguir|resume|reanuda(?:r)?|keep going|go on|prosigue)(\s+(por favor|please|on|from there|from where you (left|stopped)|con (?:eso|ello|lo (?:mismo|anterior)|el trabajo)))?[\s.!?…]*$/i.test(value);
}

export function markLocalProviderHydrated(sessionId: string): void {
  hydratedLocalSessions.add(sessionId);
}

export function resetLocalProviderHydrationForTests(): void {
  hydratedLocalSessions.clear();
  sessionWorkPlans.clear();
}

export function getSessionWorkPlan(sessionId: string): SessionWorkPlan | null {
  return sessionWorkPlans.get(sessionId) ?? null;
}

export function setSessionWorkPlan(sessionId: string, plan: SessionWorkPlan): void {
  sessionWorkPlans.set(sessionId, plan);
}

export function advanceSessionWorkPlan(sessionId: string): SessionWorkPlan | null {
  const plan = sessionWorkPlans.get(sessionId);
  if (!plan) return null;
  plan.index += 1;
  if (plan.index >= plan.steps.length) {
    sessionWorkPlans.delete(sessionId);
    return null;
  }
  return plan;
}

export function clearSessionWorkPlan(sessionId: string): void {
  sessionWorkPlans.delete(sessionId);
}

/** New work that should be planned before edits. Bare CONTINUA is not this. */
export function needsWorkPlan(text: string): boolean {
  if (looksLikeContinueRequest(text)) return false;
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length < 20) return false;
  return /next\.?js|anime|framework|migr|reescrib|cambiar todo|animaci[oó]n|agrega|a[nñ]ade|implementa|redise[nñ]|refactor|nuevo |nueva /i.test(value)
    || value.length >= 60;
}

export function looksLikeStaleCompletion(text: string): boolean {
  return DONE_BANNER.test(String(text || '').replace(/\s+/g, ' '));
}

/** A long project-status recap. General chats must not publish this as the reply to a greeting. */
export function looksLikeProjectStatusRecap(text: string): boolean {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 80) return false;
  const recap = /ya qued[oó] implementado|esto es lo que cambi[oó]|c[oó]mo probarlo|how to (try|test|open) it|npm run (dev|build)|no quedan tareas pendientes|the project is complete/i;
  const files = /\b[\w./-]+\.(js|ts|tsx|css|html|json)\b/;
  return recap.test(value) && files.test(value);
}

export function parseWorkPlan(text: string): string[] {
  const steps: string[] = [];
  for (const line of String(text || '').split(/\n/)) {
    const match = line.match(/^\s*(?:\d+[\.)]|[-*]|paso\s*\d+\s*[:.)-])\s+(.+)/i);
    if (!match) continue;
    const step = match[1]!.replace(/\s+/g, ' ').trim();
    if (step.length >= 6) steps.push(step);
  }
  return steps.slice(0, 8);
}

export function formatPlanOnlyPrompt(task: string): string {
  return [
    '## PLAN_ONLY',
    'The latest user message is the current task. A previous recap that the project is complete is stale and must be ignored.',
    'You may read files. Do not apply_patch. Do not say the previous work is already done.',
    'Reply with a numbered plan of 3 to 7 short steps for THIS request, then stop:',
    clipMessage(task, 1_200)
  ].join('\n');
}

export function formatExecuteStepPrompt(plan: SessionWorkPlan): string {
  const step = plan.steps[plan.index] ?? '';
  const n = plan.index + 1;
  return [
    '## EXECUTE_ONE_STEP',
    `Current user request:\n${clipMessage(plan.task, 900)}`,
    `Plan:\n${plan.steps.map((row, i) => `${i + 1}. ${row}`).join('\n')}`,
    `Do ONLY step ${n} of ${plan.steps.length}: ${step}`,
    'Do not claim the whole project is complete. Do not start later steps.'
  ].join('\n');
}

/** Old chats always restore AGENTS.md. New chats already load it on the opening turn. */
export function localProviderNeedsWorkspace(_sessionId: string, opening: boolean, _text: string): boolean {
  return !opening;
}

function isBootstrapContent(content: string): boolean {
  return /NEURAFLOK_READY|NEURAL_JAM_READY|Initialize this NEURAFLOK conversation/i.test(content);
}

/** First user task of a chat: empty thread, or only system/bootstrap rows. Warmup must not flip this to an old-chat recap. */
export function isNewProviderChat(
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  openingEntry = false
): boolean {
  if (openingEntry) return true;
  return messages.every((row) => {
    if (row.role === 'system') return true;
    return isBootstrapContent(String(row.content ?? ''));
  });
}

function clipMessage(content: string, max: number): string {
  const value = content.replace(/\r\n?/g, '\n').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated]`;
}

function isUnusableAssistantContent(content: string): boolean {
  if (!content || isBootstrapContent(content)) return true;
  if (ERROR_TEXT.test(content) && content.length < 400) return true;
  const stripped = content.replace(TOOL_DUMP, '').replace(/\{[\s\S]*\}/g, '').replace(/\s+/g, ' ').trim();
  if (TOOL_DUMP.test(content) && stripped.length < 40) return true;
  return false;
}

function formatProviderWorkLog(
  messages: ReadonlyArray<{ role: string; content?: string | null }>
): string {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const text = String(message.content ?? '');
    if (!text || ERROR_TEXT.test(text)) continue;
    for (const match of text.matchAll(/^[AMD]\s+(\/\S+)/gm)) {
      const path = match[1]!;
      if (seen.has(path)) continue;
      seen.add(path);
      const verb = match[0][0] === 'A' ? 'Added' : match[0][0] === 'D' ? 'Deleted' : 'Updated';
      files.push(`${verb} ${path}`);
    }
  }
  const kept = files.slice(-40);
  if (!kept.length) return '';
  return `## Work already done in this session\n${kept.map((row) => `- ${row}`).join('\n')}`;
}

function formatProviderProjectTree(
  directory: string,
  entries: ReadonlyArray<{ virtualPath: string; type: string }>
): string {
  if (!entries.length) return `## Project files\nDirectory: ${directory}`;
  const lines = entries.slice(0, 80).map((entry) => {
    const rel = entry.virtualPath.startsWith(`${directory}/`)
      ? entry.virtualPath.slice(directory.length + 1)
      : entry.virtualPath;
    return `- ${rel}${entry.type === 'directory' ? '/' : ''}`;
  });
  const extra = entries.length > 80 ? `\n- … ${entries.length - 80} more` : '';
  return `## Project files\nDirectory: ${directory}\n${lines.join('\n')}${extra}`;
}

/** Last user/assistant turns from the local thread, for a provider page that no longer holds that history. */
export function formatProviderConversationRecap(
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  continueOnly = false,
  general = false
): string {
  const rows: string[] = [];
  let previous = '';
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'system' || message.role === 'tool') continue;
    const content = String(message.content ?? '').trim();
    if (!content || isBootstrapContent(content)) continue;
    if (message.role === 'user' && looksLikeContinueRequest(content)) continue;
    if (message.role === 'assistant' && isUnusableAssistantContent(content)) continue;
    if (!continueOnly && message.role === 'assistant' && looksLikeStaleCompletion(content)) continue;
    const prior = messages[index - 1];
    if (
      message.role === 'assistant'
      && looksLikeProjectStatusRecap(content)
      && prior?.role === 'user'
      && isBootstrapContent(String(prior.content ?? ''))
    ) continue;
    const clipped = clipMessage(content, message.role === 'assistant' ? 1_800 : 2_200);
    if (clipped === previous) continue;
    previous = clipped;
    const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
    rows.push(`${label}:\n${clipped}`);
  }
  const kept = rows.slice(-10);
  if (!kept.length) return '';
  const lead = general
    ? 'These are earlier turns in this conversation. Use them as context. Answer the latest user message. This is not a coding project.'
    : continueOnly
      ? 'This is the same project and the same task. Continue that work. Do not start an unrelated task.'
      : 'This is prior work on the same project. The latest user message is the current task. Follow that request even if a previous recap said the work was complete.';
  let body = `<CONVERSATION_SO_FAR>\n${lead}\n\n${kept.join('\n\n')}\n</CONVERSATION_SO_FAR>`;
  if (body.length > RECAP_LIMIT) body = body.slice(body.length - RECAP_LIMIT);
  return body;
}

function formatWhereLeftOff(
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  continueOnly = false
): string {
  let lastUser = '';
  let lastAssistant = '';
  for (const message of messages) {
    const content = String(message.content ?? '').trim();
    if (!content || isBootstrapContent(content)) continue;
    if (message.role === 'user' && !looksLikeContinueRequest(content)) lastUser = clipMessage(content, 900);
    if (message.role === 'assistant' && !isUnusableAssistantContent(content) && (continueOnly || !looksLikeStaleCompletion(content))) {
      lastAssistant = clipMessage(content, 900);
    }
  }
  if (!lastUser && !lastAssistant) return '';
  const parts = ['## Where this session left off'];
  if (lastUser) parts.push(`Last user request:\n${lastUser}`);
  if (lastAssistant) parts.push(`Last useful assistant update:\n${lastAssistant}`);
  parts.push(continueOnly
    ? 'Resume from that point. Do not restart the project from scratch.'
    : 'This is background only. The latest user message is the current task. If they asked to rewrite, add a framework, or change the stack, do that on this project.');
  return parts.join('\n\n');
}

function sessionEventText(event: SessionEvent): string {
  if (event.kind === 'user_message') return String(event.authoredText || event.message?.text || '').trim();
  if (event.kind === 'assistant_message') return String(event.message?.text || '').trim();
  if (event.kind === 'tool_call') return String(event.call?.result?.text || '').trim();
  return '';
}

async function sessionHistoryMessages(
  sessionId: string
): Promise<Array<{ role: string; content: string }>> {
  try {
    const events = await readRecentEvents(sessionId, 80, {
      kinds: ['user_message', 'assistant_message', 'tool_call']
    });
    const out: Array<{ role: string; content: string }> = [];
    for (const event of events) {
      const content = sessionEventText(event);
      if (!content) continue;
      if (event.kind === 'user_message') out.push({ role: 'user', content });
      else if (event.kind === 'assistant_message' && event.final === true) out.push({ role: 'assistant', content });
      else if (event.kind === 'tool_call') out.push({ role: 'tool', content });
    }
    return out;
  } catch {
    return [];
  }
}

function mergeContextMessages(
  history: ReadonlyArray<{ role: string; content?: string | null }>,
  thread: ReadonlyArray<{ role: string; content?: string | null }>
): Array<{ role: string; content?: string | null }> {
  const out: Array<{ role: string; content?: string | null }> = [...history];
  const seen = new Set(history.map((row) => `${row.role}:${String(row.content ?? '').slice(0, 240)}`));
  for (const row of thread) {
    const key = `${row.role}:${String(row.content ?? '').slice(0, 240)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function loadProjectTree(sessionId: string): Promise<{ directory: string | null; tree: string }> {
  try {
    const folder = await getSessionProject(sessionId);
    if (!folder) return { directory: null, tree: '' };
    const listed = await listDirectory(folder.real, folder.virtual, {
      recursive: true,
      maxEntries: 80,
      exclude: TREE_EXCLUDE
    });
    let tree = formatProviderProjectTree(folder.virtual, listed.entries);
    if (listed.truncated) tree += '\n- … listing truncated';
    return { directory: folder.virtual, tree };
  } catch {
    return { directory: null, tree: '' };
  }
}

/**
 * Project chat packing:
 * newChat true  → instructions + project tree
 * newChat false → tree + instructions + recap (what was discussed, where it left off)
 */
export function formatProviderSessionContinuation(input: {
  newChat?: boolean;
  continueOnly?: boolean;
  currentTask?: string;
  directory?: string | null;
  tree?: string;
  work?: string;
  recap?: string;
  leftOff?: string;
  replyGuide?: string;
}): string {
  const tree = input.tree || (input.directory ? `## Project files\nDirectory: ${input.directory}` : '');
  if (input.newChat) {
    const howTo = 'Use a complete ```neuraflok-tool fence for tools. Prefer read on the listed project paths. When you talk to the user, be short and friendly. Never write <neuraflok-tool fence>, DSML, or XML invoke tags as the user-visible answer.';
    const sections = [
      '# Project structure',
      'This is a new chat. Follow these workspace instructions. Use this file tree as the current project.',
      input.replyGuide ? `## How to reply\n${input.replyGuide}\n${howTo}` : `## How to reply\n${howTo}`,
      tree
    ].filter(Boolean);
    return sections.join('\n\n');
  }
  const continueOnly = input.continueOnly === true;
  const mission = continueOnly
    ? 'This is an existing session. Follow this markdown context. It is the source of truth for prior work. Do not start an unrelated task.'
    : 'This is an existing session. Prior files and conversation are context. The latest user message is the current task. Follow that request even if a previous recap said the project was complete. If they asked to rewrite, add Next.js, add animations, or change the stack, do that.';
  const howTo = continueOnly
    ? 'Use a complete ```neuraflok-tool fence for tools. When you talk to the user, be short and friendly: what is done, how to try it, what is left. Never write <neuraflok-tool fence>, DSML, or XML invoke tags as the user-visible answer.'
    : 'Use a complete ```neuraflok-tool fence for tools. Then do the latest user request. When you talk to the user, be short and friendly. Never write <neuraflok-tool fence>, DSML, or XML invoke tags as the user-visible answer.';
  const sections = [
    '# Continuation of this NEURAFLOK session',
    mission,
    input.currentTask && !continueOnly ? `## Current user request\n${clipMessage(input.currentTask, 1_200)}` : '',
    input.replyGuide ? `## How to reply\n${input.replyGuide}\n${howTo}` : `## How to reply\n${howTo}`,
    tree,
    input.work ?? '',
    input.leftOff ?? '',
    input.recap ?? ''
  ].filter(Boolean);
  let body = sections.join('\n\n');
  if (body.length > CONTINUATION_LIMIT) body = `${body.slice(0, CONTINUATION_LIMIT)}\n[truncated]`;
  return body;
}

/**
 * Chat without a project: never send a file tree. New chats send nothing extra
 * (instructions + user request are attached by the executor). Existing chats add a recap.
 */
export async function buildGeneralChatContext(
  sessionId: string,
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  options: { newChat: boolean }
): Promise<string> {
  if (options.newChat) return '';
  const history = await sessionHistoryMessages(sessionId);
  const combined = mergeContextMessages(history, messages);
  const recap = formatProviderConversationRecap(combined, false, true);
  if (!recap) return '';
  const pack = [
    '# Conversation recap',
    'This is an existing conversation. Use this recap plus the latest user message. Do not inspect files or run tools.',
    recap
  ].join('\n\n');
  await fs.writeFile(path.join(sessionDir(sessionId), 'general.md'), pack, 'utf8').catch(() => undefined);
  return pack;
}

export async function buildProviderProjectContext(
  sessionId: string,
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  options: { newChat: boolean; replyGuide?: string; continueOnly?: boolean; currentTask?: string }
): Promise<string> {
  const { directory, tree } = await loadProjectTree(sessionId);
  if (options.newChat) {
    return formatProviderSessionContinuation({
      newChat: true,
      directory,
      tree,
      replyGuide: options.replyGuide
    });
  }
  const continueOnly = options.continueOnly === true;
  const history = await sessionHistoryMessages(sessionId);
  const combined = mergeContextMessages(history, messages);
  return formatProviderSessionContinuation({
    newChat: false,
    continueOnly,
    currentTask: options.currentTask,
    directory,
    tree,
    work: formatProviderWorkLog(combined),
    recap: formatProviderConversationRecap(combined, continueOnly),
    leftOff: formatWhereLeftOff(combined, continueOnly),
    replyGuide: options.replyGuide
  });
}

export async function buildProviderReconnectContext(
  sessionId: string,
  messages: ReadonlyArray<{ role: string; content?: string | null }>,
  replyGuide?: string
): Promise<string> {
  return buildProviderProjectContext(sessionId, messages, { newChat: false, continueOnly: true, replyGuide });
}

function joinWithinBudget(base: string, extra: string): string {
  if (!extra) return base;
  const fits = (value: string): boolean =>
    value.length <= LOCAL_PROVIDER_PROMPT_LIMITS.maxChars &&
    Buffer.byteLength(value, 'utf8') <= LOCAL_PROVIDER_PROMPT_LIMITS.maxBytes;
  const combined = `${base}\n\n${extra}`;
  if (fits(combined)) return combined;
  let keep = extra;
  while (keep.length > 400 && !fits(`${base}\n\n${keep}`)) keep = keep.slice(Math.ceil(keep.length / 4));
  const clipped = `${base}\n\n${keep}`;
  return fits(clipped) ? clipped : base;
}

function continueTask(text: string): string {
  if (!looksLikeContinueRequest(text)) return text;
  return `${text}\n\nContinue the same work already in progress for this selected project. Use AGENTS.md and the conversation recap. Do not start an unrelated task.`;
}

/** Setup is its own first native message; authored work and file bytes arrive afterwards. */
export async function prepareWebProviderBootstrap(entry: InputEntry, sessionId: string, guide: string): Promise<string> {
  const setup = await prepareProviderSessionPrompt(WEB_BOOTSTRAP_REQUEST,
    { sessionId, projectId: entry.projectId }, LOCAL_PROVIDER_PROMPT_LIMITS, '');
  return `${setup}\n\n${guide}\n\n${WEB_BOOTSTRAP_REQUEST}`;
}

async function attachedText(attachments: readonly InputAttachment[] | undefined, allowImages: boolean): Promise<string> {
  if (!attachments?.length) return '';
  const sections: string[] = [];
  let bytes = 0;
  for (const attachment of attachments) {
    if (attachment.mimeType.startsWith('image/')) {
      if (!allowImages) throw new Error(`“${attachment.name}” is an image. Image attachments are supported by the API executor; use a project file with a web session.`);
      sections.push(`[Image attachment: ${attachment.name}. Image data is sent separately.]`);
      continue;
    }
    const remaining = MAX_INLINE_ATTACHMENT_BYTES - bytes;
    if (remaining < 1) throw new Error('Attached text files exceed the 500 KB inline context limit. Add their folder as a project instead.');
    const text = await readProviderTextAttachment(attachment, remaining);
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_INLINE_ATTACHMENT_BYTES) throw new Error('Attached text files exceed the 500 KB inline context limit. Add their folder as a project instead.');
    sections.push(`<ATTACHED_FILE name=${JSON.stringify(attachment.name)}>\n${text}\n</ATTACHED_FILE>`);
  }
  return `\n\n<USER_ATTACHED_FILES>\n${sections.join('\n\n')}\n</USER_ATTACHED_FILES>`;
}

/** Prepare the exact text that a local executor sends. Opening turns use the provider tool guide plus the selected project's AGENTS.md and frozen Skills; later turns keep language and project directory and add only explicitly selected Skills unless the chat was reopened or the user asked to continue. File bytes are read from the validated attachment store and bounded first. */
export async function prepareLocalProviderPrompt(
  entry: InputEntry,
  sessionId: string,
  opening: boolean,
  options: { allowImageAttachments?: boolean; recap?: string; hydrateWorkspace?: boolean; conversationOnly?: boolean } = {}
): Promise<string> {
  if (options.conversationOnly) {
    const files = await attachedText(entry.attachments, options.allowImageAttachments === true);
    return joinWithinBudget(`${entry.text}${files}`, options.recap ?? '');
  }
  const scope = { sessionId, projectId: entry.projectId, autoSkills: entry.autoSkills };
  const task = continueTask(entry.text);
  const restoreWorkspace = opening || options.hydrateWorkspace === true;
  const base = restoreWorkspace
    ? await prepareProviderSessionPrompt(task, scope, LOCAL_PROVIDER_PROMPT_LIMITS, entry.text)
    : await prepareProviderSkillFollowup(task, entry.text, LOCAL_PROVIDER_PROMPT_LIMITS, scope);
  const files = await attachedText(entry.attachments, options.allowImageAttachments === true);
  const prepared = joinWithinBudget(`${base}${files}`, options.recap ?? '');
  if (prepared.length > LOCAL_PROVIDER_PROMPT_LIMITS.maxChars || Buffer.byteLength(prepared, 'utf8') > LOCAL_PROVIDER_PROMPT_LIMITS.maxBytes) {
    throw new Error('The message and attached files exceed the local provider context limit. Shorten the message or add the folder as a project.');
  }
  return prepared;
}
