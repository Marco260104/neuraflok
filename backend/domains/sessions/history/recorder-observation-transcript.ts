import { chatErrorMessageKey } from '../../../../contracts/chat-error.js';
import { responseTurnId } from '../../../../contracts/chronology.js';
import { runningToolCalls } from '../../../infrastructure/tool-gateway/protocol/call-context.js';
import { recordObservationTurnEnd, recordObservationTurnStart } from './recorder-observation-lifecycle.js';
import { recordNativeImage } from './recorder-images.js';
import { observedUserTitle, recordPageTool, recordSupersededMessages, supersededLineage } from './recorder-observation-helpers.js';
import { pageToolKey } from './recorder-observation-tools.js';
import type { ChatObservation, ObservationActivity, ObservationRuntime } from './recorder-observation-types.js';
import { appendEvent, getSession, observeSessionModel, readCompletedFinal, readLatestUserMessage, readRecentEvents, upsertMessageEvent, MAX_USER_MESSAGE_CHARS } from './store.js';
export async function recordChatObservationsNow(
  runtime: ObservationRuntime,
  conversationId: string,
  observations: readonly ChatObservation[],
  agent?: string | null
): Promise<{
  sessionId: string | null;
  stored: number;
  activity: ObservationActivity;
  goalCandidates: Array<{ replyId: string; turnId: string; eventSeq: number }>;
}> {
  const { conversations, recordingEnabled, sessionForConversation, storeText, notifyChanged, promoteConversationTitle, reopenThinkingFailure } = runtime;
  const activity: ObservationActivity = { meaningful: false, working: false, terminal: false };
  if (!recordingEnabled()) return { sessionId: null, stored: 0, activity, goalCandidates: [] };
  if (!conversations.has(conversationId)) {
    const lineage = await supersededLineage(conversationId);
    if (lineage) {
      const stored = await recordSupersededMessages(runtime, lineage, observations);
      return { sessionId: lineage, stored, activity, goalCandidates: [] };
      }
    }
    let firstUser: ChatObservation | undefined;
    let pageTitle: ChatObservation | undefined;
    const explicitEnds = new Set<string>();
    const batchTurnStarts = new Map<string, number>();
    let batchUncertainEndId: string | null = null;
    // This batch is hot while provider is streaming. Collect the three facts needed before the write loop in one pass instead of find + find + filter + map (the latter two also allocated an intermediate array for every batch).
    for (const item of observations) {
      if (!firstUser && item.kind === 'user_message') firstUser = item;
      if (item.kind === 'conversation_title') pageTitle = item;
      if (item.kind === 'turn_start' && item.turnId) batchTurnStarts.set(item.turnId, item.time);
      if (item.kind === 'turn_end' && item.turnId) {
        explicitEnds.add(item.turnId);
        if (item.outcome !== 'completed' && item.outcome !== 'stopped') batchUncertainEndId = item.turnId;
      }
    }
    const sessionId = await sessionForConversation(
      conversationId,
      pageTitle?.text?.trim() || observedUserTitle(firstUser?.text)
    );
    if (!sessionId) return { sessionId: null, stored: 0, activity, goalCandidates: [] };
    const live = conversations.get(conversationId);
    let stored = 0;
    let recoveredGoalSeen = false;
    const goalCandidates: Array<{ replyId: string; turnId: string; eventSeq: number }> = [];
    // Recover only from the canonical stored message and a turn already open before this batch.
    const recoverableTurns = new Set(live?.openTurns);
    let recoveredFinal: { turnId: string; time: number; seq: number; origin: number; native: boolean } | undefined;
    let terminalFinalAt: number | undefined;

    for (const item of observations) {
      const base = {
        time: item.time,
        source: 'extension' as const,
        ...(item.authoredAt !== undefined ? { authoredAt: item.authoredAt } : {}),
        ...(item.turnId ? { turnId: item.turnId } : {}),
        ...(agent ? { agent } : {})
      };
      switch (item.kind) {
        case 'model_selection':
          if (item.model) await observeSessionModel(sessionId, conversationId, item.model, item.time, item.reasoningEffort);
          break;
        case 'conversation_title':
          // Apply after canonical messages so legacy preview proof exists in either batch order.
          break;
        case 'user_message': {
          // A message with no provider identity cannot participate in the canonical transcript. Dropping it is safer than minting a local id that can collide on reload.
          if (!item.messageId) continue;
          const written = await upsertMessageEvent(sessionId, {
            ...base,
            kind: 'user_message',
            message: await storeText(sessionId, item.text ?? '', MAX_USER_MESSAGE_CHARS),
            ...(item.attachments?.length ? { attachments: item.attachments } : {}),
            ...(item.reaction !== undefined ? { reaction: item.reaction } : {}),
            ...(item.model ? { model: item.model } : {}),
            messageId: item.messageId
          }, { preferTime: item.authoredTime === true, work: item.authoredNow === true });
          if (!written.changed) continue;
          if (item.authoredNow === true) {
            activity.meaningful = true; activity.at = Math.max(activity.at ?? 0, item.time);
            activity.working = true;
          }
          break;
        }
        case 'assistant_message': {
          if (!item.messageId) continue;
          const state = item.state ?? (item.final === true ? 'final' : 'streaming');
          // A canonical final can supersede an uncertain boundary only when its stable message id proves it.
          const batchUncertainStartedAt = batchUncertainEndId
            ? batchTurnStarts.get(batchUncertainEndId) ??
              (live?.turnId === batchUncertainEndId ? live.turnStartedAt : null)
            : null;
          const priorUncertainStartedAt =
            live?.turnStartedAt === null &&
            live.lastTurnOutcome !== null &&
            live.lastTurnOutcome !== 'completed' &&
            live.lastTurnOutcome !== 'stopped'
              ? live.lastTurnStartedAt
              : null;
          const uncertainTurnStartedAt = batchUncertainStartedAt ?? priorUncertainStartedAt;
          const terminalActivity =
            state === 'final' &&
            (item.activeNow === true ||
              (uncertainTurnStartedAt !== null && item.time >= uncertainTurnStartedAt));
          const recoveredGoalEligible =
            state === 'final' &&
            !item.turnId &&
            live !== undefined &&
            uncertainTurnStartedAt !== null &&
            item.time >= uncertainTurnStartedAt;
          const goalEligible = item.goalEligible === true || recoveredGoalEligible;
          const written = await upsertMessageEvent(sessionId, {
            ...base,
            kind: 'assistant_message',
            // Keep long answers inline so a continuation does not make the transcript appear truncated.
            message: await storeText(sessionId, item.text ?? '', 256_000),
            messageId: item.messageId,
            ...(item.inputId ? { inputId: item.inputId } : {}),
            state,
            final: state === 'final',
            ...(item.providerMessageId ? { providerMessageId: item.providerMessageId } : {}),
            ...(item.resolvedModel ? { resolvedModel: item.resolvedModel } : {}),
            ...(goalEligible && state === 'final' ? { goalEligible: true } : {})
          }, { preferTime: item.authoredTime === true, work: item.activeNow === true });
          const canonicalTurn = written.event.turnId;
          // Replayed partial answers retain their canonical owner and cannot renew activity after a terminal boundary.
          const [uncertainEnd] = canonicalTurn && !live?.turnId
            ? await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end', 'user_message'] }) : [];
          // A fresh exact interim can resume an uncertain failure without inventing a new user turn. Old messages and explicit completed/stopped turns cannot.
          const resumedUncertainTurn = uncertainEnd?.kind === 'turn_end' && uncertainEnd.turnId === canonicalTurn &&
            uncertainEnd.outcome !== 'completed' && uncertainEnd.outcome !== 'stopped' && item.time > uncertainEnd.time;
          // Provider identity and authored-time promotion revise history, not work. A post-failure backfill must not reopen a dead turn.
          const workingActivity = written.contentChanged && state !== 'final' && item.activeNow === true &&
            (!canonicalTurn || canonicalTurn === live?.turnId || resumedUncertainTurn) &&
            !(live?.turnStartedAt === null && (live.lastTurnOutcome === 'stopped' || live.lastTurnOutcome === 'completed'));
          const turns = state === 'final' && canonicalTurn && live?.turnId && live.turnId !== canonicalTurn && written.event.kind === 'assistant_message' &&
            written.event.providerMessageId ? (await getSession(sessionId))?.timelineTurns : undefined;
          const finishingTurn = canonicalTurn && live?.turnId && (canonicalTurn === live.turnId ||
            (turns && responseTurnId(turns, canonicalTurn) === responseTurnId(turns, live.turnId))) ? live.turnId : null;
          if (state === 'final' && written.event.kind === 'assistant_message' && finishingTurn && recoverableTurns.has(finishingTurn) &&
              !explicitEnds.has(finishingTurn)) {
            recoveredFinal = { turnId: finishingTurn, time: item.time,
              seq: written.event.finalContentSeq ?? written.event.origin ?? written.event.seq,
              origin: written.event.origin ?? written.event.seq, native: Boolean(written.event.providerMessageId) };
          }
          if (
            written.event.kind === 'assistant_message' &&
            written.event.goalEligible === true &&
            state === 'final' &&
            written.event.messageId
          ) {
            goalCandidates.push({
              replyId: written.event.messageId,
              turnId: written.event.turnId ?? `reply:${written.event.messageId}`.slice(0, 200),
              eventSeq: written.event.origin ?? written.event.seq
            });
          }
          if (recoveredGoalEligible && live) {
            // Remember recovered Goal eligibility without inventing a durable turn-end event.
            recoveredGoalSeen = true;
          }
          if (!written.changed) continue;
          if (state === 'final' && written.event.kind === 'assistant_message' && written.event.providerMessageId &&
              uncertainEnd?.kind === 'turn_end' && uncertainEnd.reason === 'thinking_failed' &&
              uncertainEnd.turnId === canonicalTurn && (written.event.finalContentSeq ?? written.event.seq) > uncertainEnd.seq &&
              live && !live.turnId && runningToolCalls(conversationId) === 0) {
            await appendEvent(sessionId, { ...base, kind: 'turn_end', turnId: canonicalTurn, outcome: 'completed',
              detail: 'the exact native final superseded the failed view' });
            live.lastTurnOutcome = 'completed';
            activity.endedTurnId = canonicalTurn;
            activity.terminal = true;
            activity.meaningful = true;
          }
          if (workingActivity && canonicalTurn &&
              await reopenThinkingFailure(sessionId, live, item.time, canonicalTurn)) {
            activity.terminal = false;
          }
          if (terminalActivity) terminalFinalAt = Math.max(terminalFinalAt ?? 0, item.time);
          if (workingActivity) { activity.meaningful = true; activity.at = Math.max(activity.at ?? 0, item.time); }
          if (workingActivity) activity.working = true;
          break;
        }
        case 'native_image': {
          // Native media is transcript content only. It does not renew activity, close a turn, create a Goal candidate, or masquerade as a locally executed tool call.
          stored += await recordNativeImage(sessionId, item, base);
          continue;
        }
        case 'page_tool': {
          const newlyObserved = !!live && !!item.messageId && !live.pageTools.has(pageToolKey(item.messageId));
          const written = await recordPageTool(sessionId, live, item, base);
          if (!written) continue;
          if (newlyObserved && item.activeNow !== false && item.turnId && await reopenThinkingFailure(sessionId, live, item.time, item.turnId)) {
            activity.terminal = false;
            activity.working = true;
            activity.meaningful = true;
            activity.at = Math.max(activity.at ?? 0, item.time);
          }
          if (newlyObserved && item.activeNow !== false && item.turnId === live?.turnId && live.turnStartedAt !== null && item.time >= live.turnStartedAt) {
            // A new exact native thought/tool row is work for every model. A label revision or a replay of its stable identity remains presentation only.
            activity.meaningful = true;
            activity.working = true;
            activity.at = Math.max(activity.at ?? 0, item.time);
          }
          break;
        }
        case 'chat_error': {
          if (item.reason === 'thinking_failed' && !item.turnId) continue;
          if (item.reason === 'stream_gone' && (!item.turnId || live?.turnId !== item.turnId ||
              await readCompletedFinal(sessionId, conversationId, item.turnId))) continue;
          // Reloads lose/remint document turn ids. A recoverable notice belongs to the canonical question, not that document. Keep the original notice throughout recovery; a genuinely new question gives the same error a new owner.
          const text = chatErrorMessageKey(item.text ?? '', item.recoverable === true);
          const question = item.recoverable === true ? await readLatestUserMessage(sessionId) : undefined;
          const recent = await readRecentEvents(sessionId, 32, { kinds: ['chat_error'], maxBytes: 256 * 1024 });
          if (recent.some(event => event.kind === 'chat_error' &&
              ((question && event.recoverable === true && event.seq > (question.origin ?? question.seq)) ||
              ((Math.abs(item.time - event.time) <= 30_000 ||
                (item.reason === 'thinking_failed' && event.reason === item.reason && event.turnId === item.turnId)) &&
              (item.blocking === true || (event.turnId ?? '') === (item.turnId ?? '')) &&
              (!question || event.seq > (question.origin ?? question.seq)))) &&
              (chatErrorMessageKey(event.message.text, event.recoverable === true) === text ||
                (item.recoverable === true && event.recoverable === true &&
                  (item.reason === 'stream_gone' || event.reason === 'stream_gone'))))) continue;
          await appendEvent(sessionId, {
            ...base,
            kind: 'chat_error',
            ...(item.inputId ? { inputId: item.inputId } : {}),
            ...(item.reason === 'thinking_failed' || item.reason === 'stream_gone' ? { reason: item.reason } : {}),
            ...(typeof item.recoverable === 'boolean' ? { recoverable: item.recoverable } : {}),
            ...(typeof item.blocking === 'boolean' ? { blocking: item.blocking } : {}),
            message: await storeText(sessionId, item.text ?? '', 2000)
          });
          activity.meaningful = true;
          break;
        }
        case 'turn_start':
          if (!await recordObservationTurnStart(sessionId, item, live, base, activity)) continue;
          break;
        case 'turn_end':
          if (!await recordObservationTurnEnd(sessionId, item, live, base, activity)) continue;
          break;
      }
      stored++;
    }
    if (pageTitle) await promoteConversationTitle(sessionId, pageTitle.text, conversationId);
    // Keep a canonical final visible while tools drain; evaluate completion after the full batch so newer work wins.
    const completion = recoveredFinal || terminalFinalAt !== undefined
      ? await readCompletedFinal(sessionId, conversationId, live?.turnId ?? recoveredFinal?.turnId) : null;
    if (terminalFinalAt !== undefined && completion) {
      activity.meaningful = true;
      activity.at = Math.max(activity.at ?? 0, terminalFinalAt);
      activity.terminal = true;
    }
    if (recoveredFinal && completion && live?.turnId === recoveredFinal.turnId && live.openTurns.has(recoveredFinal.turnId)) {
      const { turnId, time } = recoveredFinal;
      await appendEvent(sessionId, {
        time, source: 'extension', kind: 'turn_end', turnId, outcome: 'completed',
        detail: 'recovered from a final assistant message after the provider page reloaded',
        ...(agent ? { agent } : {})
      });
      // Commit before publishing, preserving the same late-tool evidence as an explicit end.
      live.openTurns.delete(turnId);
      live.knownTurnEnds.add(turnId);
      live.lastTurnOutcome = 'completed';
      live.lastTurnStartedAt = live.turnStartedAt;
      // Native message time may be its creation time, long before this final was observed.
      live.endedTurn = { turnId, startedAt: live.turnStartedAt, endedAt: Date.now(), requestIds: live.turnRequestIds };
      live.turnRequestIds = new Set<string>();
      live.turnStartedAt = null;
      live.turnId = null;
      activity.meaningful = true;
      activity.at = Math.max(activity.at ?? 0, time);
      activity.terminal = true;
      activity.endedTurnId = turnId;
      stored++;
    }
    if (recoveredGoalSeen && live) live.lastTurnOutcome = 'completed';
    notifyChanged(sessionId);
    return { sessionId, stored, activity, goalCandidates };
  }


