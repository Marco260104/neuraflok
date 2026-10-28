import { injectableAttachments } from '../../../contracts/input.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { GoalDraftPresentation } from './chat-goal-progress.js';
import type { ComposerAttachment } from './chat-composer-attachments.js';
import type { createChatTaskPlan } from './chat-task-plan.js';
import type { SessionEvent, SessionSummary } from '../../../contracts/session.js';
import { $ } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { transcriptOrSummaryShowsCompletedLatestTurn } from './chat-turn-state.js';

// Session controls can briefly restore an old activeTurnId while a chat's
// history and provider activity are being reconciled. Require that snapshot
// to remain stable before presenting a destructive Stop action.
const STALE_STOP_CONFIRMATION_MS = 1_200;
const RECENT_TURN_ACTIVITY_MS = 10_000;

export interface ChatDeliveryControlsRuntime {
  selectedId: string | null;
  selectionGeneration: number;
  detailFor: string | null;
  events: SessionEvent[];
  selectedSummary: () => SessionSummary | undefined;
  controlledSessionId: string | null;
  controlledSelection: number;
  controlledTurnId: string | null;
  controlledQueueAtFinish: boolean;
  controlledCanInject: boolean;
  controlledCanSendDirectly: boolean;
  controlledFinishWaiting: boolean;
  controlledStopPending: boolean;
  preparingChatInternally: () => boolean;
  projectScopedSelection: () => boolean;
  finishGoalDraftView: GoalDraftPresentation | null;
  startingInputs: Map<string, InputEntry>;
  pendingComposerInputs: InputEntry[];
  imageDrafts: Map<string, ComposerAttachment[]>;
  draftKey: () => string;
  paintGoalProgress: () => void;
  currentPreparedPlan: ReturnType<typeof createChatTaskPlan>['currentPreparedPlan'];
  authoredComposerText: () => string;
  pendingComposerInput: () => InputEntry | undefined;
  taskPlans: Pick<ReturnType<typeof createChatTaskPlan>, 'hasPlan'>;
}

