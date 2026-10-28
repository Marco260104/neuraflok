import { createChatTaskPlan } from './chat-task-plan.js';
import { createChatTaskControls } from './chat-task-controls.js';
import { createChatInputQueue } from './chat-input-queue.js';
import { createChatComposerDelivery } from './chat-composer-delivery.js';
import { createChatAutomationControls } from './chat-automation-controls.js';
import { imageDrafts } from './chat-composer-attachments.js';
import { createChatSessionControls } from './chat-session-controls.js';
import { createChatDraftState } from './chat-draft-state.js';
import { createChatDeliveryControls } from './chat-delivery-controls.js';
import { createWebChatWarmup } from './chat-web-warmup.js';
import { blocksStopForWarmup, composerWarmupKey, composerWarmupState } from './chat-composer-ready.js';
import { localizedGoalError, type GoalDraftPresentation, type GoalProgressView } from './chat-goal-progress.js';
import type { ChatSendAnchor } from './chat-reader-state.js';
import type { RecoveryCountdown } from '../../../contracts/recovery.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { run, toast } from '../../shared/dom.js';
import type { ChatRuntimeBindings } from './chat.js';

export interface ChatComposerCompositionDependencies {
  mergeSessionRows(rows: SessionSummary[]): void;
  parkTurnStatus(working: boolean): void;
  turnWorking(): boolean;
}

