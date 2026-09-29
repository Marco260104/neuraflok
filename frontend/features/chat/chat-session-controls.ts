import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import type { GoalWait } from '../../../contracts/automation/goal-progress.js';
import type { RecoveryCountdown } from '../../../contracts/recovery.js';
import type { SessionSummary } from '../../../contracts/session.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import { renderAgentPlan } from '../agents/agent-plan.js';
import { $, run } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import type { GoalDraftPresentation } from './chat-goal-progress.js';

interface ChatSessionControlsRuntime {
  get selectedId(): string | null;
  get selectionGeneration(): number;
  get controlsGeneration(): number;
  set controlsGeneration(value: number);
  get controlledSessionId(): string | null;
  set controlledSessionId(value: string | null);
  get controlledSelection(): number;
  set controlledSelection(value: number);
  get controlledTurnId(): string | null;
  set controlledTurnId(value: string | null);
  get controlledStopPending(): boolean;
  set controlledStopPending(value: boolean);
  get controlledFinishWaiting(): boolean;
  set controlledFinishWaiting(value: boolean);
  get controlledQueueAtFinish(): boolean;
  set controlledQueueAtFinish(value: boolean);
  get controlledCanInject(): boolean;
  set controlledCanInject(value: boolean);
  get controlledCanSendDirectly(): boolean;
  set controlledCanSendDirectly(value: boolean);
  get controlledRecovery(): RecoveryCountdown[];
  set controlledRecovery(value: RecoveryCountdown[]);
  get goalDraftView(): GoalDraftPresentation | null;
  set goalDraftView(value: GoalDraftPresentation | null);
  get goalWaitView(): GoalWait | null;
  set goalWaitView(value: GoalWait | null);
  get finishGoalDraftView(): GoalDraftPresentation | null;
  set finishGoalDraftView(value: GoalDraftPresentation | null);
  get pendingComposerInputs(): InputEntry[];
  get sessions(): SessionSummary[];
  getSessionControls(id: string): ReturnType<typeof window.api.getSessionControls>;
  paintAutomationSwitch(): void;
  paintDeliveryControls(): void;
  paintStateLine(): void;
  paintTaskActions(): void;
  paintLoopDeliveryTitle(): void;
}

export function createChatSessionControls(runtime: ChatSessionControlsRuntime) {
  return {
    async refreshSessionControls(): Promise<void> {
      const id = runtime.selectedId;
      const generation = ++runtime.controlsGeneration;
      const planHost = $('agentPlan');
      if (planHost.dataset.sessionId !== (id ?? '')) renderAgentPlan(planHost, id, null);
      const menu = $('sessionControls');
      if (runtime.controlledSessionId !== id || runtime.controlledSelection !== runtime.selectionGeneration) {
        // Clear stale status before the next session read.
        ui($('sessionControlStatus'), 'textContent', () => '');
        for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
      }
      runtime.paintAutomationSwitch();
      if (!id) {
        runtime.controlledSessionId = null;
        runtime.controlledTurnId = null;
        runtime.paintDeliveryControls();
        menu.hidden = false;
        $<HTMLTextAreaElement>('sessionObjective').disabled = false;
        runtime.paintTaskActions();
        for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
        return;
      }
      const opening = runtime.pendingComposerInputs.find(row => row.opening && row.sessionId === id && ['queued', 'browser'].includes(row.state));
      if (!runtime.sessions.find(row => row.id === id)?.conversationId) {
        runtime.controlledSessionId = id;
        runtime.controlledSelection = runtime.selectionGeneration;
        runtime.controlledTurnId = null;
        runtime.controlledCanInject = false;
        runtime.controlledCanSendDirectly = false;
        runtime.controlledQueueAtFinish = false;
        runtime.controlledStopPending = false;
        runtime.controlledFinishWaiting = false;
        menu.hidden = false;
        runtime.goalDraftView = null;
        runtime.goalWaitView = null;
        runtime.finishGoalDraftView = null;
        runtime.controlledRecovery = [];
        $<HTMLSelectElement>('chatAutomation').value = opening?.automation ?? 'off';
        $<HTMLSelectElement>('loopDelivery').value = opening?.loopAfterTurn ? 'after-turn' : 'finish';
        runtime.paintLoopDeliveryTitle();
        const objective = $<HTMLTextAreaElement>('sessionObjective');
        objective.value = opening?.objective ?? '';
        objective.disabled = true;
        objective.dataset.sessionId = id;
        for (const action of ['compactSession', 'cancelCompaction']) $(action).hidden = true;
        runtime.paintAutomationSwitch();
        runtime.paintDeliveryControls();
        return;
      }
      const controls = await run(runtime.getSessionControls(id));
      if (generation !== runtime.controlsGeneration || id !== runtime.selectedId) return;
      renderAgentPlan(planHost, id, controls?.plan ?? null);
      runtime.controlledSessionId = id;
      runtime.controlledSelection = runtime.selectionGeneration;
      runtime.controlledTurnId = controls?.activeTurnId ?? null;
      runtime.goalDraftView = controls?.goalDraft ?? null;
      runtime.goalWaitView = controls?.goalWait ?? null;
      runtime.finishGoalDraftView = controls?.finishGoalDraft ?? null;
      runtime.controlledStopPending = controls?.stopPending === true;
      runtime.controlledFinishWaiting = controls?.finishWaiting === true;
      runtime.controlledQueueAtFinish = controls?.queueAtFinish === true;
      runtime.controlledCanInject = controls?.canInject ?? runtime.controlledTurnId !== null;
      runtime.controlledCanSendDirectly = controls?.canSendDirectly === true;
      runtime.controlledRecovery = controls?.recovery ?? [];
      runtime.paintDeliveryControls();
      runtime.paintStateLine();
      menu.hidden = !controls;
      $('compactSession').hidden = !controls || isApiConversationId(controls.conversationId);
      if (!controls) {
        $('cancelCompaction').hidden = true;
        return;
      }
      const objective = $<HTMLTextAreaElement>('sessionObjective');
      if (objective.dataset.sessionId !== id || !objective.dataset.edited) {
        objective.value = controls.objective;
        objective.dataset.saved = controls.objective;
        objective.dataset.sessionId = id;
        delete objective.dataset.edited;
        $<HTMLSelectElement>('sessionObjectiveMode').value = controls.automation === 'loop' ? 'loop' : 'goal';
      }
      objective.disabled = !!controls.blocked;
      runtime.paintTaskActions();
      const draftMode = $<HTMLSelectElement>('chatAutomation');
      if (!draftMode.dataset.edited) draftMode.value = controls.automation;
      if (!$<HTMLSelectElement>('loopDelivery').disabled)
        $<HTMLSelectElement>('loopDelivery').value = controls.loopAfterTurn ? 'after-turn' : 'finish';
      runtime.paintLoopDeliveryTitle();
      runtime.paintAutomationSwitch();
      $<HTMLButtonElement>('compactSession').disabled = !!controls.blocked || !!controls.job?.busy;
      $('cancelCompaction').hidden = !controls.job?.busy;
      ui($('sessionControlStatus'), 'textContent', () => controls.blocked === 'worker' ? t('This sub-agent is managed by its prime.') : controls.blocked === 'blocked' ? t('This chat is blocked.') : controls.job?.busy ? t('Compaction is running in this workspace.') : '');
    }
  };
}
