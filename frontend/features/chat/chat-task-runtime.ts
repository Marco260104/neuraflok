import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { RecoveryCountdown } from '../../../contracts/recovery.js';
import type { GoalWait } from '../../../contracts/automation/goal-progress.js';
import type { createChatDeliveryControls } from './chat-delivery-controls.js';
import type { createChatSessionControls } from './chat-session-controls.js';
import type { createChatTaskControls } from './chat-task-controls.js';
import type { createChatTaskPlan } from './chat-task-plan.js';
import { localizedGoalError, paintGoalProgress as paintChatGoalProgress, type GoalDraftPresentation, type GoalProgressView } from './chat-goal-progress.js';
import { el, icon, run } from '../../shared/dom.js';
import { ui } from '../../shared/i18n.js';

type Dependencies = {
  api: typeof window.api;
  taskControls: () => ReturnType<typeof createChatTaskControls>;
  taskPlanController: () => ReturnType<typeof createChatTaskPlan>;
  get selectedId(): string | null;
  get selectionGeneration(): number;
  get chatDeliveryControls(): ReturnType<typeof createChatDeliveryControls> | null;
  get chatSessionControls(): ReturnType<typeof createChatSessionControls> | null;
};

export function createChatTaskRuntime(dependencies: Dependencies) {
  let diagnosticsExpanded = false;
  let controlsGeneration = 0;
  let controlledSessionId: string | null = null;
  let controlledTurnId: string | null = null;
  let controlledSelection = -1;
  let controlledStopPending = false;
  let controlledFinishWaiting = false;
  let controlledQueueAtFinish = false;
  let controlledCanInject = false;
  let controlledCanSendDirectly = false;
  let controlledRecovery: RecoveryCountdown[] = [];
  let pendingComposerInputs: InputEntry[] = [];
  let inputQueueGeneration = 0;
  let goalIntentGeneration = 0;
  let goalProgress: GoalProgressView | null = null;
  let goalDraftView: GoalDraftPresentation | null = null;
  let goalWaitView: GoalWait | null = null;
  let finishGoalDraftView: GoalDraftPresentation | null = null;
  let durationTimer: number | undefined;
  const cancelledStarts = new Set<string>();

  function cancelGoalRequest(): void {
    const requestId = goalProgress?.requestId;
    goalProgress = null;
    if (requestId) void dependencies.api.cancelTaskRequest?.(requestId);
    paintGoalProgress();
  }

  function paintGoalProgress(): void {
    paintChatGoalProgress({
      progress: goalProgress,
      selectionGeneration: dependencies.selectionGeneration,
      pendingComposerInputs,
      controlledSessionId,
      controlledSelection,
      selectedId: dependencies.selectedId,
      finishGoalDraftView,
      goalDraftView,
      goalWaitView,
      controlledRecovery,
      goalReachedShown,
      localizedGoalError,
      dockAction,
      openSessionChat: id => run(dependencies.api.openSessionChat(id))
    });
  }

  function paintDeliveryControls(): void {
    if (!dependencies.chatDeliveryControls) throw new Error('Chat delivery controls are not initialized');
    dependencies.chatDeliveryControls.paintDeliveryControls();
  }

  function dockAction(label: string | (() => string), symbol: string, click: (event: MouseEvent) => void): HTMLButtonElement {
    const button = el('button', 'dock-action') as HTMLButtonElement;
    const description = typeof label === 'function' ? label : () => label;
    button.type = 'button';
    ui(button, 'title', description);
    ui(button, 'aria-label', description);
    button.append(icon(symbol));
    button.onclick = click;
    return button;
  }

  function goalReachedShown(): boolean {
    return dependencies.taskControls().goalReachedShown();
  }

  function closeObjectiveEditor(): void {
    dependencies.taskControls().closeObjectiveEditor();
  }

  function openObjectiveEditor(mode: 'goal' | 'loop' | null = null): void {
    dependencies.taskControls().openObjectiveEditor(mode);
  }

  function currentPreparedPlan() {
    return dependencies.taskPlanController().currentPreparedPlan();
  }

  function paintTaskPlan(): void {
    dependencies.taskPlanController().paintTaskPlan();
  }

  async function createTaskPlan(backend: 'api' | 'web'): Promise<void> {
    await dependencies.taskPlanController().createTaskPlan(backend);
  }

  async function sendPreparedPlan(): Promise<void> {
    await dependencies.taskPlanController().sendPreparedPlan();
  }

  function paintLoopDeliveryTitle(): void {
    dependencies.taskControls().paintLoopDeliveryTitle();
  }

  function paintTaskActions(): void {
    dependencies.taskControls().paintTaskActions();
  }

  function paintLoopDelivery(): void {
    dependencies.taskControls().paintLoopDelivery();
  }

  function openingLoopDelivery(): boolean | undefined {
    return dependencies.taskControls().openingLoopDelivery();
  }

  function paintAutomationSwitch(): void {
    dependencies.taskControls().paintAutomationSwitch();
  }

  function refreshSessionControls(): Promise<void> {
    return dependencies.chatSessionControls?.refreshSessionControls() ?? Promise.resolve();
  }

  async function stopCurrentTurn(): Promise<void> {
    const id = dependencies.selectedId;
    const turnId = controlledTurnId;
    const generation = dependencies.selectionGeneration;
    if (!id || controlledSessionId !== id || controlledSelection !== generation || !turnId || controlledStopPending) return;
    controlledStopPending = true;
    paintDeliveryControls();
    try {
      await run(dependencies.api.stopSessionTurn(id, turnId));
    } finally {
      if (dependencies.selectedId === id && dependencies.selectionGeneration === generation) {
        controlledStopPending = false;
        void refreshSessionControls();
      }
    }
  }

  return {
    get diagnosticsExpanded() { return diagnosticsExpanded; },
    set diagnosticsExpanded(value: boolean) { diagnosticsExpanded = value; },
    get controlsGeneration() { return controlsGeneration; },
    set controlsGeneration(value: number) { controlsGeneration = value; },
    get controlledSessionId() { return controlledSessionId; },
    set controlledSessionId(value: string | null) { controlledSessionId = value; },
    get controlledTurnId() { return controlledTurnId; },
    set controlledTurnId(value: string | null) { controlledTurnId = value; },
    get controlledSelection() { return controlledSelection; },
    set controlledSelection(value: number) { controlledSelection = value; },
    get controlledStopPending() { return controlledStopPending; },
    set controlledStopPending(value: boolean) { controlledStopPending = value; },
    get controlledFinishWaiting() { return controlledFinishWaiting; },
    set controlledFinishWaiting(value: boolean) { controlledFinishWaiting = value; },
    get controlledQueueAtFinish() { return controlledQueueAtFinish; },
    set controlledQueueAtFinish(value: boolean) { controlledQueueAtFinish = value; },
    get controlledCanInject() { return controlledCanInject; },
    set controlledCanInject(value: boolean) { controlledCanInject = value; },
    get controlledCanSendDirectly() { return controlledCanSendDirectly; },
    set controlledCanSendDirectly(value: boolean) { controlledCanSendDirectly = value; },
    get controlledRecovery() { return controlledRecovery; },
    set controlledRecovery(value: RecoveryCountdown[]) { controlledRecovery = value; },
    get pendingComposerInputs() { return pendingComposerInputs; },
    set pendingComposerInputs(value: InputEntry[]) { pendingComposerInputs = value; },
    get inputQueueGeneration() { return inputQueueGeneration; },
    set inputQueueGeneration(value: number) { inputQueueGeneration = value; },
    get goalIntentGeneration() { return goalIntentGeneration; },
    set goalIntentGeneration(value: number) { goalIntentGeneration = value; },
    get goalProgress() { return goalProgress; },
    set goalProgress(value: GoalProgressView | null) { goalProgress = value; },
    get goalDraftView() { return goalDraftView; },
    set goalDraftView(value: GoalDraftPresentation | null) { goalDraftView = value; },
    get goalWaitView() { return goalWaitView; },
    set goalWaitView(value: GoalWait | null) { goalWaitView = value; },
    get finishGoalDraftView() { return finishGoalDraftView; },
    set finishGoalDraftView(value: GoalDraftPresentation | null) { finishGoalDraftView = value; },
    get durationTimer() { return durationTimer; },
    set durationTimer(value: number | undefined) { durationTimer = value; },
    cancelledStarts,
    cancelGoalRequest,
    paintGoalProgress,
    paintDeliveryControls,
    dockAction,
    goalReachedShown,
    closeObjectiveEditor,
    openObjectiveEditor,
    currentPreparedPlan,
    paintTaskPlan,
    createTaskPlan,
    sendPreparedPlan,
    paintLoopDeliveryTitle,
    paintTaskActions,
    paintLoopDelivery,
    openingLoopDelivery,
    paintAutomationSwitch,
    refreshSessionControls,
    stopCurrentTurn
  };
}
