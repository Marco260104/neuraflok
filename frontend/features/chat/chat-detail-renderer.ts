import { answerAnchors } from '../../../contracts/markdown-export.js';
import { TURN_OUTCOME_LABELS, type ReasoningEffort, type SessionEvent, type SessionSummary, type TokenPressure } from '../../../contracts/session.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { AppState } from '../../../contracts/types.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';
import { optimisticProjectInputEvents, optimisticWarmupEvents, type PendingNewProjectInput } from './chat-warmup-inputs.js';
import { foldAgentCommunication, participatingWorkers } from '../agents/agent-communication.js';
import { $, compactNumber } from '../../shared/dom.js';
import { currentLanguage, t, ui } from '../../shared/i18n.js';
import { chatErrorPresentation, duplicateChatErrors } from './chat-error.js';
import { preserveTimelineViewport } from './timeline-scroll.js';
import type { CompactionBlock, TimelineItem, createTimelinePresentation } from './timeline-presentation.js';

export interface ChatDetailRendererRuntime {
  sessions: SessionSummary[];
  selectedId: string | null;
  startingInputs: Map<string, InputEntry>;
  pendingComposerInputs: InputEntry[];
  events: SessionEvent[];
  historyBefore: number | null;
  detailFor: string | null;
  totalEvents: number;
  agentFilter: string | null;
  rowCache: Map<string, { sig: string; row: HTMLElement }>;
  toolGroups: Map<string, HTMLElement>;
  selectionGeneration: number;
  pendingNewInput: PendingNewProjectInput | null;
  state: () => AppState | null;
  paintStateLine: () => void;
  paintBackgroundProcesses: () => void;
  applyComposerSessionModel: typeof import('./chat-models.js').applyComposerSessionModel;
  composerSessionSelection: (summary: SessionSummary | null | undefined) => { model: string; reasoningEffort?: ReasoningEffort; observedAt: number } | null | undefined;
  paintContextMeter: typeof import('./context-meter.js').paintContextMeter;
  paintDeliveryControls: () => void;
  paintAgentFilter: () => void;
  visibleEvents: () => SessionEvent[];
  readingAfterSend: boolean;
  followOutput: () => boolean;
  readerAtEnd: boolean;
  paintRecoveryStatus: () => boolean;
  historicalAutomaticInput: (entry: InputEntry) => boolean;
  dismissedInputNotices: Set<string>;
  inputMessageRow: (entry: InputEntry, notice: boolean) => HTMLElement;
  exchangeDurations: (events: readonly SessionEvent[]) => Map<number, number>;
  timelineItems: (source: SessionEvent[]) => TimelineItem[];
  observedComposerModel: typeof import('./chat-models.js').observedComposerModel;
  itemKey: (item: TimelineItem) => string;
  itemSignature: (item: TimelineItem) => string;
  stoppedTurnEnd: (event: SessionEvent, history: readonly SessionEvent[]) => boolean;
  paintMessageReaction: (box: HTMLElement, value: unknown) => void;
  paintInputReceipt: (row: HTMLElement, item: TimelineItem) => void;
  rowEvents: WeakMap<HTMLElement, SessionEvent>;
  compactionRow: (block: CompactionBlock, previous?: HTMLElement) => HTMLElement;
  eventRow: (event: SessionEvent) => HTMLElement;
  answerActions: (turnId: string) => HTMLElement;
  placeTurnLines: (rows: HTMLElement[], workedSeconds: ReadonlyMap<number, number>) => void;
  reconcileChildren: (parent: Element, children: HTMLElement[]) => void;
  groupImageRows: (rows: HTMLElement[]) => HTMLElement[];
  renderRounds: ReturnType<typeof createTimelinePresentation>['renderRounds'];
  turnWorking: boolean;
  setRoundsEnter: (value: boolean) => void;
  paintPendingInputs: () => void;
  timelineShown: () => boolean;
  holdSentMessage: () => boolean;
  paintJumpLatest: () => void;
  UNATTRIBUTED: string;
  pressureOf: (id: string) => TokenPressure | null;
  selectedLocalProject: () => LocalProject | null;
}

type Runtime = ChatDetailRendererRuntime;

