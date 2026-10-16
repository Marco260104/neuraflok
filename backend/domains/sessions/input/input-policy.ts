/** Read-only delivery eligibility; the outbox remains the only mutation owner. */
import { workSequence } from '../../../../contracts/session.js';
import { manualInput } from '../../../../contracts/input.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import type { InputEntry } from './input-schema.js';
import { isAstraModel, isProModel } from '../../../../contracts/model-capabilities.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { getSession, readRecentEvents, readCompletedFinal, turnHasMcpCall, questionHasMcpCall, readLatestUserMessage } from '../history/store.js';
import { isChatBlocked } from '../continuity/blocked-chats.js';
import { inFlightToolCalls } from '../../../infrastructure/tool-gateway/protocol/call-context.js';
import { providerForConversationId } from '../../../../contracts/web-providers.js';
import { isApiConversationId } from '../../../../contracts/chat-protocol.js';

export interface InputActivity { possible: boolean; exact: boolean; model?: 'pro' | 'other' | 'unknown'; turnId?: string }

/** One delivery policy for composer presentation, admission and the final send fence. */
export async function readSessionInputPolicy(sessionId: string, observedActivity?: InputActivity, activityFor?: (session: SessionSummary) => InputActivity): Promise<{ queueAtFinish: boolean; canInject: boolean; injectionTurnId: string | null; directTurn: InputEntry['directTurn'] | null; browserAllowed: boolean; settled: boolean }> {
  const [end] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  const session = await getSession(sessionId);
  if (!session?.conversationId || isChatBlocked(session.conversationId)) return { queueAtFinish: false, canInject: false, injectionTurnId: null, directTurn: null, browserAllowed: false, settled: false };
  const local = !!providerForConversationId(session.conversationId) || isApiConversationId(session.conversationId);
  const activity = observedActivity ?? activityFor?.(session) ?? { possible: !!session.activeTurnId, exact: !!session.activeTurnId };
  const stopped = session.finishTurn?.released === true;
  const selection = session.selectedModel?.conversationId === session.conversationId ? session.selectedModel : null;
  // A running browser turn accepts direct input through its provider composer; uncertain or Pro turns keep tool injection.
  const directTurn = !local && !stopped && activity.exact && end?.kind === 'turn_start' &&
    !!end.turnId && end.turnId === session.activeTurnId && !!selection?.model &&
    activity.model !== 'pro' && activity.model !== 'unknown' &&
    !isProModel(selection.model, selection.reasoningEffort)
    ? { id: end.turnId, startedAt: end.time } : null;
  const canInject = !local && !stopped && activity.exact && !directTurn;
  // The bridge's retained exact MCP grant can outlive a native UI end. Project that same turn for image custody, never invent an active recorder turn.
  const injectionTurnId = canInject ? session.activeTurnId ?? (activity.turnId === end?.turnId ? activity.turnId ?? null : null) : null;
  const astra = session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
    session.selectedModel?.conversationId === session.conversationId && isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
  const completed = !session.activeTurnId
    ? await readCompletedFinal(sessionId, session.conversationId) : null;
  const current = await getSession(sessionId);
  if (current?.conversationId !== session.conversationId || current?.activeTurnId !== session.activeTurnId)
    return { queueAtFinish: false, canInject: false, injectionTurnId: null, directTurn: null, browserAllowed: false, settled: false };
  const terminal = end?.kind === 'turn_end' && !!end.turnId && end.outcome !== 'unknown';
  const settled = (terminal && ((end.outcome === 'completed' && !activity.possible && !activity.exact) ||
    (end.outcome === 'failed' && end.reason === 'thinking_failed'))) ||
    (!astra && !!completed && !activity.possible && !activity.exact);
  const executing = inFlightToolCalls(session.conversationId) > 0;
  return { canInject, injectionTurnId, directTurn, queueAtFinish: astra && canInject && getConfig().ui.finishTool === true,
    // An adopted idle chat may have no recorded turn boundary. Explicit input can use its native composer; queued checkpoints still require `settled` below.
    browserAllowed: !session.activeTurnId && !activity.possible && !activity.exact && !executing,
    // Completion already reconciles trailing same-request calls. A separate time comparison would leave the composer unsettled after the activity clock stopped.
    settled: settled && !executing && (!!completed || (session.lastToolCallAt ?? 0) <= (end?.time ?? 0)) };
}