export function createChatComposerComposition(bindings: ChatRuntimeBindings, dependencies: ChatComposerCompositionDependencies) {
  const chatInputQueueRuntime = {
    api: bindings.api,
    run,
    toast,
    get visibleInputIds() { return bindings.visibleInputIds; },
    hasLaterModelActivity: bindings.hasLaterModelActivity,
    attachmentCard: bindings.attachmentCard,
    dockAction: bindings.dockAction,
    dismissInputNotice: bindings.dismissInputNotice,
    authoredComposerText: bindings.authoredComposerText,
    get imageDrafts() { return imageDrafts; },
    draftKey: bindings.draftKey,
    replaceComposerDraft: bindings.replaceComposerDraft,
    rememberDraft: bindings.rememberDraft,
    get skillPicker() { return bindings.skillPicker; },
    paintComposerImages: bindings.paintComposerImages,
    paintDeliveryControls: bindings.paintDeliveryControls,
    get pendingNewInput() { return bindings.pendingNewInput; },
    set pendingNewInput(value: typeof bindings.pendingNewInput) { bindings.pendingNewInput = value; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get newChatSelected() { return bindings.newChatSelected; },
    get selectedId() { return bindings.selectedId; },
    get sessions() { return bindings.sessions; },
    mergeSessionRows: (rows: SessionSummary[]) => dependencies.mergeSessionRows(rows),
    get inputDrafts() { return bindings.drafts().inputDrafts; },
    selectSession: bindings.selectSession,
    get newChatTasks() { return bindings.drafts().newChatTasks; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    set pendingComposerInputs(value: typeof bindings.pendingComposerInputs) { bindings.pendingComposerInputs = value; },
    get dismissedInputNotices() { return bindings.dismissedInputNotices; },
    get detailFor() { return bindings.detailFor; },
    get events() { return bindings.events; },
    get historyBefore() { return bindings.historyBefore; },
    get detailCursor() { return bindings.detailCursor; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    projectGroup: bindings.projectGroup,
    get startingInputs() { return bindings.startingInputs; },
    holdSentMessage: bindings.holdSentMessage,
    reconcileChildren: bindings.reconcileChildren,
    parkTurnStatus: (working: boolean) => dependencies.parkTurnStatus(working),
    get inputQueueGeneration() { return bindings.inputQueueGeneration; },
    set inputQueueGeneration(value: number) { bindings.inputQueueGeneration = value; },
    paintDetail: bindings.paintDetail,
    get cancelledStarts() { return bindings.cancelledStarts; },
    refreshInputQueue: () => bindings.refreshInputQueue(),
    get turnWorking() { return dependencies.turnWorking(); }
  };

  const chatInputQueue = createChatInputQueue(chatInputQueueRuntime);

  createWebChatWarmup({
    api: bindings.api,
    state: () => bindings.deps.state(),
    get newChatSelected() { return bindings.newChatSelected; },
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get sessions() { return bindings.sessions; },
    get events() { return bindings.events; },
    turnWorking: dependencies.turnWorking,
    get pendingNewInput() { return bindings.pendingNewInput; },
    get startingInputs() { return bindings.startingInputs; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    set pendingComposerInputs(value: typeof bindings.pendingComposerInputs) { bindings.pendingComposerInputs = value; },
    adoptAcceptedOpening: entry => chatInputQueue.adoptAcceptedOpening(entry),
    selectSession: bindings.selectSession,
    paintDeliveryControls: bindings.paintDeliveryControls,
    refreshSessionControls: () => bindings.refreshSessionControls(),
    refreshInputQueue: () => bindings.refreshInputQueue(),
    setPendingNewInput: value => { bindings.pendingNewInput = value; },
    paintPreparationStatus: () => dependencies.parkTurnStatus(dependencies.turnWorking())
  });

  const chatComposerDeliveryRuntime = {
    api: bindings.api,
    draftKey: bindings.draftKey,
    get selectedId() { return bindings.selectedId; },
    get sessions() { return bindings.sessions; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    projectScopedSelection: () => {
      const session = bindings.sessions.find(row => row.id === bindings.selectedId);
      return !!(session?.projectId ?? bindings.selectedProjectId);
    },
    projectPlanMode: () => bindings.chatTaskControls?.projectPlanMode() ?? false,
    clearProjectPlanMode: (key?: string) => bindings.chatTaskControls?.clearProjectPlanMode(key),
    get imageDrafts() { return imageDrafts; },
    authoredComposerText: bindings.authoredComposerText,
    get selectionGeneration() { return bindings.selectionGeneration; },
    get controlledSessionId() { return bindings.controlledSessionId; },
    get controlledSelection() { return bindings.controlledSelection; },
    get controlledTurnId() { return bindings.controlledTurnId; },
    get controlledQueueAtFinish() { return bindings.controlledQueueAtFinish; },
    get controlledCanInject() { return bindings.controlledCanInject; },
    refreshSessionControls: bindings.refreshSessionControls,
    stopCurrentTurn: bindings.stopCurrentTurn,
    pendingComposerInput: () => chatInputQueue.pendingComposerInput(),
    get startingInputs() { return bindings.startingInputs; },
    get cancelledStarts() { return bindings.cancelledStarts; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    set pendingComposerInputs(value: typeof bindings.pendingComposerInputs) { bindings.pendingComposerInputs = value; },
    dismissInputNotice: bindings.dismissInputNotice,
    paintDeliveryControls: bindings.paintDeliveryControls,
    refreshInputQueue: bindings.refreshInputQueue,
    replaceComposerDraft: bindings.replaceComposerDraft,
    get inputDrafts() { return bindings.drafts().inputDrafts; },
    restoreSkills: () => bindings.skillPicker?.restore(),
    paintComposerImages: bindings.paintComposerImages,
    get pendingNewInput() { return bindings.pendingNewInput; },
    set pendingNewInput(value: typeof bindings.pendingNewInput) { bindings.pendingNewInput = value; },
    followOutput: bindings.followOutput,
    get sendAnchor() { return bindings.chatReader().sendAnchor; },
    set sendAnchor(value: ChatSendAnchor | null) { bindings.chatReader().sendAnchor = value; },
    get readingAfterSend() { return bindings.chatReader().readingAfterSend; },
    set readingAfterSend(value: boolean) { bindings.chatReader().readingAfterSend = value; },
    get readerAtEnd() { return bindings.chatReader().readerAtEnd; },
    set readerAtEnd(value: boolean) { bindings.chatReader().readerAtEnd = value; },
    userMessageKeys: bindings.userMessageKeys,
    openingLoopDelivery: bindings.openingLoopDelivery,
    get inputQueueGeneration() { return bindings.inputQueueGeneration; },
    set inputQueueGeneration(value: number) { bindings.inputQueueGeneration = value; },
    showAutoSkillReceipt: bindings.showAutoSkillReceipt,
    paintDetail: bindings.paintDetail,
    adoptAcceptedOpening: bindings.adoptAcceptedOpening
  };

  const chatComposerDelivery = createChatComposerDelivery(chatComposerDeliveryRuntime);

  const chatTaskPlanRuntime = {
    draftKey: bindings.draftKey,
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    get sessions() { return bindings.sessions; },
    authoredComposerText: bindings.authoredComposerText,
    inputDraftFor: (key: string) => bindings.drafts().inputDrafts.get(key) ?? '',
    forgetInputDraft: (key: string) => bindings.drafts().inputDrafts.delete(key),
    replaceComposerDraft: bindings.replaceComposerDraft,
    restoreSkills: () => bindings.skillPicker?.restore(),
    localizedGoalError,
    dockAction: bindings.dockAction,
    paintTaskActions: bindings.paintTaskActions,
    paintDeliveryControls: bindings.paintDeliveryControls,
    sendComposer: bindings.sendComposer,
    refreshInputQueue: () => bindings.refreshInputQueue()
  };

  const taskPlanController = createChatTaskPlan(chatTaskPlanRuntime);
  bindings.chatDraftState = createChatDraftState({
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    get skillPicker() { return bindings.skillPicker; },
    cancelGoalRequest: bindings.cancelGoalRequest,
    paintTaskPlan: bindings.paintTaskPlan,
    paintComposerImages: bindings.paintComposerImages,
    paintLoopDeliveryTitle: bindings.paintLoopDeliveryTitle
  });

  bindings.chatTaskControls = createChatTaskControls({
    draftKey: bindings.draftKey,
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    get sessions() { return bindings.sessions; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get controlledSessionId() { return bindings.controlledSessionId; },
    get controlledSelection() { return bindings.controlledSelection; },
    goalDraftStage: () => bindings.goalDraftView?.stage,
    hasFinishGoalDraft: () => bindings.finishGoalDraftView !== null,
    taskPlans: taskPlanController,
    state: () => bindings.deps.state(),
    cancelGoalRequest: bindings.cancelGoalRequest,
    advanceGoalIntent: () => { bindings.goalIntentGeneration++; },
    paintGoalProgress: bindings.paintGoalProgress,
    paintDeliveryControls: bindings.paintDeliveryControls
  });

  bindings.chatDeliveryControls = createChatDeliveryControls({
    get selectedId() { return bindings.selectedId; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get detailFor() { return bindings.detailFor; },
    get events() { return bindings.events; },
    selectedSummary: () => bindings.sessions.find(row => row.id === bindings.selectedId),
    preparingChatInternally: () => {
      const warmup = composerWarmupState(composerWarmupKey(bindings.selectedId, bindings.selectionGeneration));
      // A restored queue row is not evidence of a turn started by this view.
      // Release a failed preparation gate only after fresh, public provider activity.
      return blocksStopForWarmup(warmup, bindings.events, bindings.controlledTurnId, bindings.selectionGeneration);
    },
    projectScopedSelection: () => {
      const session = bindings.sessions.find(row => row.id === bindings.selectedId);
      return !!(session?.projectId ?? bindings.selectedProjectId);
    },
    get controlledSessionId() { return bindings.controlledSessionId; },
    get controlledSelection() { return bindings.controlledSelection; },
    get controlledTurnId() { return bindings.controlledTurnId; },
    get controlledQueueAtFinish() { return bindings.controlledQueueAtFinish; },
    get controlledCanInject() { return bindings.controlledCanInject; },
    get controlledCanSendDirectly() { return bindings.controlledCanSendDirectly; },
    get controlledFinishWaiting() { return bindings.controlledFinishWaiting; },
    get controlledStopPending() { return bindings.controlledStopPending; },
    get finishGoalDraftView() { return bindings.finishGoalDraftView; },
    get startingInputs() { return bindings.startingInputs; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    get imageDrafts() { return imageDrafts; },
    draftKey: bindings.draftKey,
    paintGoalProgress: bindings.paintGoalProgress,
    currentPreparedPlan: bindings.currentPreparedPlan,
    authoredComposerText: bindings.authoredComposerText,
    pendingComposerInput: () => chatInputQueue.pendingComposerInput(),
    taskPlans: taskPlanController
  });

  const chatComposerInputRuntime = {
    draftKey: bindings.draftKey,
    authoredComposerText: bindings.authoredComposerText,
    get imageDrafts() { return imageDrafts; },
    taskPlans: taskPlanController,
    get skillPicker() { return bindings.skillPicker; },
    get objectiveEditMode() { return bindings.taskControls().objectiveEditMode; },
    set objectiveEditMode(value: 'goal' | 'loop' | null) { bindings.taskControls().objectiveEditMode = value; },
    paintAutomationSwitch: bindings.paintAutomationSwitch,
    paintDeliveryControls: bindings.paintDeliveryControls,
    paintTaskActions: bindings.paintTaskActions,
    currentPreparedPlan: bindings.currentPreparedPlan,
    sendPreparedPlan: bindings.sendPreparedPlan,
    createTaskPlan: bindings.createTaskPlan,
    sendComposer: bindings.sendComposer,
    planBackend: () => bindings.deps.state()?.config.ui.planBackend ?? 'web'
  };

  bindings.chatSessionControls = createChatSessionControls({
    get selectedId() { return bindings.selectedId; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get controlsGeneration() { return bindings.controlsGeneration; },
    set controlsGeneration(value: number) { bindings.controlsGeneration = value; },
    get controlledSessionId() { return bindings.controlledSessionId; },
    set controlledSessionId(value: string | null) { bindings.controlledSessionId = value; },
    get controlledSelection() { return bindings.controlledSelection; },
    set controlledSelection(value: number) { bindings.controlledSelection = value; },
    get controlledTurnId() { return bindings.controlledTurnId; },
    set controlledTurnId(value: string | null) { bindings.controlledTurnId = value; },
    get controlledStopPending() { return bindings.controlledStopPending; },
    set controlledStopPending(value: boolean) { bindings.controlledStopPending = value; },
    get controlledFinishWaiting() { return bindings.controlledFinishWaiting; },
    set controlledFinishWaiting(value: boolean) { bindings.controlledFinishWaiting = value; },
    get controlledQueueAtFinish() { return bindings.controlledQueueAtFinish; },
    set controlledQueueAtFinish(value: boolean) { bindings.controlledQueueAtFinish = value; },
    get controlledCanInject() { return bindings.controlledCanInject; },
    set controlledCanInject(value: boolean) { bindings.controlledCanInject = value; },
    get controlledCanSendDirectly() { return bindings.controlledCanSendDirectly; },
    set controlledCanSendDirectly(value: boolean) { bindings.controlledCanSendDirectly = value; },
    get controlledRecovery() { return bindings.controlledRecovery; },
    set controlledRecovery(value: RecoveryCountdown[]) { bindings.controlledRecovery = value; },
    get goalDraftView() { return bindings.goalDraftView; },
    set goalDraftView(value: GoalDraftPresentation | null) { bindings.goalDraftView = value; },
    get goalWaitView() { return bindings.goalWaitView; },
    set goalWaitView(value: typeof bindings.goalWaitView) { bindings.goalWaitView = value; },
    get finishGoalDraftView() { return bindings.finishGoalDraftView; },
    set finishGoalDraftView(value: GoalDraftPresentation | null) { bindings.finishGoalDraftView = value; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    get sessions() { return bindings.sessions; },
    getSessionControls: id => bindings.api.getSessionControls(id),
    paintAutomationSwitch: bindings.paintAutomationSwitch,
    paintDeliveryControls: bindings.paintDeliveryControls,
    paintStateLine: bindings.paintStateLine,
    paintTaskActions: bindings.paintTaskActions,
    paintLoopDeliveryTitle: bindings.paintLoopDeliveryTitle
  });

  const chatAutomationRuntime = {
    get selectedId() { return bindings.selectedId; },
    get selectedProjectId() { return bindings.selectedProjectId; },
    get selectionGeneration() { return bindings.selectionGeneration; },
    get goalIntentGeneration() { return bindings.goalIntentGeneration; },
    set goalIntentGeneration(value: number) { bindings.goalIntentGeneration = value; },
    get objectiveEditMode() { return bindings.taskControls().objectiveEditMode; },
    set objectiveEditMode(value: 'goal' | 'loop' | null) { bindings.taskControls().objectiveEditMode = value; },
    get goalProgress() { return bindings.goalProgress; },
    set goalProgress(value: GoalProgressView | null) { bindings.goalProgress = value; },
    get goalDraftView() { return bindings.goalDraftView; },
    set goalDraftView(value: GoalDraftPresentation | null) { bindings.goalDraftView = value; },
    get pendingComposerInputs() { return bindings.pendingComposerInputs; },
    set pendingComposerInputs(value: InputEntry[]) { bindings.pendingComposerInputs = value; },
    get pendingNewInput() { return bindings.pendingNewInput; },
    set pendingNewInput(value: typeof bindings.pendingNewInput) { bindings.pendingNewInput = value; },
    get startingInputs() { return bindings.startingInputs; },
    get inputQueueGeneration() { return bindings.inputQueueGeneration; },
    set inputQueueGeneration(value: number) { bindings.inputQueueGeneration = value; },
    cancelGoalRequest: bindings.cancelGoalRequest,
    paintAutomationSwitch: bindings.paintAutomationSwitch,
    openObjectiveEditor: bindings.openObjectiveEditor,
    closeObjectiveEditor: bindings.closeObjectiveEditor,
    paintTaskActions: bindings.paintTaskActions,
    paintGoalProgress: bindings.paintGoalProgress,
    paintDeliveryControls: bindings.paintDeliveryControls,
    paintLoopDeliveryTitle: bindings.paintLoopDeliveryTitle,
    openingLoopDelivery: bindings.openingLoopDelivery,
    refreshInputQueue: () => bindings.refreshInputQueue(),
    refreshSessionControls: () => bindings.refreshSessionControls(),
    adoptAcceptedOpening: bindings.adoptAcceptedOpening
  };

  const chatAutomationControls = createChatAutomationControls(chatAutomationRuntime);

  return {
    chatInputQueueRuntime,
    chatInputQueue,
    chatComposerDeliveryRuntime,
    chatComposerDelivery,
    chatTaskPlanRuntime,
    taskPlanController,
    chatComposerInputRuntime,
    chatAutomationRuntime,
    chatAutomationControls
  };
}
