import { supportsFinishAutomation } from '../../../contracts/automation/completion-policy.js';
import type { InputAutomation } from '../../../contracts/input.js';
import type { AppState } from '../../../contracts/types.js';
import type { SessionSummary } from '../../../contracts/session.js';
import type { TaskPlanDraft } from './chat-task-plan.js';
import { observedComposerModel } from './chat-models.js';
import { $, el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

export interface ChatTaskControlsRuntime {
  draftKey(): string;
  selectedId: string | null;
  selectedProjectId: string | null;
  sessions: SessionSummary[];
  selectionGeneration: number;
  controlledSessionId: string | null;
  controlledSelection: number;
  goalDraftStage(): string | undefined;
  hasFinishGoalDraft(): boolean;
  taskPlans: {
    getPlan(key: string): TaskPlanDraft | null;
    projectPlanMode(key?: string): boolean;
    toggleProjectPlanMode(key?: string): void;
    clearProjectPlanMode(key?: string): void;
  };
  state(): AppState | null;
  cancelGoalRequest(): void;
  advanceGoalIntent(): void;
  paintGoalProgress(): void;
  paintDeliveryControls(): void;
}

export function projectComposerControlVisibility(isProjectChat: boolean): { accessPicker: boolean; planButton: boolean } {
  return { accessPicker: isProjectChat, planButton: isProjectChat };
}

// Owns task and automation presentation for the chat composer.
export function createChatTaskControls(runtime: ChatTaskControlsRuntime) {
  let objectiveEditMode: 'goal' | 'loop' | null = null;

  function isProjectChat(): boolean {
    return runtime.selectedId
      ? Boolean(runtime.sessions.find(row => row.id === runtime.selectedId)?.projectId)
      : Boolean(runtime.selectedProjectId);
  }

  function projectPlanMode(): boolean {
    return runtime.taskPlans.projectPlanMode(runtime.draftKey());
  }

  function paintProjectPlanButton(): void {
    const button = document.getElementById('composerPlanBtn');
    if (!button) return;
    const active = projectPlanMode();
    button.hidden = !projectComposerControlVisibility(isProjectChat()).planButton;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    const glyph = button.querySelector<HTMLElement>('.ico');
    if (glyph) glyph.className = `ico ph ${active ? 'ph-check-circle' : 'ph-list-checks'}`;
    const label = button.querySelector('span');
    if (label) ui(label, 'textContent', () => t(active ? 'Plan active' : 'Plan'));
    ui(button, 'aria-label', () => t(active ? 'Plan active' : 'Plan'));
    ui(button, 'title', () => active
      ? t('Plan mode is on. The assistant will read project files and ask before making changes.')
      : t('Read relevant project files and propose a plan before making changes.'));
  }

  function toggleProjectPlanMode(): void {
    const button = document.getElementById('composerPlanBtn');
    if (!button || button.hidden) return;
    try {
      runtime.taskPlans.toggleProjectPlanMode(runtime.draftKey());
    } finally {
      // Keep the toggle feedback synchronous with the user's click, even if another
      // composer repaint is deferred while a restored project chat is settling.
      paintProjectPlanButton();
    }
  }

  // The composer can be restored while switching chats. Delegate from document so
  // replacing its button does not leave the visible Plan control without a handler.
  document.addEventListener('click', event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('#composerPlanBtn');
    if (!target) return;
    event.preventDefault();
    toggleProjectPlanMode();
  });

  function clearProjectPlanMode(key = runtime.draftKey()): void {
    runtime.taskPlans.clearProjectPlanMode(key);
    if (runtime.draftKey() === key) paintProjectPlanButton();
  }

  function goalReachedShown(): boolean {
    return runtime.controlledSessionId === runtime.selectedId && runtime.controlledSelection === runtime.selectionGeneration &&
      runtime.goalDraftStage() === 'no-reply' && !runtime.hasFinishGoalDraft();
  }

  function paintActiveGoal(): void {
    const row = $('activeGoalRow');
    const mode = $<HTMLSelectElement>('chatAutomation').value;
    row.hidden = mode === 'off';
    if (row.hidden) { row.replaceChildren(); return; }
    const objective = $<HTMLTextAreaElement>('sessionObjective').value.trim();
    const reached = mode === 'goal' && goalReachedShown();
    const label = el('span', 'queue-label', () => `${mode === 'loop' ? t('Loop') : reached ? t('Goal reached') : t('Pursuing goal')}${objective ? ' · ' + objective : ''}`);
    label.title = objective;
    row.replaceChildren(icon(reached ? 'i-check' : 'i-pulse'), label,
      dockAction(() => t('Pause automation'), 'i-power', () => { const select = $<HTMLSelectElement>('chatAutomation'); select.value = 'off'; select.dispatchEvent(new Event('change')); }),
      dockAction(() => t('Edit task'), 'i-pencil', event => { event.stopPropagation(); openObjectiveEditor(); }));
  }

  function closeObjectiveEditor(): void {
    $<HTMLDetailsElement>('composerSettings').open = false;
    $('composerSettings').querySelector<HTMLElement>('summary')!.focus();
  }

  function openObjectiveEditor(mode: 'goal' | 'loop' | null = null): void {
    const current = $<HTMLSelectElement>('chatAutomation').value;
    const next = mode && mode !== current ? mode : null;
    if (next && next !== $<HTMLSelectElement>('sessionObjectiveMode').value) {
      runtime.cancelGoalRequest();
      runtime.advanceGoalIntent();
      $('sessionObjective').dataset.edited = 'true';
      delete $('sessionObjective').dataset.saved;
    }
    objectiveEditMode = next;
    paintAutomationSwitch();
    $('composerSettings').classList.remove('mode-picker');
    $<HTMLDetailsElement>('composerSettings').open = true;
    $<HTMLTextAreaElement>('sessionObjective').focus();
  }

  function paintLoopDeliveryTitle(): void {
    const select = $<HTMLSelectElement>('loopDelivery');
    ui(select, 'title', () => select.value === 'after-turn'
      ? t('At Session Finish, or as a new message after verified turn completion')
      : t('Only inside the Session Finish tool result; never start a new turn'));
  }

  function paintTaskActions(): void {
    const objective = $<HTMLTextAreaElement>('sessionObjective');
    const save = $<HTMLButtonElement>('saveSessionObjective');
    const off = $<HTMLSelectElement>('chatAutomation').value === 'off' && !objectiveEditMode;
    objective.hidden = off;
    document.querySelector<HTMLLabelElement>('label[for="sessionObjective"]')!.hidden = off;
    save.hidden = off;
    const saved = objective.dataset.saved === objective.value && !!objective.value.trim();
    save.disabled = objective.disabled || !objective.value.trim() || save.dataset.busy === 'true' || saved;
    ui(save.querySelector('span')!, 'textContent', () => save.dataset.busy === 'true' ? t('Saving…') : saved ? t('Saved') : t('Save task'));
    const button = $<HTMLButtonElement>('createPlan');
    const plan = runtime.taskPlans.getPlan(runtime.draftKey());
    const planMode = !!plan;
    if (plan?.requestId) { button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true'); }
    else { delete button.dataset.busy; button.removeAttribute('aria-busy'); }
    button.disabled = plan?.sending === true;
    button.setAttribute('aria-pressed', String(planMode));
    ui(button.querySelector('span')!, 'textContent', () => t('Plan'));
    ui(button, 'aria-label', () => planMode ? t('Cancel plan') : t('Create plan'));
    ui(button, 'title', () => planMode ? t('Return to a normal message; keep your draft') : t('Split your message into editable stages'));
    paintProjectPlanButton();
  }

  function paintLoopDelivery(): void {
    const model = observedComposerModel();
    $('loopDeliveryRow').hidden = runtime.state()?.config.ui.finishTool !== true || !model ||
      !supportsFinishAutomation($<HTMLSelectElement>('chatAutomation').value as InputAutomation, model.model, model.reasoningEffort);
  }

  function openingLoopDelivery(): boolean | undefined {
    return runtime.selectedId === null ? $<HTMLSelectElement>('loopDelivery').value === 'after-turn' : undefined;
  }

  function paintAutomationSwitch(): void {
    paintLoopDelivery();
    runtime.paintGoalProgress();
    paintActiveGoal();
    const select = $<HTMLSelectElement>('chatAutomation');
    const mode = select.value;
    $('composerModeIcon').className = `ico ph ph-${mode === 'loop' ? 'arrows-clockwise' : mode === 'goal' ? 'target' : 'chat-circle'}`;
    $('composerSettings').dataset.mode = mode;
    ui($('composerModeLabel'), 'textContent', () => mode === 'off' ? t('Normal') : mode === 'goal' ? t('Goal') : t('Loop'));
    for (const button of $('automationSwitch').querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.setAttribute('aria-checked', String(button.dataset.mode === select.value));
      button.disabled = select.disabled;
    }
    for (const button of $('automationSwitch').querySelectorAll<HTMLButtonElement>('[data-edit-mode]')) button.disabled = select.disabled;
    if (objectiveEditMode === select.value) objectiveEditMode = null;
    const editMode = objectiveEditMode ?? (select.value === 'loop' ? 'loop' : 'goal');
    $<HTMLSelectElement>('sessionObjectiveMode').value = editMode;
    const loop = editMode === 'loop';
    ui(document.querySelector('label[for="sessionObjective"]')!, 'textContent', () => loop ? t('Loop instructions') : t('Goal'));
    ui($<HTMLTextAreaElement>('sessionObjective'), 'placeholder', () => loop ? t('What should each continuation focus on?') : t('Optional. Leave empty to work toward what you asked in this chat.'));
    const accessPicker = $<HTMLDetailsElement>('composerAccess');
    const projectControls = projectComposerControlVisibility(isProjectChat());
    accessPicker.hidden = !projectControls.accessPicker;
    if (accessPicker.hidden) accessPicker.open = false;
    paintProjectPlanButton();
    paintTaskActions();
  }

  function dockAction(label: string | (() => string), symbol: string, click: (event: MouseEvent) => void): HTMLButtonElement {
    const button = el('button', 'dock-action') as HTMLButtonElement;
    const description = typeof label === 'function' ? label : () => label;
    ui(button, 'title', description);
    ui(button, 'aria-label', description);
    button.type = 'button';
    button.append(icon(symbol));
    button.onclick = click;
    return button;
  }

  return {
    get objectiveEditMode() { return objectiveEditMode; },
    set objectiveEditMode(value: 'goal' | 'loop' | null) { objectiveEditMode = value; },
    goalReachedShown,
    paintActiveGoal,
    closeObjectiveEditor,
    openObjectiveEditor,
    paintLoopDeliveryTitle,
    paintTaskActions,
    paintLoopDelivery,
    openingLoopDelivery,
    paintAutomationSwitch,
    isProjectChat,
    projectPlanMode,
    toggleProjectPlanMode,
    clearProjectPlanMode
  };
}