interface InputPolicyReaders {
  sessionPolicy(sessionId: string): ReturnType<typeof readSessionInputPolicy>;
  recoveryCurrent(entry: InputEntry): Promise<boolean>;
}

export async function readBrowserInputAllowed(entry: InputEntry, readers: InputPolicyReaders): Promise<boolean> {
  if (entry.localExecutor) return false;
  if (entry.sessionId) {
    const session = await getSession(entry.sessionId);
    if (session?.conversationId && (providerForConversationId(session.conversationId) || isApiConversationId(session.conversationId))) return false;
  }
  if (entry.error?.startsWith('Local chat setup failed:')) return false;
  // Authored Inject-now custody never changes transports. Its exact turn either offers it from an MCP response or expires it visibly below.
  if (entry.delivery === 'tool') return false;
  if (entry.attachmentDelivery === 'tool') return false;
  if (entry.opening && entry.sessionId && !entry.deliveredAt) {
    const session = await getSession(entry.sessionId);
    if (session?.origin?.kind === 'desktop' && !session.conversationId) return true;
  }
  if (entry.mode === 'finish' && entry.sessionId && entry.afterTurn !== true) {
    const session = await getSession(entry.sessionId);
    const selection = session?.selectedModel;
    if (selection?.conversationId === session?.conversationId && isAstraModel(selection?.model, selection?.reasoningEffort)) return false;
  }
  if (!entry.sessionId) return entry.transportIntent !== 'tool';
  const session = await getSession(entry.sessionId);
  // Departure suspends already accepted delivery through the final Send check. A new explicit immediate message remains a user action that may open the chat.
  if (session?.browserRecoveryDismissedAt !== undefined &&
      (!manualInput(entry) || entry.createdAt <= session.browserRecoveryDismissedAt)) return false;
  // Silence can leave the recorder's original turn open. Its durable ticket proves the exact unchanged work; the native page must still be idle for Send.
  if (entry.silenceBoundary) return await readEligibleStageEnd(entry, readers) === entry.silenceBoundary.turnId;
  const policy = await readers.sessionPolicy(entry.sessionId);
  if (entry.completedTurnId && await readEligibleStageEnd(entry, readers) !== entry.completedTurnId) return false;
  if (entry.directTurn) {
    const session = await getSession(entry.sessionId);
    if (!session || session.conversationId !== entry.conversationId) return false;
    if (session.activeTurnId) return policy.directTurn?.id === entry.directTurn.id;
    const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    return policy.browserAllowed && end?.kind === 'turn_end' && end.turnId === entry.directTurn.id;
  }
  // Only a never-offered ordinary input may change routes after positive terminal evidence. A tool handout or ambiguous browser claim retains its original exclusive custody.
  return policy.browserAllowed && (entry.transportIntent !== 'tool' ||
    (entry.mode === 'auto' && !entry.finishOwner && entry.purpose !== 'decision' && entry.state === 'queued' &&
      entry.owner === null && entry.offeredAt === undefined && policy.settled));
}

