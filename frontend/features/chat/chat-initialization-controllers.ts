import type { ChatInitializationBindings } from './chat.js';
import type { SessionEvent } from '../../../contracts/session.js';
import { createChatSearchNavigation } from './chat-search-navigation.js';
import { ui, t } from '../../shared/i18n.js';
import { applyComposerSessionModel } from './chat-models.js';
import { createChatEventRenderer } from './chat-event-renderer.js';
import { createTimelinePresentation } from './timeline-presentation.js';
import { createChatNavigation } from './chat-navigation.js';
import { canonicalMessageKey } from './chat-timeline-history.js';
import { createChatComposerAttachments } from './chat-composer-attachments.js';
import { createChatReaderState } from './chat-reader-state.js';
import { createSidebarOrder } from './sidebar/order.js';
import { createSidebarPins, pinnedSortScope } from './sidebar/pins.js';
import { createSidebarCompletionState } from './sidebar/completion-state.js';
import { $, el, icon, run, setIcon, toast } from '../../shared/dom.js';

export function initializeChatControllers(bindings: ChatInitializationBindings): void {  bindings.chatSearchNavigation = createChatSearchNavigation({
    api: bindings.api,
    get selectedId() {
      return bindings.selectedId;
    },
    get selectionGeneration() {
      return bindings.selectionGeneration;
    },
    get events() {
      return bindings.events;
    },
    set events(value: SessionEvent[]) {
      bindings.events = value;
    },
    get historyLoading() {
      return bindings.historyLoading;
    },
    get historyDemand() {
      return bindings.historyDemand;
    },
    get detailFor() {
      return bindings.detailFor;
    },
    set detailFor(value: string | null) {
      bindings.detailFor = value;
    },
    get historyBefore() {
      return bindings.historyBefore;
    },
    set historyBefore(value: number | null) {
      bindings.historyBefore = value;
    },
    get historyStart() {
      return bindings.historyStart;
    },
    set historyStart(value: number | null) {
      bindings.historyStart = value;
    },
    batchSize: bindings.TIMELINE_BATCH_SIZE,
    itemKey: event => bindings.itemKey({
      kind: 'event',
      event
    }),
    loadDetail: bindings.loadDetail,
    readTimeline: bindings.readTimeline
  });
  bindings.chatReaderState = createChatReaderState({
    selectedId: () => bindings.selectedId,
    pendingComposerInputs: () => bindings.pendingComposerInputs,
    events: () => bindings.events,
    historyBefore: () => bindings.historyBefore,
    detailCursor: () => bindings.detailCursor,
    setHistoryBefore: value => {
      bindings.historyBefore = value;
    },
    setDetailFor: value => {
      bindings.detailFor = value;
    },
    loadDetail: () => {
      void bindings.loadDetail();
    }
  });
  bindings.chatEventRenderer = createChatEventRenderer({
    $,
    el,
    icon,
    run,
    setIcon,
    toast,
    t,
    ui,
    api: bindings.api,
    selectedLocalProject: bindings.selectedLocalProject,
    get sessions() {
      return bindings.sessions;
    },
    get selectedId() {
      return bindings.selectedId;
    },
    get selectionGeneration() {
      return bindings.selectionGeneration;
    },
    get events() {
      return bindings.events;
    },
    get startingInputs() {
      return bindings.startingInputs;
    },
    get pendingComposerInputs() {
      return bindings.pendingComposerInputs;
    },
    loadDetail: bindings.loadDetail,
    refreshInputQueue: bindings.refreshInputQueue,
    openTools: bindings.openTools,
    openReview: async (projectId, sessionId, callId, indices) => {
      const opened = await bindings.reviewPanel?.openReview(projectId, sessionId, callId, indices);
      if (!opened) toast(t('Recorded edit is unavailable.'));
      return !!opened;
    },
    openWorkerChat: id => {
      void bindings.agentPanel?.open(id);
    }
  });
  bindings.chatComposerAttachments = createChatComposerAttachments({
    api: bindings.api,
    draftKey: bindings.draftKey,
    owner: bindings.composerDraftOwner,
    ownsOwner: bindings.ownsComposerDraft,
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    get sessions() { return bindings.sessions; },
    set sessions(value) { bindings.sessions = value; },
    inputDrafts: bindings.chatDraftState!.inputDrafts,
    authoredComposerText: bindings.authoredComposerText,
    selectSession: bindings.selectSession,
    paintSessions: bindings.paintSessions,
    run,
    attachmentCard: bindings.attachmentCard,
    paintDeliveryControls: bindings.paintDeliveryControls
  });
  bindings.timelinePresentation = createTimelinePresentation({
    el,
    icon,
    ui,
    t,
    get selectedId() {
      return bindings.selectedId;
    },
    get selectionGeneration() {
      return bindings.selectionGeneration;
    },
    get sessions() {
      return bindings.sessions;
    },
    get events() {
      return bindings.events;
    },
    get roundsEnter() {
      return bindings.roundsEnter;
    },
    canonicalMessageKey,
    openTools: bindings.openTools,
    rowEvents: bindings.rowEvents,
    turnNow: bindings.chatProgress.turnNow,
    eventBody: (event, context) => bindings.eventBody(event, context),
    retainedInputImages: (event, sessionId) => bindings.retainedInputImages(event, sessionId),
    showWorkers: (ids, focus) => {
      bindings.agentPanel?.showWorkers(ids, focus);
    },
    readTimeline: bindings.readTimeline,
    paintJumpLatest: bindings.paintJumpLatest
  });
  bindings.sidebarCompletion = createSidebarCompletionState();
  bindings.sidebarPins = createSidebarPins();
  bindings.sidebarOrder = createSidebarOrder($('sessionList'), () => [...bindings.projectSortEntries(), ...bindings.sessions.filter(entry => (entry.conversationId || entry.origin?.kind === 'desktop') && entry.origin?.kind !== 'worker').map(entry => ({
    id: entry.id,
    scope: pinnedSortScope(bindings.projectGroup(entry.projectId) ?? '', bindings.pinnedChat(entry))
  }))], bindings.paintSessions);
  bindings.chatNavigation = createChatNavigation({
    get sessions() {
      return bindings.sessions;
    },
    get projects() {
      return bindings.projects;
    },
    get selectedId() {
      return bindings.selectedId;
    },
    set selectedId(value: string | null) {
      bindings.selectedId = value;
    },
    get selectedProjectId() {
      return bindings.selectedProjectId;
    },
    set selectedProjectId(value: string | null) {
      bindings.selectedProjectId = value;
    },
    get newChatSelected() {
      return bindings.newChatSelected;
    },
    set newChatSelected(value: boolean) {
      bindings.newChatSelected = value;
    },
    get selectionGeneration() {
      return bindings.selectionGeneration;
    },
    set selectionGeneration(value: number) {
      bindings.selectionGeneration = value;
    },
    get inputQueueGeneration() {
      return bindings.inputQueueGeneration;
    },
    set inputQueueGeneration(value: number) {
      bindings.inputQueueGeneration = value;
    },
    get readerAtEnd() {
      return bindings.chatReader().readerAtEnd;
    },
    get hasSendAnchor() {
      return bindings.chatReader().sendAnchor !== null;
    },
    get readingAfterSend() {
      return bindings.chatReader().readingAfterSend;
    },
    expandedProjects: bindings.expandedProjects,
    expandedWorkers: bindings.expandedWorkers,
    rememberDraft: bindings.rememberDraft,
    replaceComposerDraft: bindings.replaceComposerDraft,
    resetComposerQueue() {
      $('finishQueue').replaceChildren();
      $('finishQueue').hidden = true;
    },
    resetTimelineOwner() {
      bindings.chatReader().sendAnchor = null;
      bindings.chatReader().readingAfterSend = false;
      bindings.chatReader().readerAtEnd = true;
      bindings.events = [];
      bindings.totalEvents = 0;
      bindings.historyBefore = null;
      bindings.detailFor = null;
      bindings.detailCursor = null;
      bindings.forgetTimelineRows();
      bindings.handoff = null;
      bindings.handoffFor = null;
      bindings.handoffLoadGeneration++;
    },
    resetNewChatTimeline() {
      bindings.detailFor = null;
      bindings.detailCursor = null;
      bindings.chatReader().sendAnchor = null;
      bindings.chatReader().readingAfterSend = false;
      bindings.chatReader().readerAtEnd = true;
    },
    clearPendingNewInput() {
      bindings.pendingNewInput = null;
    },
    refreshBackgroundProcesses: bindings.refreshBackgroundProcesses,
    applySessionModel(id, summary, generation) {
      applyComposerSessionModel(`${id}:${generation}`, bindings.composerSessionSelection(summary) ?? null);
    },
    applyNewChatModel() {
      applyComposerSessionModel(null, null);
    },
    projectGroup: bindings.projectGroup,
    restoreDraft: bindings.restoreDraft,
    timelineShown: bindings.timelineShown,
    paintJumpLatest: bindings.paintJumpLatest,
    paintSessions: () => bindings.chatSessionList.paintSessions(),
    paintAutomationSwitch: bindings.paintAutomationSwitch,
    paintDetail: bindings.paintDetail,
    paintHandoff: bindings.paintHandoff,
    loadDetail: () => {
      void bindings.loadDetail();
    },
    refreshInputQueue: () => {
      void bindings.refreshInputQueue();
    },
    stopProjectTurn: async (sessionId, previousProjectId) => {
      const controls = await run(bindings.api.getSessionControls(sessionId));
      if (!controls?.activeTurnId || bindings.selectedProjectId === previousProjectId) return;
      await run(bindings.api.stopSessionTurn(sessionId, controls.activeTurnId));
    }
  });
}
