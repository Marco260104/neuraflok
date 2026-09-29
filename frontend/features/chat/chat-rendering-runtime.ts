import type { ChatRuntimeBindings } from './chat-orchestrator.js';
import { createChatDetailRenderer, type ChatDetailRendererRuntime } from './chat-detail-renderer.js';
import { createChatRecoveryView } from './chat-recovery-view.js';
import { run } from '../../shared/dom.js';

export interface ChatRenderingRuntime {
  chatDetailRendererRuntime: ChatDetailRendererRuntime;
  paintDetail: ReturnType<typeof createChatDetailRenderer>['paintDetail'];
  chatRecoveryView: ReturnType<typeof createChatRecoveryView>;
}

export function createChatRenderingRuntime(bindings: ChatRuntimeBindings, turnWorking: () => boolean): ChatRenderingRuntime {
  const chatRecoveryView = createChatRecoveryView({
    api: bindings.api,
    run,
    get sessions() { return bindings.sessions; },
    get selectedId() { return bindings.selectedId; },
    get controlledSessionId() { return bindings.controlledSessionId; },
    get controlledSelection() { return bindings.controlledSelection; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get controlledRecovery() { return bindings.controlledRecovery; },
    get detailFor() { return bindings.detailFor; },
    get events() { return bindings.events; },
    get handoff() { return bindings.handoff; },
    set handoff(value) { bindings.handoff = value; },
    get handoffFor() { return bindings.handoffFor; },
    set handoffFor(value) { bindings.handoffFor = value; },
    get handoffLoadGeneration() { return bindings.handoffLoadGeneration; },
    set handoffLoadGeneration(value) { bindings.handoffLoadGeneration = value; },
    dismissedRecoveryNotices: bindings.dismissedRecoveryNotices,
    refreshSessionControls: bindings.refreshSessionControls,
    paintStateLine: bindings.paintStateLine,
    dockAction: bindings.dockAction
  });

  const chatDetailRendererRuntime: ChatDetailRendererRuntime = {
    state: () => bindings.deps.state(),
    get sessions() { return bindings.sessions; },
    get selectedId() { return bindings.selectedId; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    get events() { return bindings.events; },
    get historyBefore() { return bindings.historyBefore; },
    get detailFor() { return bindings.detailFor; },
    get totalEvents() { return bindings.totalEvents; },
    get agentFilter() { return bindings.agentFilter; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get dismissedInputNotices() { return bindings.dismissedInputNotices; },
    get rowCache() { return bindings.rowCache; },
    get toolGroups() { return bindings.toolGroups; },
    get rowEvents() { return bindings.rowEvents; },
    get readingAfterSend() { return bindings.chatReader().readingAfterSend; },
    get readerAtEnd() { return bindings.chatReader().readerAtEnd; },
    get turnWorking() { return turnWorking(); },
    get UNATTRIBUTED() { return bindings.UNATTRIBUTED; },
    applyComposerSessionModel: bindings.applyComposerSessionModel,
    composerSessionSelection: bindings.composerSessionSelection,
    paintContextMeter: bindings.paintContextMeter,
    observedComposerModel: bindings.observedComposerModel,
    selectedLocalProject: bindings.selectedLocalProject,
    paintStateLine: bindings.paintStateLine,
    paintBackgroundProcesses: bindings.paintBackgroundProcesses,
    paintDeliveryControls: bindings.paintDeliveryControls,
    paintAgentFilter: bindings.paintAgentFilter,
    visibleEvents: bindings.visibleEvents,
    followOutput: bindings.followOutput,
    paintRecoveryStatus: () => chatRecoveryView.paintRecoveryStatus(),
    historicalAutomaticInput: bindings.historicalAutomaticInput,
    inputMessageRow: bindings.inputMessageRow,
    exchangeDurations: bindings.exchangeDurations,
    timelineItems: bindings.timelineItems,
    stoppedTurnEnd: bindings.stoppedTurnEnd,
    itemKey: bindings.itemKey,
    itemSignature: bindings.itemSignature,
    paintMessageReaction: bindings.paintMessageReaction,
    paintInputReceipt: bindings.paintInputReceipt,
    compactionRow: bindings.compactionRow,
    eventRow: bindings.eventRow,
    answerActions: bindings.answerActions,
    placeTurnLines: bindings.placeTurnLines,
    reconcileChildren: bindings.reconcileChildren,
    groupImageRows: bindings.groupImageRows,
    renderRounds: bindings.renderRounds,
    setRoundsEnter: value => { bindings.roundsEnter = value; },
    paintPendingInputs: bindings.paintPendingInputs,
    timelineShown: bindings.timelineShown,
    holdSentMessage: bindings.holdSentMessage,
    paintJumpLatest: bindings.paintJumpLatest,
    pressureOf: bindings.pressureOf
  };
  const { paintDetail } = createChatDetailRenderer(chatDetailRendererRuntime);
  return { chatDetailRendererRuntime, paintDetail, chatRecoveryView };
}