export async function readEligibleStageEnd(entry: InputEntry, readers: InputPolicyReaders): Promise<string | null> {
  if (!entry.sessionId) return null;
  if (entry.recovery) return await readers.recoveryCurrent(entry) &&
    ['ready', 'resumed'].includes(entry.recovery.phase) && (entry.silenceBoundary?.listenUntil ?? 0) <= Date.now()
    ? entry.silenceBoundary!.turnId : null;
  const session = await getSession(entry.sessionId);
  if (!session || session.origin?.kind === 'worker') return null;
  const [end] = await readRecentEvents(entry.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  // A later native final cannot erase an actual busy rejection. Keep this existing delay for the exact source turn until its native retry is due.
  if (entry.silenceBoundary?.nativeBusy && (entry.silenceBoundary.listenUntil ?? 0) > Date.now()) return null;
  // Explicit corrections bypass only the failed-view wait. Ordinary silence still needs its confirmed refresh, and fresh work/in-flight custody always veto Send.
  if (manualInput(entry) && !session.activeTurnId && end?.kind === 'turn_end' && end.turnId &&
      end.outcome === 'failed' && end.reason === 'thinking_failed' &&
      (session.lastToolCallAt ?? 0) <= end.time && session.conversationId &&
      !isChatBlocked(session.conversationId) && inFlightToolCalls(session.conversationId) === 0) return end.turnId;
  if (entry.silenceBoundary) {
    const boundary = entry.silenceBoundary;
    if (session.conversationId !== boundary.conversationId || isChatBlocked(boundary.conversationId) ||
        (session.activeTurnId && session.activeTurnId !== boundary.turnId) || inFlightToolCalls(boundary.conversationId) > 0) return null;
    if (end?.turnId !== boundary.turnId) return null;
    if (!(end.kind === 'turn_end' && end.outcome === 'completed') &&
        !await turnHasMcpCall(entry.sessionId, boundary.conversationId, boundary.turnId)) return null;
    if (end.kind !== 'turn_end' || end.outcome !== 'completed') {
      if ((boundary.listenUntil ?? 0) > Date.now() ||
          (end.kind === 'turn_end' && (session.lastToolCallAt ?? 0) > end.time)) return null;
      const [work] = await readRecentEvents(entry.sessionId, 1, { kinds: INPUT_WORK_KINDS });
      return work && workSequence(work) === boundary.workSeq ? boundary.turnId : null;
    }
    // A real final supersedes the silence assumption and spends the same source turn.
  }
  if (session.activeTurnId) return null;
  // A failure releases manual input immediately. Automatic follow-ups require the confirmed refresh ticket above; only a real completion bypasses it.
  if (end?.kind !== 'turn_end' || end.outcome !== 'completed' || !end.turnId) return null;
  // Queue intent names the turn we were waiting for, not when Chrome reported it. Other turns and legacy rows retain the later-completion rule. A rebind cannot lend this reference to another frontend, even if its turn id happens to match.
  const queuedHere = entry.queuedTurn?.conversationId === session.conversationId && entry.queuedTurn?.turnId === end.turnId;
  if (!queuedHere && end.time < entry.createdAt) return null;
  if (!(await readers.sessionPolicy(entry.sessionId)).settled) return null;
  return end.turnId;
}
export const INPUT_WORK_KINDS: import('../../../../contracts/session.js').SessionEvent['kind'][] =
  ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start', 'turn_end'];


// Control-only turn_end observations (including our own Stop) are not renewed work.
export const RECOVERY_WORK_KINDS: import('../../../../contracts/session.js').SessionEvent['kind'][] =
  ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start'];

/** Keep the rejection on the existing outbox receipt so an audit can identify the veto. */
export async function readRecoveryInvalidReason(row: InputEntry, recoveryAllowed: (sessionId: string, conversationId: string) => boolean | undefined): Promise<string | null> {
  const boundary = row.silenceBoundary;
  if (!row.recovery || !row.sessionId || !boundary) return 'the recovery source is missing';
  if (Date.now() - row.createdAt >= 12 * 60 * 60_000) return 'the twelve-hour recovery window expired';
  const unavailable = () => isChatBlocked(boundary.conversationId) ? 'this chat is blocked' :
    recoveryAllowed(row.sessionId!, boundary.conversationId) !== true ? 'automatic continuation is off or paused' : null;
  const reason = unavailable();
  if (reason) return reason;
  const session = await getSession(row.sessionId);
  if (!session || session.conversationId !== boundary.conversationId) return 'the session moved to another chat';
  if (session.browserRecoveryDismissedAt !== undefined) return 'the browser chat was closed';
  if (session.origin?.kind === 'worker' || session.origin?.kind === 'helper') return 'this task has a separate recovery owner';
  if (session.activeTurnId && session.activeTurnId !== boundary.turnId) return 'another turn started';
  if (session.finishTurn?.released) return 'the turn was released';
  const [end] = await readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
  if (end?.turnId !== boundary.turnId) return 'the recorded turn changed';
  if (end.kind === 'turn_end' && end.outcome === 'stopped') return 'the user stopped the turn';
  if (!await questionHasMcpCall(row.sessionId, boundary.conversationId, boundary.turnId)) return 'the source has no confirmed local tool call';
  if (await readCompletedFinal(row.sessionId, boundary.conversationId)) return 'the complete answer arrived';
  const question = await readLatestUserMessage(row.sessionId, boundary.turnId);
  const [work] = await readRecentEvents(row.sessionId, 1, { kinds: RECOVERY_WORK_KINDS });
  if (question?.messageId !== row.recovery.questionId) return 'another user message arrived';
  if (!work || workSequence(work) !== boundary.workSeq) return 'the source received new work';
  const changed = unavailable();
  if (changed) return changed;
  return (await getSession(row.sessionId))?.conversationId === boundary.conversationId ? null : 'the session moved to another chat';
}