export function createChatDetailRenderer(runtime: Runtime) {
  function paintDetail(followBottom = runtime.historyBefore === null): void {
    const {
      sessions,
      selectedId,
      startingInputs,
      pendingComposerInputs,
      events,
      historyBefore,
      detailFor,
      totalEvents,
      agentFilter,
      rowCache,
      toolGroups,
    } = runtime;
    runtime.paintStateLine();
    runtime.paintBackgroundProcesses();
    const summary = sessions.find((session) => session.id === selectedId) ?? null;
    runtime.applyComposerSessionModel(selectedId ? `${selectedId}:${runtime.selectionGeneration}` : null,
      runtime.composerSessionSelection(summary) ?? null);
    const config = runtime.state()?.config;
    if (config) runtime.paintContextMeter(summary, config, runtime.observedComposerModel());
    const project = runtime.selectedLocalProject();
    const projectPill = document.getElementById('chatProjectContext') ?? document.getElementById('composerProjectPill');
    if (projectPill) projectPill.hidden = !project;
    const projectName = document.getElementById('chatProjectName');
    if (projectName) projectName.textContent = project?.name ?? '';
    $<HTMLButtonElement>('composerFiles').disabled = !project;
    ui($('composerFiles'), 'title', () => project ? t('Files · {0}', [project.name]) : t('Open a project to use Files and Review'));
    ui($('chatTitle'), 'textContent', () => summary ? summary.title || t('Untitled session') : t('New chat'));

    runtime.paintDeliveryControls();
    runtime.paintAgentFilter();
    if (selectedId !== null && detailFor !== selectedId) {
      $('inputQueue').setAttribute('inert', '');
      $('timelineEmpty').hidden = true;
      $('chatFoot').hidden = true;
      return;
    }
    $('timeline').removeAttribute('inert');
    $('timeline').removeAttribute('aria-busy');
    $('inputQueue').removeAttribute('inert');
    const filtered = runtime.visibleEvents();
    const authoredInputs = [...startingInputs.values(), ...pendingComposerInputs];
    const optimistic = [
      ...optimisticWarmupEvents(events, authoredInputs, selectedId, runtime.selectionGeneration),
      ...optimisticProjectInputEvents(events, authoredInputs, selectedId, summary?.projectId ?? project?.id ?? null,
        runtime.selectionGeneration, runtime.pendingNewInput),
    ];
    const shown = foldAgentCommunication([...filtered, ...optimistic]);
    const pane = $('chatBody');
    const restoreViewport = preserveTimelineViewport(pane, $('timelineContent'), followBottom && !runtime.readingAfterSend,
      runtime.followOutput() ? runtime.readerAtEnd : undefined);
    const timelineRows: HTMLElement[] = [];
    const keep = new Set<string>();
    runtime.paintRecoveryStatus();
    const oldest = shown.length ? Math.min(...shown.map(event => event.time)) : 0;
    const newest = shown.length ? Math.max(...shown.map(event => event.time)) : 0;
    const retiredInputs = pendingComposerInputs.filter(entry => runtime.historicalAutomaticInput(entry) &&
      (entry.sessionId ?? entry.deliveredSessionId) === selectedId && !runtime.dismissedInputNotices.has(entry.id) &&
      agentFilter === null && entry.createdAt >= oldest && (historyBefore === null || entry.createdAt <= newest))
      .sort((left, right) => left.createdAt - right.createdAt);
    const appendRetiredInputs = (until: number): void => {
      while (retiredInputs.length && retiredInputs[0]!.createdAt <= until) {
        const entry = retiredInputs.shift()!;
        const key = `retired-input:${entry.id}`;
        const sig = JSON.stringify([entry.text, entry.error, entry.createdAt]);
        keep.add(key);
        const cached = rowCache.get(key);
        const row = cached?.sig === sig ? cached.row : runtime.inputMessageRow(entry, true);
        if (row !== cached?.row) {
          const time = document.createElement('time');
          time.textContent = new Date(entry.createdAt).toLocaleString(currentLanguage());
          row.prepend(time);
        }
        row.dataset.timelineKey = key;
        rowCache.set(key, { sig, row });
        timelineRows.push(row);
      }
    };
    const duplicateErrors = duplicateChatErrors(events);
    const anchors = answerAnchors(events);
    const workedSeconds = runtime.exchangeDurations(events);
    const workers = sessions.filter(entry => entry.origin?.kind === 'worker' && entry.origin.fromSessionId === selectedId && selectedId !== null);
    for (const item of runtime.timelineItems(shown)) {
      if (item.kind === 'event' && duplicateErrors.has(item.event.seq)) continue;
      appendRetiredInputs(item.kind === 'event' ? item.event.time : item.block.time);
      if (!runtime.state()?.config.ui.developerMode && item.kind === 'event' && item.event.source === 'app' &&
          item.event.kind === 'progress' && item.event.progressId?.startsWith('browser-repair:')) continue;
      if (!runtime.state()?.config.ui.developerMode && item.kind === 'event' &&
          ['session_start', 'session_end', 'turn_start', 'turn_end', 'note'].includes(item.event.kind) &&
          !runtime.stoppedTurnEnd(item.event, events)) continue;
      const key = runtime.itemKey(item);
      const answerTurn = item.kind === 'event' && item.event.kind === 'assistant_message' && item.event.turnId &&
        anchors.get(item.event.turnId) === item.event.seq ? item.event.turnId : null;
      const sig = runtime.itemSignature(item) + (item.kind === 'event' && item.event.kind === 'chat_error'
        ? JSON.stringify(chatErrorPresentation(item.event, events)) : '') + (answerTurn ? '\u0000answer' : '') +
        (item.kind === 'event' && runtime.stoppedTurnEnd(item.event, events) ? '\u0000stopped' : '');
      keep.add(key);
      const cached = rowCache.get(key);
      const workerIds = JSON.stringify(item.kind === 'event' ? participatingWorkers(item.event, workers).map(worker => worker.id) : []);
      if (cached && cached.sig === sig) {
        cached.row.dataset.workerSessions = workerIds;
        if (item.kind === 'event' && item.event.kind === 'user_message') cached.row.dataset.askedAt = String(item.event.time);
        if (item.kind === 'event' && item.event.kind === 'user_message')
          runtime.paintMessageReaction(cached.row.querySelector<HTMLElement>('.said.is-user')!, item.event.reaction);
        runtime.paintInputReceipt(cached.row, item);
        if (item.kind === 'event') runtime.rowEvents.set(cached.row, item.event);
        timelineRows.push(cached.row);
        continue;
      }
      const row = item.kind === 'compaction' ? runtime.compactionRow(item.block, cached?.row) : runtime.eventRow(item.event);
      if (answerTurn) row.querySelector('.said')?.append(runtime.answerActions(answerTurn));
      row.dataset.timelineKey = key;
      row.dataset.workerSessions = workerIds;
      if (item.kind === 'event' && item.event.kind === 'user_message') row.dataset.askedAt = String(item.event.time);
      runtime.paintInputReceipt(row, item);
      if (item.kind === 'event') runtime.rowEvents.set(row, item.event);
      rowCache.set(key, { sig, row });
      timelineRows.push(row);
    }
    appendRetiredInputs(Infinity);
    for (const key of rowCache.keys()) if (!keep.has(key)) rowCache.delete(key);
    runtime.placeTurnLines(timelineRows, workedSeconds);
    runtime.reconcileChildren($('timeline'), runtime.groupImageRows(runtime.renderRounds(timelineRows,
      runtime.turnWorking, selectedId, toolGroups, true)));
    runtime.setRoundsEnter(timelineRows.length > 0);
    runtime.paintPendingInputs();
    $('timelineEmpty').hidden = timelineRows.length > 0 || $('inputQueue').childElementCount > 0;
    if (runtime.timelineShown() && !runtime.holdSentMessage()) restoreViewport();
    runtime.paintJumpLatest();

    const facts: string[] = [];
    if (summary) {
      facts.push(t(totalEvents === 1 ? '{0} event' : '{0} events', [totalEvents]));
      if (events.length < totalEvents) facts.push(t('showing a bounded page of {0}', [events.length]));
      if (agentFilter !== null)
        facts.push(t('filtered to {0} — {1} matched', [agentFilter === runtime.UNATTRIBUTED ? 'unattributed' : agentFilter, filtered.length]));
      facts.push(t('~{0} rough current-chat context tokens', [compactNumber(summary.contextTokens)]));
      const level = runtime.pressureOf(summary.id);
      if (level && level.level !== 'ok')
        facts.push(level.level === 'huge' ? t('past the compaction threshold — compact before continuing') : t('large — compaction is worth doing soon'));
      if (summary.lastTurnOutcome && summary.lastTurnOutcome !== 'completed')
        facts.push(t('last turn {0}', [t(TURN_OUTCOME_LABELS[summary.lastTurnOutcome])]));
    }
    $('chatFoot').textContent = facts.join(' · ');
    $('chatFoot').hidden = !runtime.state()?.config.ui.developerMode;
    $('chatFoot').classList.toggle('is-warn', runtime.pressureOf(selectedId ?? '')?.level === 'huge');
  }

  return { paintDetail };
}
