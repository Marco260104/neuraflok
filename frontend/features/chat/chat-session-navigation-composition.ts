import { $, disclosureChevron, el, icon, run } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { createChatSessionList, type ChatSessionListRuntime } from './chat-session-list.js';
import { createChatSessionRow } from './chat-session-row.js';
import { openRowMenu, rowMenuOpenFor, toggleRowMenu } from './row-menu.js';
import { SIDEBAR_PROJECT_SCOPE } from './sidebar/order-preferences.js';
import { pinnedSortScope } from './sidebar/pins.js';

export function createChatSessionNavigationComposition(
  bindings: typeof import('./chat-orchestrator.js').chatRuntimeBindings,
  suppressWarmupWithoutPendingMessage: () => boolean = () => false,
) {
  let chatSessionList: ReturnType<typeof createChatSessionList>;
  const chatSessionRowRuntime = {
    get selectedId() { return bindings.selectedId; },
    get activeId() { return bindings.activeId; },
    get blockedChats() { return bindings.blockedChats; },
    get trustedChats() { return bindings.trustedChats; },
    get swarm() { return bindings.swarm; },
    get renaming() { return bindings.renaming; },
    set renaming(value: typeof bindings.renaming) { bindings.renaming = value; },
    state: () => bindings.deps.state(),
    sessionWorking: bindings.sessionWorking,
    suppressWarmupActivity: (summary: SessionSummary) =>
      summary.id === bindings.selectedId && suppressWarmupWithoutPendingMessage(),
    isUnseen: (summary: SessionSummary) => bindings.sidebarCompletion?.isUnseen(summary) ?? false,
    pinnable: bindings.pinnable,
    pinnedChat: bindings.pinnedChat,
    get sidebarPins() { return bindings.sidebarPins; },
    paintSessions: () => chatSessionList.paintSessions(),
    rowMenuButton: bindings.rowMenuButton,
    openRowMenu,
    rowMenuOpenFor,
    toggleRowMenu,
    ...bindings.chatSessionActions,
    loadSessions: (detail?: 'reread' | 'changed') => chatSessionList.loadSessions(detail)
  };

  const chatSessionRows = createChatSessionRow(chatSessionRowRuntime);

  const chatSessionListRuntime: ChatSessionListRuntime = {
    state: {
      get agentPanel() { return bindings.agentPanel; },
      get activeId() { return bindings.activeId; },
      set activeId(value: typeof bindings.activeId) { bindings.activeId = value; },
      get badgeKey() { return bindings.badgeKey; },
      set badgeKey(value: typeof bindings.badgeKey) { bindings.badgeKey = value; },
      get blockedChats() { return bindings.blockedChats; },
      set blockedChats(value: typeof bindings.blockedChats) { bindings.blockedChats = value; },
      get detailCursor() { return bindings.detailCursor; },
      set detailCursor(value: typeof bindings.detailCursor) { bindings.detailCursor = value; },
      get trustedChats() { return bindings.trustedChats; },
      set trustedChats(value: typeof bindings.trustedChats) { bindings.trustedChats = value; },
      set agentPanel(value: typeof bindings.agentPanel) { bindings.agentPanel = value; },
      get changedTranscripts() { return bindings.changedTranscripts; },
      set changedTranscripts(value: typeof bindings.changedTranscripts) { bindings.changedTranscripts = value; },
      get chatSearch() { return bindings.chatSearch; },
      set chatSearch(value: typeof bindings.chatSearch) { bindings.chatSearch = value; },
      get detailFor() { return bindings.detailFor; },
      set detailFor(value: typeof bindings.detailFor) { bindings.detailFor = value; },
      get detailStamp() { return bindings.detailStamp; },
      set detailStamp(value: typeof bindings.detailStamp) { bindings.detailStamp = value; },
      get diagnosticsExpanded() { return bindings.diagnosticsExpanded; },
      set diagnosticsExpanded(value: typeof bindings.diagnosticsExpanded) { bindings.diagnosticsExpanded = value; },
      get expandedProjects() { return bindings.expandedProjects; },
      get expandedWorkers() { return bindings.expandedWorkers; },
      get filePanel() { return bindings.filePanel; },
      set filePanel(value: typeof bindings.filePanel) { bindings.filePanel = value; },
      get loadedOlderSessions() { return bindings.loadedOlderSessions; },
      set loadedOlderSessions(value: typeof bindings.loadedOlderSessions) { bindings.loadedOlderSessions = value; },
      get pressure() { return bindings.pressure; },
      set pressure(value: typeof bindings.pressure) { bindings.pressure = value; },
      get projectVisibleCounts() { return bindings.projectVisibleCounts; },
      get projects() { return bindings.projects; },
      set projects(value: typeof bindings.projects) { bindings.projects = value; },
      get renaming() { return bindings.renaming; },
      set renaming(value: typeof bindings.renaming) { bindings.renaming = value; },
      get reviewPanel() { return bindings.reviewPanel; },
      set reviewPanel(value: typeof bindings.reviewPanel) { bindings.reviewPanel = value; },
      get rightWorkspaceTerminal() { return bindings.rightWorkspaceTerminal; },
      set rightWorkspaceTerminal(value: typeof bindings.rightWorkspaceTerminal) { bindings.rightWorkspaceTerminal = value; },
      get selectedId() { return bindings.selectedId; },
      set selectedId(value: typeof bindings.selectedId) { bindings.selectedId = value; },
      get sessionPageCursor() { return bindings.sessionPageCursor; },
      set sessionPageCursor(value: typeof bindings.sessionPageCursor) { bindings.sessionPageCursor = value; },
      get sessionPageLoading() { return bindings.sessionPageLoading; },
      set sessionPageLoading(value: typeof bindings.sessionPageLoading) { bindings.sessionPageLoading = value; },
      get sessionTotal() { return bindings.sessionTotal; },
      set sessionTotal(value: typeof bindings.sessionTotal) { bindings.sessionTotal = value; },
      get sessions() { return bindings.sessions; },
      set sessions(value: typeof bindings.sessions) { bindings.sessions = value; },
      get sessionsLoadGeneration() { return bindings.sessionsLoadGeneration; },
      set sessionsLoadGeneration(value: typeof bindings.sessionsLoadGeneration) { bindings.sessionsLoadGeneration = value; },
      get sidebarOrder() { return bindings.sidebarOrder; },
      set sidebarOrder(value: typeof bindings.sidebarOrder) { bindings.sidebarOrder = value; },
      get visible() { return bindings.visible; },
      set visible(value: typeof bindings.visible) { bindings.visible = value; },
      get workspaceDocks() { return bindings.workspaceDocks; },
      set workspaceDocks(value: typeof bindings.workspaceDocks) { bindings.workspaceDocks = value; },
      get workspaceTerminal() { return bindings.workspaceTerminal; },
      set workspaceTerminal(value: typeof bindings.workspaceTerminal) { bindings.workspaceTerminal = value; }
    },
    ui: {
      get $() { return $; },
      get disclosureChevron() { return disclosureChevron; },
      get el() { return el; },
      get icon() { return icon; },
      get run() { return run; },
      get t() { return t; },
      get ui() { return ui; }
    },
    api: {
      get api() { return bindings.api; }
    },
    constants: {
      get PROJECT_TASK_PAGE_INCREMENT() { return bindings.PROJECT_TASK_PAGE_INCREMENT; },
      get PROJECT_TASK_PAGE_SIZE() { return bindings.PROJECT_TASK_PAGE_SIZE; },
      get SESSION_PAGE_SIZE() { return bindings.SESSION_PAGE_SIZE; },
      get SESSION_SCROLL_MARGIN() { return bindings.SESSION_SCROLL_MARGIN; },
      get SIDEBAR_PROJECT_SCOPE() { return SIDEBAR_PROJECT_SCOPE; }
    },
    actions: {
      get badgeSignature() { return bindings.badgeSignature; },
      get loadDetail() { return bindings.loadDetail; },
      get refreshInputQueue() { return bindings.refreshInputQueue; },
      get refreshSessionControls() { return bindings.refreshSessionControls; },
      get selectNewChat() { return bindings.selectNewChat; }
    },
    helpers: {
      get openRowMenu() { return openRowMenu; },
      get pinnedChat() { return bindings.pinnedChat; },
      get pinnedSortScope() { return pinnedSortScope; },
      get placeSessionTooltip() { return bindings.placeSessionTooltip; },
      get projectGroup() { return bindings.projectGroup; },
      get projectMenuItems() { return bindings.projectMenuItems; },
      get rowMenuButton() { return bindings.rowMenuButton; },
      get rowMenuOpenFor() { return rowMenuOpenFor; },
      get selectedLocalProject() { return bindings.selectedLocalProject; },
      get sessionRow() { return bindings.sessionRow; },
      get sessionWorking() { return bindings.sessionWorking; },
      get toggleRowMenu() { return toggleRowMenu; }
    }
  };

  chatSessionList = createChatSessionList(chatSessionListRuntime);
  const { loadSessions, maybePageSessions, projectSortEntries, paintSessions } = chatSessionList;



  return {
    chatSessionRowRuntime,
    chatSessionRows,
    chatSessionListRuntime,
    chatSessionList,
    loadSessions,
    maybePageSessions,
    projectSortEntries,
    paintSessions
  };
}
