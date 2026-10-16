import { randomUUID } from 'node:crypto';
import { fail } from './tool-contracts.js';
import type { ToolResult } from './tool-contracts.js';
import type { CallContext } from './call-context.js';
import { requestCorrelation } from '../../../domains/sessions/history/correlation.js';
import { recordProgress } from '../../../domains/sessions/history/recorder.js';
import { conversationAttachment, getSession } from '../../../domains/sessions/history/store.js';
import {
  endedWorkerNotice,
  dormantWorkerNotice,
  retiredWorkerForConversation,
  silentCeilingWorkerNotice,
  workerPrimeOwner
} from '../../../domains/automation/agents.js';
import { isChatBlocked } from '../../../domains/sessions/continuity/blocked-chats.js';
import { compactingConversation } from '../../../domains/sessions/continuity/continuation.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../../domains/workspace/execution/unified-exec-constants.js';

const UNTRUSTED_NOTICE = 'A tool call from an untrusted chat was refused. In the chat list, hover this chat in the sidebar and choose Trust (✓) to allow it.';
const UNTRUSTED_WORKER_NOTICE = 'A tool call from a worker whose owning prime is not currently allowed was refused. In the chat list, hover the owning prime row in the sidebar and choose Trust (✓) if it is untrusted, or Release there if it is blocked.';
const UNPROVEN_WORKER_NOTICE = 'A tool call from an app-created worker was refused because no unique owning prime is currently proven. Return to the owning prime in the chat list; once its row is known, hover it in the sidebar and choose Trust (✓), or Release there if it is blocked, then retry after the worker is attached or recovered there.';
const MAX_REFUSAL_EPISODES = 128;
const MAX_RECOVERED_REQUESTS = 2_000;
const IDENTITY_RECOVERY_OUTPUT_BUDGET = DEFAULT_MAX_OUTPUT_TOKENS * 4;

type IdentityRecovery = { tools: Set<string>; offer?: CallContext['publication'] };

const untrustedNoticeEpisodes = new Map<string, true>();
const identityRefusals = new WeakSet<ToolResult>();
const identityRecovery = new Map<string, IdentityRecovery>();

function refusalEpisodeKey(context: CallContext): string | null {
  const { conversationId, sessionId } = context.caller;
  return conversationId && sessionId ? `${sessionId}\0${conversationId}` : null;
}

export function clearUntrustedRefusalEpisode(context: CallContext): void {
  const key = refusalEpisodeKey(context);
  if (key) untrustedNoticeEpisodes.delete(key);
}

export function failIdentity(text: string): ToolResult {
  const result = fail(text);
  identityRefusals.add(result);
  return result;
}

export function isIdentityRefusal(result: ToolResult): boolean {
  return identityRefusals.has(result);
}

export function resetIdentityNotices(): void {
  identityRecovery.clear();
  untrustedNoticeEpisodes.clear();
}

export async function recordUntrustedRefusalNotice(context: CallContext): Promise<void> {
  const { caller } = context;
  const key = refusalEpisodeKey(context);
  if (!key || !caller.conversationId || !caller.sessionId || untrustedNoticeEpisodes.has(key)) return;
  untrustedNoticeEpisodes.set(key, true);
  const exact = requestCorrelation(caller.requestId);
  if (exact?.conversationId !== caller.conversationId || exact.sessionId !== caller.sessionId ||
      await conversationAttachment(caller.conversationId, caller.sessionId) !== 'current') {
    untrustedNoticeEpisodes.delete(key);
    return;
  }
  const worker = workerPrimeOwner(caller.conversationId);
  const session = worker.owned ? null : await getSession(caller.sessionId).catch(() => null);
  const message = worker.owned
    ? worker.primeConversationId ? UNTRUSTED_WORKER_NOTICE : UNPROVEN_WORKER_NOTICE
    : session?.origin?.kind === 'worker' ? UNPROVEN_WORKER_NOTICE : UNTRUSTED_NOTICE;
  const recorded = await recordProgress(caller.sessionId, `strict-chat-refusal:${randomUUID()}`, message);
  if (!recorded) {
    untrustedNoticeEpisodes.delete(key);
    return;
  }
  while (untrustedNoticeEpisodes.size > MAX_REFUSAL_EPISODES) {
    const oldest = untrustedNoticeEpisodes.keys().next().value as string | undefined;
    if (!oldest) break;
    untrustedNoticeEpisodes.delete(oldest);
  }
}

export function rememberIdentityRefusal(requestId: string | null, tool: string): void {
  if (!requestId) return;
  const previous = identityRecovery.get(requestId);
  const pending = previous && !previous.offer ? previous : { tools: new Set<string>() };
  if (pending.tools.size < 8) pending.tools.add(tool.slice(0, 100));
  identityRecovery.delete(requestId);
  identityRecovery.set(requestId, pending);
  if (identityRecovery.size > MAX_RECOVERED_REQUESTS) identityRecovery.delete(identityRecovery.keys().next().value!);
}

export async function withIdentityRecoveredNotice(context: CallContext, result: ToolResult): Promise<ToolResult> {
  const { caller, publication } = context;
  if (!identityRecovery.size || !publication || !caller.conversationId || !caller.sessionId) return result;
  const exact = requestCorrelation(caller.requestId);
  if (exact?.conversationId !== caller.conversationId || exact.sessionId !== caller.sessionId) return result;
  if (await conversationAttachment(caller.conversationId, caller.sessionId) !== 'current') return result;
  if (isChatBlocked(caller.conversationId) || compactingConversation(caller.conversationId) ||
      retiredWorkerForConversation(caller.conversationId) || dormantWorkerNotice(caller.conversationId) ||
      silentCeilingWorkerNotice(caller.conversationId) || endedWorkerNotice(caller.conversationId)) return result;
  const pending: IdentityRecovery[] = [];
  for (const [requestId, entry] of identityRecovery) {
    if (entry.offer && !entry.offer.failed) {
      if (entry.offer.completedAt !== null) identityRecovery.delete(requestId);
      continue;
    }
    const owner = requestCorrelation(requestId);
    if (owner?.conversationId === caller.conversationId && owner.sessionId === caller.sessionId) pending.push(entry);
  }
  if (!pending.length) return result;
  const tools = [...new Set(pending.flatMap(entry => [...entry.tools]))].slice(0, 8).join(', ');
  const text = '\n--- Identity recovered ---\n' +
    `Your request is now matched to this provider conversation. Earlier ${tools} calls were refused because chat identity was missing. ` +
    'You can now retry any still-needed operation that was not performed because of that refusal. ' +
    'Do not repeat completed operations. Other permissions and lifecycle restrictions still apply.';
  const used = result.content.reduce((bytes, part) => bytes + (part.type === 'text' ? Buffer.byteLength(part.text, 'utf8') : 0), 0);
  if (used + Buffer.byteLength(text, 'utf8') > IDENTITY_RECOVERY_OUTPUT_BUDGET) return result;
  for (const entry of pending) entry.offer = publication;
  return { ...result, content: [...result.content, { type: 'text', text }] };
}
