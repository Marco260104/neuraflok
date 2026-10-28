import { ui, t } from '../../shared/i18n.js';
import { applyChatModels, observedComposerModel } from './chat-models.js';
import { createChatSessionNavigationComposition } from './chat-session-navigation-composition.js';
import { createChatProjectControls } from './chat-project-controls.js';
import { createChatProgress } from './chat-progress.js';
import { createChatTimelineHistory } from './chat-timeline-history.js';
import { createChatSettings } from './chat-settings.js';
import { imageDrafts } from './chat-composer-attachments.js';
import { paintContextMeter } from './context-meter.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';
import { $, run, toast } from '../../shared/dom.js';
import { createChatComposerComposition } from './chat-composer-composition.js';

export function createChatFeatureComposition(bindings: typeof import('./chat-orchestrator.js').chatRuntimeBindings) {
  let chatSessionList: ReturnType<typeof createChatSessionNavigationComposition>['chatSessionList'];
  // Gives the session list its shared state, UI helpers, and owner actions.
  const chatProgressRuntime = {
    api: bindings.api,
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get controlledSessionId() { return bindings.controlledSessionId; },
    get controlledSelection() { return bindings.controlledSelection; },
    get controlledTurnId() { return bindings.controlledTurnId; },
    get goalWaitView() { return bindings.goalWaitView; },
    get events() { return bindings.events; },
    get startingInputs() { return bindings.startingInputs; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    get sessions() { return bindings.sessions; },
    get detailFor() { return bindings.detailFor; },
    get swarm() { return bindings.swarm; },
    get durationTimer() { return bindings.durationTimer; },
    set durationTimer(value: typeof bindings.durationTimer) { bindings.durationTimer = value; },
    get visible() { return bindings.visible; },
    get badgeKey() { return bindings.badgeKey; },
    set badgeKey(value: typeof bindings.badgeKey) { bindings.badgeKey = value; },
    state: () => bindings.deps.state(),
    sessionBadges: bindings.sessionBadges,
    paintSessions: () => chatSessionList.paintSessions(),
    paintRecoveryStatus: bindings.paintRecoveryStatus,
    paintGoalProgress: bindings.paintGoalProgress
  };

  const chatProgress = createChatProgress(chatProgressRuntime);

  const chatTimelineHistoryRuntime = {
    api: bindings.api,
    run,
    get sessions() { return bindings.sessions; },
    get visible() { return bindings.visible; },
    get selectedId() { return bindings.selectedId; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get detailFor() { return bindings.detailFor; },
    set detailFor(value: typeof bindings.detailFor) { bindings.detailFor = value; },
    get events() { return bindings.events; },
    set events(value: typeof bindings.events) { bindings.events = value; },
    get detailCursor() { return bindings.detailCursor; },
    set detailCursor(value: typeof bindings.detailCursor) { bindings.detailCursor = value; },
    get detailLoadGeneration() { return bindings.detailLoadGeneration; },
    set detailLoadGeneration(value: number) { bindings.detailLoadGeneration = value; },
    get handoffLoadGeneration() { return bindings.handoffLoadGeneration; },
    set handoffLoadGeneration(value: number) { bindings.handoffLoadGeneration = value; },
    get totalEvents() { return bindings.totalEvents; },
    set totalEvents(value: number) { bindings.totalEvents = value; },
    get detailStamp() { return bindings.detailStamp; },
    set detailStamp(value: typeof bindings.detailStamp) { bindings.detailStamp = value; },
    get roundsEnter() { return bindings.roundsEnter; },
    set roundsEnter(value: boolean) { bindings.roundsEnter = value; },
    get sidebarCompletion() { return bindings.sidebarCompletion; },
    get historyBefore() { return bindings.historyBefore; },
    set historyBefore(value: typeof bindings.historyBefore) { bindings.historyBefore = value; },
    get historyStart() { return bindings.historyStart; },
    set historyStart(value: typeof bindings.historyStart) { bindings.historyStart = value; },
    get historyDemand() { return bindings.historyDemand; },
    set historyDemand(value: typeof bindings.historyDemand) { bindings.historyDemand = value; },
    get historyLoading() { return bindings.historyLoading; },
    set historyLoading(value: typeof bindings.historyLoading) { bindings.historyLoading = value; },
    get historyRefreshPending() { return bindings.historyRefreshPending; },
    set historyRefreshPending(value: typeof bindings.historyRefreshPending) { bindings.historyRefreshPending = value; },
    get agentFilter() { return bindings.agentFilter; },
    set agentFilter(value: typeof bindings.agentFilter) { bindings.agentFilter = value; },
    get filterFor() { return bindings.filterFor; },
    set filterFor(value: typeof bindings.filterFor) { bindings.filterFor = value; },
    UNATTRIBUTED: bindings.UNATTRIBUTED,
    MAX_TIMELINE_ROWS: bindings.MAX_TIMELINE_ROWS,
    TIMELINE_BATCH_SIZE: bindings.TIMELINE_BATCH_SIZE,
    timelineShown: bindings.timelineShown,
    timelineItems: bindings.timelineItems,
    itemKey: bindings.itemKey,
    refreshSessionControls: bindings.refreshSessionControls,
    paintDetail: bindings.paintDetail,
    paintSessions: () => chatSessionList.paintSessions(),
    loadHandoff: () => bindings.chatRecoveryView.loadHandoff(),
    state: () => bindings.deps.state()
  };

  const chatTimelineHistory = createChatTimelineHistory(chatTimelineHistoryRuntime);

  const composer = createChatComposerComposition(bindings, {
    mergeSessionRows: rows => chatSessionList.mergeSessionRows(rows),
    parkTurnStatus: working => chatProgress.parkTurnStatus(working),
    turnWorking: () => chatProgress.turnWorking
  });

  const sessionNavigation = createChatSessionNavigationComposition(bindings);
  const {
    chatSessionRowRuntime,
    chatSessionRows,
    chatSessionListRuntime,
    chatSessionList: initializedSessionList,
    loadSessions,
    maybePageSessions,
    projectSortEntries,
    paintSessions
  } = sessionNavigation;
  chatSessionList = initializedSessionList;

  const chatSettingsRuntime = {
    get visible() { return bindings.visible; },
    get selectedId() { return bindings.selectedId; },
    get sessions() { return bindings.sessions; },
    refreshSessionControls: bindings.refreshSessionControls,
    paintContextMeter,
    observedComposerModel,
    applyChatModels,
    paintSessions,
    paintAutomationSwitch: bindings.paintAutomationSwitch
  };

  const chatSettings = createChatSettings(chatSettingsRuntime);

  const chatProjectControlsRuntime = {
    api: bindings.api,
    run,
    toast,
    t,
    ui,
    $,
    get projects() { return bindings.projects; },
    set projects(value: LocalProject[]) { bindings.projects = value; },
    get sessions() { return bindings.sessions; },
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    set selectedProjectId(value: string | null) { bindings.selectedProjectId = value; },
    get newChatSelected() { return bindings.newChatSelected; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    set selectionGeneration(value: number) { bindings.selectionGeneration = value; },
    get sessionsLoadGeneration() { return bindings.sessionsLoadGeneration; },
    set sessionsLoadGeneration(value: number) { bindings.sessionsLoadGeneration = value; },
    expandedProjects: bindings.expandedProjects,
    projectVisibleCounts: bindings.projectVisibleCounts,
    draftKey: bindings.draftKey,
    authoredComposerText: bindings.authoredComposerText,
    replaceComposerDraft: bindings.replaceComposerDraft,
    get inputDrafts() { return bindings.drafts().inputDrafts; },
    get newChatTasks() { return bindings.drafts().newChatTasks; },
    get imageDrafts() { return imageDrafts; },
    restoreSkills: () => bindings.skillPicker?.restore(),
    paintSessions: () => chatSessionList.paintSessions(),
    refreshInputQueue: () => bindings.refreshInputQueue()
  };

  bindings.chatProjectControls = createChatProjectControls(chatProjectControlsRuntime);

  return {
    chatProgressRuntime,
    chatProgress,
    chatTimelineHistoryRuntime,
    chatTimelineHistory,
    ...composer,
    chatSessionRowRuntime,
    chatSessionRows,
    chatSessionListRuntime,
    chatSessionList,
    loadSessions,
    maybePageSessions,
    projectSortEntries,
    paintSessions,
    chatSettingsRuntime,
    chatSettings,
    chatProjectControlsRuntime,
  };
}