export function createChatDeliveryControls(runtime: ChatDeliveryControlsRuntime) {
  let stopCandidateKey: string | null = null;
  let stopCandidateSince = 0;
  let stopCandidateTimer: number | undefined;

  function clearStopCandidate(): void {
    stopCandidateKey = null;
    stopCandidateSince = 0;
    if (stopCandidateTimer !== undefined) {
      window.clearTimeout(stopCandidateTimer);
      stopCandidateTimer = undefined;
    }
  }

  function confirmedWorkingTurn(): boolean {
    const turnId = runtime.controlledTurnId;
    if (!turnId) {
      clearStopCandidate();
      return false;
    }

    const recentActivity = runtime.events.length === 0 || runtime.events.some(event =>
      (event.kind === 'user_message' || event.turnId === turnId) &&
      (event.kind === 'user_message' ||
        ['turn_start', 'assistant_message', 'tool_call', 'page_tool', 'progress'].includes(event.kind)) &&
      Date.now() - event.time < RECENT_TURN_ACTIVITY_MS);
    if (recentActivity) {
      clearStopCandidate();
      return true;
    }

    const key = `${runtime.selectedId ?? ''}:${runtime.selectionGeneration}:${turnId}`;
    if (stopCandidateKey !== key) {
      clearStopCandidate();
      stopCandidateKey = key;
      stopCandidateSince = Date.now();
    }

    const remaining = STALE_STOP_CONFIRMATION_MS - (Date.now() - stopCandidateSince);
    if (remaining <= 0) return true;
    if (stopCandidateTimer === undefined) {
      stopCandidateTimer = window.setTimeout(() => {
        stopCandidateTimer = undefined;
        paintDeliveryControls();
      }, remaining);
    }
    return false;
  }

  function paintDeliveryControls(): void {
    runtime.paintGoalProgress();
    const pending = runtime.pendingComposerInput();
    const internalProjectDelivery = runtime.projectScopedSelection() && !!pending?.warmupDeferred;
    const hiddenProjectComposerDelivery = runtime.projectScopedSelection() && !!pending && !pending.warmupDeferred &&
      pending.authoredSource !== 'none' && !pending.finishOwner && pending.purpose !== 'decision';
    const historyReady = runtime.selectedId !== null && runtime.detailFor === runtime.selectedId;
    const working = historyReady && !transcriptOrSummaryShowsCompletedLatestTurn(runtime.events, runtime.selectedSummary()) &&
      !runtime.preparingChatInternally() && !internalProjectDelivery &&
      runtime.controlledSessionId === runtime.selectedId &&
      runtime.controlledSelection === runtime.selectionGeneration &&
      runtime.controlledTurnId !== null;
    const stopWorking = working && confirmedWorkingTurn();
    if (!working) clearStopCandidate();
    const queueAtFinish = runtime.selectedId !== null &&
      runtime.controlledSessionId === runtime.selectedId &&
      runtime.controlledSelection === runtime.selectionGeneration &&
      runtime.controlledQueueAtFinish;
    const canInject = runtime.selectedId !== null &&
      runtime.controlledSessionId === runtime.selectedId &&
      runtime.controlledSelection === runtime.selectionGeneration &&
      runtime.controlledCanInject;
    const canSendDirectly = runtime.selectedId !== null &&
      runtime.controlledSessionId === runtime.selectedId &&
      runtime.controlledSelection === runtime.selectionGeneration &&
      runtime.controlledCanSendDirectly;
    const files = runtime.imageDrafts.get(runtime.draftKey()) ?? [];
    const nativeFiles = files.some(file => 'id' in file) && !(canInject && injectableAttachments(files));
    $('queueAtFinish').hidden = !queueAtFinish || nativeFiles;
    ui($('afterTurnLabel'), 'textContent', () => queueAtFinish && !nativeFiles ? t("Queue at Session finish") : t("After this turn"));
    const generate = $<HTMLButtonElement>('generateFinishGoal');
    const queued = [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs].some(entry =>
      (entry.sessionId ?? entry.deliveredSessionId) === runtime.selectedId && ['queued', 'browser', 'tool'].includes(entry.state));
    generate.hidden = !working || !runtime.controlledFinishWaiting || queued || runtime.controlledStopPending || !!runtime.finishGoalDraftView;
    generate.disabled = generate.dataset.busy === `${runtime.selectedId}:${runtime.controlledTurnId}`;
    const sendOption = $<HTMLSelectElement>('sendMode').querySelector('option[value="auto"]');
    const immediateLabel = () => nativeFiles && working ? t("After this turn") : canSendDirectly ? t("Send directly") : canInject ? t("Inject now") : t("Send");
    if (sendOption) ui(sendOption, 'textContent', immediateLabel);
    ui($('immediateDeliveryLabel'), 'textContent', immediateLabel);
    const immediateAction = $('sendOptions').querySelector<HTMLElement>('[data-delivery="auto"]');
    if (immediateAction) immediateAction.hidden = (nativeFiles && working) || canInject;
    const injectionAction = $('sendOptions').querySelector<HTMLElement>('[data-delivery="tool"]');
    const explicitInjection = (canInject && (!files.length || injectableAttachments(files))) ||
      (canSendDirectly && files.length > 0 && injectableAttachments(files));
    if (injectionAction) injectionAction.hidden = !explicitInjection;
    if ($<HTMLSelectElement>('sendMode').value === 'tool' && !explicitInjection) $<HTMLSelectElement>('sendMode').value = 'auto';
    if (canInject && explicitInjection && $<HTMLSelectElement>('sendMode').value === 'auto') $<HTMLSelectElement>('sendMode').value = 'tool';
    if (!canInject && !canSendDirectly && !queueAtFinish) $<HTMLSelectElement>('sendMode').value = 'auto';
    const deliveryContextReady = runtime.selectedId === null || historyReady;
    const cancellablePending = deliveryContextReady && !!pending && !internalProjectDelivery &&
      !hiddenProjectComposerDelivery && !runtime.preparingChatInternally();
    const stop = (stopWorking || cancellablePending) && !runtime.currentPreparedPlan() && !runtime.authoredComposerText().trim() &&
      !(runtime.imageDrafts.get(runtime.draftKey())?.length);
    $('sendOptions').hidden = !canInject && !canSendDirectly && !queueAtFinish;
    const send = $<HTMLButtonElement>('chatSend');
    const planMode = runtime.taskPlans.hasPlan(runtime.draftKey());
    const preparedPlan = runtime.currentPreparedPlan();
    const planDisabled = !!preparedPlan && (preparedPlan.sending || preparedPlan.stages.some(stage => !stage.trim()));
    send.disabled = planDisabled;
    send.dataset.action = stop ? 'stop' : 'send';
    ui(send, 'aria-label', () => stop ? (runtime.controlledStopPending ? t("Stop requested") : t("Stop turn")) : t("Send message"));
    if (stop && !working && pending && !internalProjectDelivery && !hiddenProjectComposerDelivery) ui(send, 'aria-label', () => t("Cancel delivery"));
    const planAction = runtime.selectedId ? t("Queue plan at Session finish") : t("Start full plan");
    if (preparedPlan && !stop) send.setAttribute('aria-label', planAction);
    else if (planMode && !stop) ui(send, 'aria-label', () => t("Generate plan"));
    send.classList.toggle('is-plan-ready', !!preparedPlan && !stop);
    ui(send, 'title', () => stop && !working && pending && !internalProjectDelivery && !hiddenProjectComposerDelivery ? t("Cancel delivery") : preparedPlan && !stop ? planAction : planMode && !stop ? t("Click to generate plan") : '');
    send.classList.toggle('is-stop', stop);
    for (const button of $('sendOptions').querySelectorAll<HTMLElement>('[data-delivery]')) {
      button.setAttribute('aria-checked', String(button.dataset.delivery ===
        (nativeFiles && working && $<HTMLSelectElement>('sendMode').value !== 'tool' ? 'after-turn' : $<HTMLSelectElement>('sendMode').value)));
    }
  }

  return { paintDeliveryControls };
}
