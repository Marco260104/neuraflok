import type { ChatInitializationBindings } from './chat.js';
import { bindChatSidebarEvents } from './chat-sidebar-events.js';
import { bindChatAgentEvents } from './chat-agent-events.js';
import { bindChatComposerInputEvents } from './chat-composer-input-events.js';
import { installChatReaderScroll } from './chat-reader-scroll.js';
import { initContextMeter } from './context-meter.js';
import { $ } from '../../shared/dom.js';

export function bindChatRendererEvents(bindings: ChatInitializationBindings): void {  bindChatComposerInputEvents(bindings.chatComposerInputRuntime);
  initContextMeter();
  installChatReaderScroll({
    get selectionGeneration() {
      return bindings.selectionGeneration;
    },
    get hasSendAnchor() {
      return bindings.chatReader().sendAnchor !== null;
    },
    get historyBefore() {
      return bindings.historyBefore;
    },
    get hasHistoryDemand() {
      return bindings.historyDemand !== null;
    },
    get readerAtEnd() {
      return bindings.chatReader().readerAtEnd;
    },
    set readerAtEnd(value: boolean) {
      bindings.chatReader().readerAtEnd = value;
    },
    get readingAfterSend() {
      return bindings.chatReader().readingAfterSend;
    },
    set readingAfterSend(value: boolean) {
      bindings.chatReader().readingAfterSend = value;
    },
    timelineShown: bindings.timelineShown,
    followOutput: bindings.followOutput,
    distanceFromTail: bindings.distanceFromTail,
    paintJumpLatest: bindings.paintJumpLatest,
    jumpToLatest: bindings.jumpToLatest,
    releaseSendHold() {
      bindings.chatReader().releaseSendHold();
    },
    holdSentMessage: bindings.holdSentMessage,
    requestHistory: bindings.requestHistory,
    fillTimelineHistory: bindings.fillTimelineHistory
  });
  bindings.chatSearch = bindChatSidebarEvents({
    selectedId: () => bindings.selectedId,
    sessions: () => bindings.sessions,
    clearPendingNewInput: () => {
      bindings.pendingNewInput = null;
    },
    selectSession: bindings.selectSession,
    revealSearchMatch: (id, query) => {
      void bindings.chatSearchNavigation?.revealSearchMatch(id, query);
    },
    maybePageSessions: bindings.maybePageSessions,
    showView: bindings.showView,
    setAgentFilter: value => {
      bindings.agentFilter = value;
    },
    paintDetail: bindings.paintDetail
  });
  bindChatAgentEvents({
    paintSwarm: bindings.paintSwarm
  });
  for (const id of bindings.chatSettings.CHAT_INPUTS) {
    $(id).addEventListener('change', () => void bindings.deps.save());
  }
  bindings.chatSettings.wireGoal(() => bindings.deps.save());
  bindings.api.onSessionChanged(bindings.scheduleReload);
  bindings.api.onBackgroundProcessesChanged(bindings.refreshBackgroundProcesses);
  bindings.api.onTaskProgress(progress => {
    if (!bindings.goalProgress || progress.requestId !== bindings.goalProgress.requestId || bindings.goalProgress.selection !== bindings.selectionGeneration) return;
    Object.assign(bindings.goalProgress, progress);
    bindings.paintGoalProgress();
  });
  bindings.api.onSwarmChanged(bindings.paintSwarm);
}
