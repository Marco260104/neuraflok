import type { AgentState } from '../../../contracts/session.js';
import { queuedFollowup } from '../../../contracts/input.js';
import { t } from '../../shared/i18n.js';
import type { ChatProgressRuntime } from './chat-progress-types.js';
import { chatSelectionStartedAt, hasRecentTurnActivity, internalWarmupTurnIds, isInternalWarmupQuestionText } from './chat-turn-state.js';
import { selectedAuthoredInputPending } from './chat-warmup-inputs.js';
import { WEB_CHAT_WARMUP_TEXT } from './chat-web-warmup.js';

export interface ProgressStatus {
  text: string;
  tone: '' | 'is-live' | 'is-bad';
  working?: boolean;
  ticking?: boolean;
}

export function createChatProgressStatus(runtime: ChatProgressRuntime) {
  function badgeSignature(): string {
    return runtime.sessions
      .map((entry) =>
        runtime
          .sessionBadges(entry)
          .map((badge) => badge.text)
          .join(','),
      )
      .join('|');
  }
  // Recent tool activity can indicate work when a provider turn boundary is missing.
  const BLIND_CAPTION_MS = 90_000;
  // An open provider turn is not proof of progress. Stop displaying a growing
  // elapsed clock when the chat has produced no visible output or tool activity.
  const PROVIDER_SILENCE_MS = 90_000;
  // Restored provider controls can carry a stale turn from before this chat
  // was reopened. Confirm that work belongs to this selection before showing
  // a live caption, then retain that confirmation during quiet reasoning.
  let confirmedSelectionTurn: string | null = null;
  let latchedSelectionTurn: { sessionId: string; generation: number; turnId: string } | null = null;
  const RECENT_AUTHORED_TURN_MS = 15_000;

  function turnConfirmedForSelection(turnId: string): boolean {
    const sessionId = runtime.selectedId;
    if (!sessionId) return false;
    const key = `${sessionId}:${runtime.selectionGeneration}:${turnId}`;
    const internalInputIds = new Set(
      [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs]
        .filter(entry => entry.warmup &&
          (entry.sessionId ?? entry.deliveredSessionId) === sessionId)
        .map(entry => entry.id),
    );
    const warmupTurns = internalWarmupTurnIds(runtime.events, internalInputIds, WEB_CHAT_WARMUP_TEXT);
    if (warmupTurns.has(turnId)) {
      if (confirmedSelectionTurn === key) confirmedSelectionTurn = null;
      return false;
    }
    if (confirmedSelectionTurn === key) return true;
    const selectedAt = chatSelectionStartedAt(sessionId, runtime.selectionGeneration);
    const now = Date.now();
    // Initial restoration may not have recorded a navigation boundary yet.
    // In that case only accept evidence from the last few seconds, and still
    // reject replayed MCP progress for a question from an older selection.
    const activityBoundary = selectedAt ?? now - 10_000;
    const latestQuestion = [...runtime.events].reverse().find(event => event.kind === 'user_message' &&
      event.internalWarmup !== true &&
      !warmupTurns.has(event.turnId ?? '') &&
      !(event.inputId && internalInputIds.has(event.inputId)) &&
      !isInternalWarmupQuestionText(event.message.text, WEB_CHAT_WARMUP_TEXT));
    const recentAuthoredQuestion = latestQuestion?.kind === 'user_message' &&
      now - latestQuestion.time >= -1_000 &&
      now - latestQuestion.time < RECENT_AUTHORED_TURN_MS &&
      (!latestQuestion.turnId || latestQuestion.turnId === turnId);
    // A restored `turn_start` can be replayed after navigation even when its
    // authored question and answer belong to the previous visit. A start by
    // itself is not evidence of a new turn; require a fresh question or the
    // activity gate that also ties a start to one.
    if (!recentAuthoredQuestion && !hasRecentTurnActivity(
      runtime.events,
      turnId,
      activityBoundary,
      now,
      internalInputIds,
      WEB_CHAT_WARMUP_TEXT,
    )) return false;
    confirmedSelectionTurn = key;
    return true;
  }

  function stateLine(): ProgressStatus {
    if (!runtime.state()?.config.ui.developerMode) {
      const summary = runtime.sessions.find(
        (entry) => entry.id === runtime.selectedId,
      );
      if (!summary || runtime.detailFor !== runtime.selectedId)
        return { text: '', tone: '' };
      const lastBoundary = [...runtime.events]
        .reverse()
        .find(
          (event) => event.kind === 'turn_start' || event.kind === 'turn_end',
        );
      let latestRequestAt = Number.NEGATIVE_INFINITY;
      for (const event of runtime.events)
        if (event.kind === 'user_message' || event.kind === 'turn_start')
          latestRequestAt = Math.max(latestRequestAt, event.time);
      const latestExplicitCompletion = Math.max(
        ...runtime.events.flatMap(event =>
          (event.kind === 'turn_end' && event.outcome !== 'unknown') || event.kind === 'chat_error'
            ? [event.time]
            : []),
        summary.lastTurnEndAt ?? Number.NEGATIVE_INFINITY,
      );
      const completedLatestTurn = latestExplicitCompletion > latestRequestAt;
      const activeInputs = [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs]
        .filter(entry => {
          const owner = entry.sessionId ?? entry.deliveredSessionId ?? null;
          return owner === runtime.selectedId &&
            !entry.warmup && !entry.warmupDeferred && entry.purpose !== 'decision' &&
            entry.authoredSource !== 'none' &&
            ['queued', 'browser', 'tool', 'sent'].includes(entry.state) &&
            entry.dueAt <= Date.now();
        });
      const queuedFollowupWaiting = activeInputs.some(entry => queuedFollowup(entry) &&
        ['queued', 'browser', 'tool'].includes(entry.state));
      const recentUnstartedQuestion = [...runtime.events].reverse().find(event =>
        event.kind === 'user_message' && event.internalWarmup !== true &&
        !isInternalWarmupQuestionText(event.message.text, WEB_CHAT_WARMUP_TEXT) &&
        event.time > latestExplicitCompletion);
      const authoredInputWaiting = selectedAuthoredInputPending(
        activeInputs,
        runtime.selectedId,
        runtime.selectionGeneration,
        null,
        runtime.events,
        Date.now(),
        latestExplicitCompletion,
      );
      const handoffWaiting = queuedFollowupWaiting || authoredInputWaiting ||
        (recentUnstartedQuestion?.kind === 'user_message' &&
          Date.now() - recentUnstartedQuestion.time < RECENT_AUTHORED_TURN_MS);
      const stoppedTurn = runtime.locallyStoppedTurn;
      const stoppedQuestionStillLatest = stoppedTurn?.sessionId === runtime.selectedId &&
        !runtime.events.some(event => event.time > stoppedTurn.stoppedAt && (
          event.kind === 'turn_start' && event.turnId !== stoppedTurn.turnId ||
          event.kind === 'user_message' && event.internalWarmup !== true &&
            !isInternalWarmupQuestionText(event.message.text, WEB_CHAT_WARMUP_TEXT)
        ));
      const activeHandoffWaiting = handoffWaiting && !(stoppedQuestionStillLatest &&
        recentUnstartedQuestion?.kind === 'user_message' && recentUnstartedQuestion.time <= stoppedTurn.stoppedAt &&
        !queuedFollowupWaiting && !authoredInputWaiting);
      const controlledTurn =
        runtime.controlledSessionId === runtime.selectedId &&
        runtime.controlledSelection === runtime.selectionGeneration
          ? runtime.controlledTurnId
          : null;
      const turnHasEnded = (turnId: string | null | undefined): boolean => {
        if (!turnId) return false;
        const locallyStopped = runtime.locallyStoppedTurn;
        if (locallyStopped?.sessionId === runtime.selectedId && locallyStopped.turnId === turnId &&
            !runtime.events.some(event => event.kind === 'turn_start' && event.turnId === turnId && event.time > locallyStopped.stoppedAt))
          return true;
        if (runtime.events.some(event => (event.kind === 'turn_end' && event.turnId === turnId && event.outcome !== 'unknown') ||
          (event.kind === 'chat_error' && event.turnId === turnId))) return true;
        // An assistant message can be marked final between steps of a long
        // provider task. Only an explicit turn boundary or error ends its
        // selection-confirmed work state; silence must not make it disappear.
        return false;
      };
      // A stale active-turn control must not keep the UI spinning after that
      // turn has an explicit end or error.
      const controlledTurnEnded = turnHasEnded(controlledTurn);
      const summaryTurnEnded = turnHasEnded(summary.activeTurnId);
      if (latchedSelectionTurn && (latchedSelectionTurn.sessionId !== runtime.selectedId ||
          latchedSelectionTurn.generation !== runtime.selectionGeneration)) {
        latchedSelectionTurn = null;
        confirmedSelectionTurn = null;
      }
      const latchedTurnEnded = latchedSelectionTurn ? turnHasEnded(latchedSelectionTurn.turnId) : false;
      const laterTurnActivity = runtime.events.some(event => event.time > latestExplicitCompletion &&
        (event.kind === 'assistant_message' || event.kind === 'tool_call' || event.kind === 'page_tool' || event.kind === 'progress')) ||
        (summary.lastToolCallAt !== null && summary.lastToolCallAt > latestExplicitCompletion);
      // DeepSeek may publish intermediate finals or briefly omit the control
      // snapshot while the same long request is still running. Preserve the
      // last selection-confirmed turn until a real end/error boundary arrives.
      const candidateActive = !completedLatestTurn || laterTurnActivity || activeHandoffWaiting
        ? controlledTurn && !controlledTurnEnded
        ? controlledTurn
        : summary.activeTurnId && !summaryTurnEnded
          ? summary.activeTurnId
          : latchedSelectionTurn && !latchedTurnEnded
            ? latchedSelectionTurn.turnId
            : null
        : null;
      const active = candidateActive && turnConfirmedForSelection(candidateActive) ? candidateActive : null;
      if (active) latchedSelectionTurn = {
        sessionId: runtime.selectedId!,
        generation: runtime.selectionGeneration,
        turnId: active,
      };
      if (!candidateActive || (candidateActive && turnHasEnded(candidateActive))) {
        confirmedSelectionTurn = null;
        latchedSelectionTurn = null;
      }
      // Keep the single live work state through the handoff between a finished
      // provider turn and its already-queued follow-up. The queued row is the
      // durable source of truth until the next user event/turn takes over.
      if (!active && activeHandoffWaiting)
        return { text: t('Working…'), tone: 'is-live', working: true, ticking: true };
      if (!active && lastBoundary?.kind === 'turn_end' &&
          lastBoundary.outcome !== 'completed' && lastBoundary.outcome !== 'unknown') {
        return { text: '', tone: '' };
      }
      // Use recent attributed tool activity when the provider has not reported a turn boundary.
      const reportedEnd = Math.max(
        lastBoundary?.kind === 'turn_end' ? lastBoundary.time : 0,
        summary.lastTurnEndAt ?? 0,
        summary.lastAssistantFinalAt ?? 0,
      );
      const blind =
        !active &&
        !summaryTurnEnded &&
        summary.lastToolCallAt !== null &&
        Date.now() - summary.lastToolCallAt < BLIND_CAPTION_MS &&
        summary.lastToolCallAt > reportedEnd
          ? { text: t('Working…'), tone: '' as const, working: true }
          : null;
      const turnId = active ?? lastBoundary?.turnId;
      if (!turnId) return blind ?? { text: '', tone: '' };
      const startedAt =
        summary.finishTurn?.turnId === turnId
          ? summary.finishTurn.startedAt
          : runtime.events.find(
              (event) => event.kind === 'turn_start' && event.turnId === turnId,
            )?.time;
      const endedAt = runtime.events.find(
        (event) => event.kind === 'turn_end' && event.turnId === turnId,
      )?.time;
      if (startedAt === undefined)
        return active
          ? { text: t('Working…'), tone: '', working: true }
          : (blind ?? { text: '', tone: '' });
      if (!active && endedAt === undefined)
        return blind ?? { text: '', tone: '' };
      if (blind) return blind;
      if (active) {
        let lastVisibleActivityAt = startedAt;
        for (const event of runtime.events) {
          if (event.time < startedAt || (event.turnId && event.turnId !== turnId)) continue;
          if (event.kind === 'tool_call' || event.kind === 'page_tool' ||
              event.kind === 'assistant_message' ||
              (event.kind === 'progress' && event.source === 'extension')) {
            lastVisibleActivityAt = Math.max(lastVisibleActivityAt, event.time);
          }
        }
        if (summary.lastToolCallAt !== null && summary.lastToolCallAt >= startedAt)
          lastVisibleActivityAt = Math.max(lastVisibleActivityAt, summary.lastToolCallAt);
        if (summary.lastAssistantFinalAt && summary.lastAssistantFinalAt >= startedAt)
          lastVisibleActivityAt = Math.max(lastVisibleActivityAt, summary.lastAssistantFinalAt);
        if (Date.now() - lastVisibleActivityAt >= PROVIDER_SILENCE_MS)
          return { text: t('Waiting for provider…'), tone: '', working: true };
      }
      const seconds = Math.max(
        0,
        Math.floor(((active ? Date.now() : endedAt!) - startedAt) / 1000),
      );
      return {
        text: t('{0} for {1}{2}s', [
          active ? t('Working') : t('Worked'),
          seconds >= 60 ? `${t('{0}m', [Math.floor(seconds / 60)])} ` : '',
          seconds % 60,
        ]),
        tone: '',
        working: !!active,
        ticking: !!active,
      };
    }
    // Report unattributed work without assigning it to an unverified conversation.
    const selected =
      runtime.sessions.find((entry) => entry.id === runtime.selectedId) ?? null;
    if (selected && selected.conversationId === null) {
      return {
        text: t(
          'Work this app could not place in a provider conversation — it may have come from another device or an unpaired browser',
        ),
        tone: '',
      };
    }

    const workers =
      runtime.swarm?.agents.filter((agent) => agent.role === 'worker') ?? [];
    if (workers.length === 0) return { text: '', tone: '' };
    const count = (state: AgentState): number =>
      workers.filter((agent) => agent.state === state).length;
    const parts: string[] = [];
    if (count('active') > 0) parts.push(t('{0} working', [count('active')]));
    // Invited workers have an assigned conversation but have not joined it yet.
    if (count('invited') > 0) parts.push(t('{0} opening', [count('invited')]));
    // Detached workers can continue reporting tools without an open browser tab.
    if (count('detached') > 0)
      parts.push(t('{0} working with no tab', [count('detached')]));
    if (count('waking') > 0) parts.push(t('{0} waking up', [count('waking')]));
    // Sleeping workers remain available for reuse by their run.
    if (count('sleeping') > 0)
      parts.push(t('{0} sleeping', [count('sleeping')]));
    if (count('finished') > 0)
      parts.push(t('{0} finished', [count('finished')]));
    if (count('failed') > 0) parts.push(t('{0} failed', [count('failed')]));
    const live =
      count('invited') + count('active') + count('detached') + count('waking');
    return {
      text: `${workers.length === 1 ? t('1 worker') : t('{0} workers', [workers.length])} · ${parts.join(' · ')}`,
      tone: count('failed') > 0 ? 'is-bad' : live > 0 ? 'is-live' : '',
    };
  }
  return { badgeSignature, stateLine };
}
