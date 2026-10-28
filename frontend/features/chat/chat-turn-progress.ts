import { KIND_ICON } from './chat-event-renderer.js';
import type { RunningToolActivity, SessionEvent } from '../../../contracts/session.js';
import { $, el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import type { ChatProgressRuntime } from './chat-progress-types.js';
import type { ProgressStatus } from './chat-progress-status.js';
import {
  composerWarmupKey,
  composerWarmupState,
  retrySelectedChatWarmup,
  shouldSuppressWarmupActivity,
  visibleWarmupPhase
} from './chat-composer-ready.js';
import {
  projectAuthoredInputProgress,
  selectedAuthoredInputPending,
  warmupDeferredEntries,
  warmupDeferredProgress,
  withoutInternalWarmupEvents,
} from './chat-warmup-inputs.js';
import { internalWarmupTurnIds, isInternalWarmupTurnOpen } from './chat-turn-state.js';
import { WEB_CHAT_WARMUP_TEXT } from './chat-web-warmup.js';

export function createChatTurnProgress(
  runtime: ChatProgressRuntime,
  getStateLine: () => ProgressStatus,
) {
  const turnStatusLine = turnLine('turn-worked turn-status');
  let turnWorking = false;

  // Keeps the current activity beside the turn that owns it.
  const turnNow = el('div', 'meta is-progress thinking-line turn-now');
  turnNow.setAttribute('role', 'status');
  turnNow.setAttribute('aria-live', 'polite');
  turnNow.setAttribute('aria-atomic', 'true');
  const turnNowIcon = el('span', 'turn-now-icon');
  const turnNowSpinner = el('span', 'thinking-spinner');
  turnNowSpinner.setAttribute('aria-hidden', 'true');
  const turnNowText = el('span', 'turn-now-text');
  const turnNowTime = el('span', 'turn-now-time');
  const turnNowRetry = el('button', 'turn-now-retry') as HTMLButtonElement;
  turnNowRetry.type = 'button';
  turnNowRetry.hidden = true;
  turnNowRetry.addEventListener('click', () => retrySelectedChatWarmup());
  const turnNowBody = el('span', 'turn-now-body');
  turnNowBody.append(turnNowText, turnNowTime, turnNowRetry);
  turnNow.append(turnNowIcon, turnNowBody);
  turnNow.hidden = true;
  let runningTools: RunningToolActivity[] = [];
  let runningToolsFor: string | null = null;
  let runningToolsAt = 0;
  let runningToolsEvents = -1;
  let runningToolsRequest = 0;
  // Treat assistant prose as active only while its content is changing.
  let proseSeen: { key: string; chars: number; changedAt: number } | null =
    null;
  const PROSE_QUIET_MS = 2500;
  function proseMoving(
    event: Extract<SessionEvent, { kind: 'assistant_message' }>,
  ): boolean {
    const key = event.messageId ?? `seq:${event.seq}`;
    const chars = event.message.chars ?? event.message.text.length;
    if (proseSeen?.key !== key || proseSeen.chars !== chars)
      proseSeen = { key, chars, changedAt: Date.now() };
    return Date.now() - proseSeen.changedAt < PROSE_QUIET_MS;
  }
  // Only progressive English step labels indicate activity; completed labels remain historical.
  const NATIVE_STEP_NOW = /^\S+ing\b/i;

  function preparation() {
    return composerWarmupState(composerWarmupKey(runtime.selectedId, runtime.selectionGeneration));
  }

  function selectedProjectId(): string | null {
    const session = runtime.sessions.find(entry => entry.id === runtime.selectedId);
    const inherited = session?.origin?.kind === 'worker' && session.origin.fromSessionId
      ? runtime.sessions.find(entry => entry.id === session.origin?.fromSessionId)?.projectId
      : undefined;
    return session?.projectId ?? inherited ?? runtime.selectedProjectId;
  }

  function composerInputs() {
    return [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs];
  }

  function hasOpenInternalWarmupTurn(): boolean {
    const warmupInputIds = new Set(composerInputs().filter(entry => entry.warmup).map(entry => entry.id));
    const warmupTurns = internalWarmupTurnIds(runtime.events, warmupInputIds, WEB_CHAT_WARMUP_TEXT);
    const summary = runtime.sessions.find(entry => entry.id === runtime.selectedId);
    const latestSummaryTerminalAt = Math.max(summary?.lastTurnEndAt ?? Number.NEGATIVE_INFINITY,
      summary?.lastAssistantFinalAt ?? Number.NEGATIVE_INFINITY);
    return [...warmupTurns].some(turnId => isInternalWarmupTurnOpen(runtime.events, turnId, latestSummaryTerminalAt));
  }

  function activityEvents(): SessionEvent[] {
    // A provider can omit the internal flag on later events in a warmup turn.
    // Filter by the turn's marked start and its warmup input ID before those
    // observations can be mistaken for the user's live answer.
    return withoutInternalWarmupEvents(runtime.events, composerInputs());
  }

  function completedThrough(): number | null {
    const session = runtime.sessions.find(entry => entry.id === runtime.selectedId);
    const terminalEvents = runtime.events.flatMap(event =>
      (event.kind === 'turn_end' && event.outcome !== 'unknown') ||
      (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) ||
      event.kind === 'chat_error' ? [event.time] : []);
    if (!session && !terminalEvents.length) return null;
    return Math.max(session?.lastTurnEndAt ?? 0, session?.lastAssistantFinalAt ?? 0, ...terminalEvents);
  }

  function hasSelectedAuthoredInputPending(): boolean {
    return selectedAuthoredInputPending(composerInputs(), runtime.selectedId,
      runtime.selectionGeneration, runtime.pendingNewInput, runtime.events, Date.now(), completedThrough());
  }

  function selectedTurnIsWorking(): boolean {
    // The row is presentation state and can outlive the provider snapshot
    // during navigation. Never let that stale class keep a Thinking indicator
    // alive after the selected chat no longer has a confirmed active turn.
    return getStateLine().working === true &&
      turnStatusLine.classList.contains('is-working') &&
      turnStatusLine.dataset.sessionId === (runtime.selectedId ?? '') &&
      turnStatusLine.dataset.selectionGeneration === String(runtime.selectionGeneration);
  }

  function deferredProgress() {
    const inputs = composerInputs();
    return warmupDeferredProgress(inputs, runtime.selectedId, runtime.selectionGeneration, runtime.events,
      { showQueued: true, completedThrough: completedThrough() }) ??
      projectAuthoredInputProgress(inputs, runtime.selectedId, selectedProjectId(), runtime.selectionGeneration,
        runtime.pendingNewInput, runtime.events, completedThrough());
  }

  function hasPendingAuthoredMessage(): boolean {
    const deferred = warmupDeferredEntries(composerInputs(), runtime.selectedId, runtime.selectionGeneration, completedThrough());
    return hasSelectedAuthoredInputPending() || deferredProgress() !== null ||
      preparation()?.phase === 'failed' && deferred.length > 0;
  }

  function suppressWarmupWithoutPendingMessage(): boolean {
    const hasAuthoredMessage = hasSelectedAuthoredInputPending() ||
      warmupDeferredEntries(composerInputs(), runtime.selectedId, runtime.selectionGeneration, completedThrough()).length > 0;
    return !hasAuthoredMessage && (preparation()?.phase === 'opening' || hasOpenInternalWarmupTurn());
  }

  // Prefer the current turn note, then active local tools, then a neutral thinking state.
  function liveActivity(): {
    text: string;
    icon: string;
    working: boolean;
    since?: number;
  } | null {
    const warmup = preparation();
    const preparationPhase = visibleWarmupPhase(warmup?.phase ?? null, hasPendingAuthoredMessage());
    if (preparationPhase === 'failed') return { text: t('Chat context not verified'), icon: '', working: false };
    const deferred = deferredProgress();
    if (preparationPhase === 'opening') return { text: t('Thinking…'), icon: 'thinking', working: false };
    if (deferred === 'thinking') return { text: t('Thinking…'), icon: 'thinking', working: false };
    const call =
      runningToolsFor === runtime.selectedId ? runningTools.at(-1) : undefined;
    if (call)
      return {
        text: call.title || t('Executing tool…'),
        icon: KIND_ICON[call.kind] ?? KIND_ICON.other,
        working: true,
        since: call.since,
      };
    const thinking = { text: t('Thinking…'), icon: 'thinking', working: false };
    // A pending message indicates work before its first event is recorded.
    if (hasSelectedAuthoredInputPending())
      return thinking;
    const events = activityEvents();
    let asked = Number.NEGATIVE_INFINITY;
    for (const event of events)
      if (event.kind === 'user_message') asked = Math.max(asked, event.time);
    let newest: SessionEvent | undefined;
    for (const event of events) {
      if (
        event.time < asked ||
        !['assistant_message', 'tool_call', 'page_tool', 'progress'].includes(
          event.kind,
        )
      )
        continue;
      if (!newest || event.time >= newest.time) newest = event;
    }
    const latestTerminalAt = events.reduce((latest, event) => {
      if (event.time < asked) return latest;
      const terminal = (event.kind === 'turn_end' && event.outcome !== 'unknown') ||
        (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) ||
        event.kind === 'chat_error';
      return terminal ? Math.max(latest, event.time) : latest;
    }, Number.NEGATIVE_INFINITY);
    // Errors and closed turns are terminal activity. They must not be
    // replaced by the generic Thinking label when the provider or control
    // snapshot is late to clear its active-turn state.
    if (latestTerminalAt !== Number.NEGATIVE_INFINITY &&
        (!newest || latestTerminalAt >= newest.time)) return null;
    if (newest?.kind === 'assistant_message' && proseMoving(newest))
      return null;
    if (newest?.kind === 'page_tool' && NATIVE_STEP_NOW.test(newest.label))
      return {
        text: newest.label,
        icon: 'i-globe',
        working: true,
        since: newest.time,
      };
    return thinking;
  }

  function paintTurnNow(): void {
    const isWorking = selectedTurnIsWorking();
    const hasPending = hasSelectedAuthoredInputPending() || deferredProgress() !== null;
    const warmup = preparation();
    const suppressWarmupActivity = suppressWarmupWithoutPendingMessage() ||
      shouldSuppressWarmupActivity(warmup, hasPendingAuthoredMessage());
    const now = suppressWarmupActivity ? null : isWorking || hasPending ? liveActivity() : null;
    const text = now?.text ?? '';
    const cue = now?.icon ?? '';
    if (now && turnNowIcon.dataset.icon !== cue) {
      turnNowIcon.dataset.icon = cue;
      turnNowIcon.replaceChildren(
        ...(cue === 'thinking' ? [turnNowSpinner] : cue ? [icon(cue)] : []),
      );
    }
    turnNow.classList.toggle('is-thinking', now?.icon === 'thinking');
    turnNow.classList.toggle('is-executing', now !== null && now.working);
    const showWarmupError = visibleWarmupPhase(warmup?.phase === 'failed' ? 'failed' : null, hasPendingAuthoredMessage()) === 'failed';
    turnNow.classList.toggle('is-error', showWarmupError);
    turnNowRetry.hidden = !showWarmupError;
    ui(turnNowRetry, 'textContent', () => t('Retry'));
    if (turnNow.dataset.text !== text) {
      turnNow.dataset.text = text;
      turnNowText.textContent = text;
      turnNowText.title = text;
    }
    const seconds =
      now?.since === undefined
        ? 0
        : Math.max(0, Math.floor((Date.now() - now.since) / 1000));
    // Show an elapsed clock only for steps that last at least three seconds.
    turnNowTime.textContent =
      seconds >= 3
        ? `${seconds >= 60 ? `${t('{0}m', [Math.floor(seconds / 60)])} ` : ''}${seconds % 60}s`
        : '';
    turnNow.hidden = !text;
  }

  // Refresh tool activity at most once per second and immediately after new events.
  function pollRunningTools(): void {
    const summary = runtime.sessions.find(
      (entry) => entry.id === runtime.selectedId,
    );
    const isWorking = selectedTurnIsWorking();
    const hasPending = hasSelectedAuthoredInputPending() || deferredProgress() !== null;
    if (!summary || (!isWorking && !hasPending)) {
      runningTools = [];
      return;
    }
    if (
      Date.now() - runningToolsAt < 900 &&
      runtime.events.length === runningToolsEvents
    )
      return;
    runningToolsAt = Date.now();
    runningToolsEvents = runtime.events.length;
    const conversationIds = [
      ...new Set(
        [summary.conversationId, ...summary.chatIds].filter(
          (id): id is string => !!id,
        ),
      ),
    ].slice(0, 16);
    if (!conversationIds.length) return;
    const request = ++runningToolsRequest,
      session = runtime.selectedId;
    void runtime.api.runningTools(conversationIds).then((reply) => {
      if (request !== runningToolsRequest || session !== runtime.selectedId)
        return;
      runningTools = reply.ok ? reply.data : [];
      runningToolsFor = session;
      paintTurnNow();
    });
  }

  // Creates a turn row with a dedicated label for the activity shimmer.
  function turnLine(className: string): HTMLElement {
    const line = el('div', className);
    line.append(el('span', 'turn-worked-label'));
    return line;
  }
  const workedLines = new Map<string, HTMLElement>();

  // Measures completed work from each user message to its corresponding final boundary.
  function exchangeDurations(
    list: readonly SessionEvent[],
  ): Map<number, number> {
    const asks = list
      .filter((event) => event.kind === 'user_message')
      .map((event) => event.time)
      .sort((a, b) => a - b);
    const durations = new Map<number, number>();
    asks.forEach((asked, index) => {
      const next = asks[index + 1] ?? Number.POSITIVE_INFINITY;
      let ended = -1;
      for (const event of list) {
        if (event.time < asked || event.time >= next) continue;
        if (
          (event.kind === 'turn_end' && event.outcome === 'completed') ||
          (event.kind === 'assistant_message' && event.final)
        ) {
          ended = Math.max(ended, event.time);
        }
      }
      if (ended >= asked)
        durations.set(asked, Math.floor((ended - asked) / 1000));
    });
    return durations;
  }

  function workedLine(asked: number, seconds: number): HTMLElement {
    const line = workedLines.get(String(asked)) ?? turnLine('turn-worked');
    ui(line.firstElementChild as HTMLElement, 'textContent', () =>
      t('{0} for {1}{2}s', [
        t('Worked'),
        seconds >= 60 ? `${t('{0}m', [Math.floor(seconds / 60)])} ` : '',
        seconds % 60,
      ]),
    );
    workedLines.set(String(asked), line);
    return line;
  }

  // Places live or completed duration rows beside their user messages.
  function placeTurnLines(
    rows: HTMLElement[],
    workedSeconds: ReadonlyMap<number, number>,
  ): void {
    const status = runtime.state()?.config.ui.developerMode
      ? null
      : getStateLine();
    const working = status?.working === true;
    turnWorking = working;
    const suppressWarmup = suppressWarmupWithoutPendingMessage() ||
      shouldSuppressWarmupActivity(preparation(), hasPendingAuthoredMessage());
    const deferred = deferredProgress();
    const asks = rows
      .map((row, index) => ({ row, index, asked: Number(row.dataset.askedAt) }))
      .filter(
        (entry) =>
          entry.row.matches('.ev-user_message') && Number.isFinite(entry.asked),
      );
    const pending = hasSelectedAuthoredInputPending() || deferredProgress() !== null;
    const used = new Set<string>();
    // Insert rows from the end to preserve earlier indices.
    for (let i = asks.length - 1; i >= 0; i--) {
      const { index, asked } = asks[i]!;
      const latest = i === asks.length - 1;
      if (latest && deferred) {
        rows.splice(index + 1, 0, turnNow);
        continue;
      }
      if (latest && working && !pending && !suppressWarmup) {
        rows.splice(index + 1, 0, turnStatusLine);
        rows.push(turnNow);
        continue;
      }
      const seconds = workedSeconds.get(asked);
      if (seconds === undefined || (latest && working)) continue;
      rows.splice(index + 1, 0, workedLine(asked, seconds));
      used.add(String(asked));
    }
    for (const key of workedLines.keys())
      if (!used.has(key)) workedLines.delete(key);
    const inTimeline = rows.includes(turnStatusLine);
    if (!inTimeline) parkTurnStatus(working);
    if (working && status) paintTurnStatus(status);
    $('chatState').classList.toggle(
      'is-mirrored',
      !runtime.state()?.config.ui.developerMode,
    );
  }

  // Parks the live status beside the pending message or latest timeline entry.
  function parkTurnStatus(working: boolean): void {
    const warmup = preparation();
    const deferred = deferredProgress();
    const pending = hasSelectedAuthoredInputPending() || deferredProgress() !== null;
    if (!working) {
      turnStatusLine.remove();
      turnStatusLine.classList.remove('is-working');
      delete turnStatusLine.dataset.sessionId;
      delete turnStatusLine.dataset.selectionGeneration;
      turnWorking = false;
      if (pending) {
        const latestMessage = runtime.detailFor === runtime.selectedId && runtime.selectedId !== null
          ? [...$('timeline').querySelectorAll<HTMLElement>('.ev-user_message')].at(-1)
          : undefined;
        if (latestMessage) latestMessage.after(turnNow);
        else $('inputQueue').after(turnNow);
      } else {
        turnNow.remove();
      }
      paintTurnNow();
      return;
    }
    if (suppressWarmupWithoutPendingMessage()) {
      turnStatusLine.remove();
      turnNow.remove();
      paintTurnNow();
      return;
    }
    if (deferred) {
      turnStatusLine.remove();
      const latestMessage = runtime.detailFor === runtime.selectedId && runtime.selectedId !== null
        ? [...$('timeline').querySelectorAll<HTMLElement>('.ev-user_message')].at(-1)
        : undefined;
      if (latestMessage) latestMessage.after(turnNow);
      else turnNow.remove();
      paintTurnNow();
      return;
    }
    if (shouldSuppressWarmupActivity(warmup, hasPendingAuthoredMessage())) {
      turnStatusLine.remove();
      turnNow.remove();
      paintTurnNow();
      return;
    }
    if (warmup?.phase === 'opening' && hasPendingAuthoredMessage()) {
      turnStatusLine.remove();
      $('inputQueue').after(turnNow);
      paintTurnNow();
      return;
    }
    const latestMessage =
      runtime.detailFor === runtime.selectedId && runtime.selectedId !== null
        ? [
            ...$('timeline').querySelectorAll<HTMLElement>('.ev-user_message'),
          ].at(-1)
        : undefined;
    if (working && !pending && latestMessage) {
      latestMessage.after(turnStatusLine);
      $('timeline').append(turnNow);
    } else if (working || pending)
      $('inputQueue').after(turnStatusLine, turnNow);
    else {
      // A turn can be stopped before its terminal event is written. Remove its
      // old live row even when it was previously anchored inside the timeline.
      turnStatusLine.remove();
      turnNow.remove();
    }
    paintTurnNow();
  }

  function paintTurnStatus(status: ProgressStatus): void {
    turnStatusLine.dataset.sessionId = runtime.selectedId ?? '';
    turnStatusLine.dataset.selectionGeneration = String(runtime.selectionGeneration);
    ui(
      turnStatusLine.firstElementChild as HTMLElement,
      'textContent',
      () => getStateLine().text,
    );
    turnStatusLine.classList.toggle('is-working', status.working === true);
    paintTurnNow();
    pollRunningTools();
  }
  return {
    hasStatusInTimeline: () => turnStatusLine.closest('#timeline') !== null,
    suppressWarmupWithoutPendingMessage,
    get turnNow() {
      return turnNow;
    },
    get turnWorking() {
      return turnWorking;
    },
    parkTurnStatus,
    placeTurnLines,
    exchangeDurations,
    paintTurnStatus,
  };
}
