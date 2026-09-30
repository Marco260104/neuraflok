import type { InputAutomation } from '../../../contracts/input.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { GoalDraftPresentation, GoalProgressView } from './chat-goal-progress.js';
import { $, run } from '../../shared/dom.js';

export interface ChatAutomationRuntime {
  selectedId: string | null;
  selectedProjectId: string | null;
  selectionGeneration: number;
  goalIntentGeneration: number;
  objectiveEditMode: 'goal' | 'loop' | null;
  goalProgress: GoalProgressView | null;
  goalDraftView: GoalDraftPresentation | null;
  pendingComposerInputs: InputEntry[];
  pendingNewInput: { id: string; generation: number } | null;
  startingInputs: Map<string, InputEntry>;
  inputQueueGeneration: number;
  cancelGoalRequest: () => void;
  paintAutomationSwitch: () => void;
  openObjectiveEditor: (mode: 'goal' | 'loop' | null) => void;
  closeObjectiveEditor: () => void;
  paintTaskActions: () => void;
  paintGoalProgress: () => void;
  paintDeliveryControls: () => void;
  paintLoopDeliveryTitle: () => void;
  openingLoopDelivery: () => boolean | undefined;
  refreshInputQueue: () => Promise<void>;
  refreshSessionControls: () => Promise<void>;
  adoptAcceptedOpening: (entry: InputEntry) => Promise<boolean>;
}

type Runtime = ChatAutomationRuntime;

export function createChatAutomationControls(runtime: Runtime) {
  const api = window.api;

  function bindEvents(): void {
    $('automationSwitch').addEventListener('click', event => {
      const edit = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-edit-mode]');
      if (edit) {
        if (edit.disabled) return;
        runtime.openObjectiveEditor(edit.dataset.editMode as 'goal' | 'loop');
        return;
      }
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
      if (!button || button.disabled) return;
      const select = $<HTMLSelectElement>('chatAutomation');
      select.value = button.dataset.mode!;
      select.dispatchEvent(new Event('change'));
      $<HTMLDetailsElement>('composerSettings').open = false;
      $('composerSettings').querySelector<HTMLElement>('summary')!.focus();
    });

    $('chatAutomation').addEventListener('change', async () => {
      runtime.goalIntentGeneration++;
      const select = $<HTMLSelectElement>('chatAutomation');
      runtime.objectiveEditMode = null;
      runtime.cancelGoalRequest();
      if (select.value === 'off') runtime.goalDraftView = null;
      select.dataset.edited = 'true';
      runtime.paintAutomationSwitch();
      const id = runtime.selectedId;
      const generation = runtime.selectionGeneration;
      const mode = select.value as InputAutomation;
      const opening = id && runtime.pendingComposerInputs.find(row => row.sessionId === id && row.opening && !row.deliveredAt && ['queued', 'browser'].includes(row.state));
      if (opening) {
        runtime.inputQueueGeneration++;
        opening.automation = mode;
        await run(api.setInputAutomation(opening.id, mode));
        void runtime.refreshInputQueue();
        return;
      }
      if (!id) {
        const pending = runtime.pendingNewInput;
        if (pending?.generation === generation) await run(api.setInputAutomation(pending.id, mode));
        return;
      }
      select.disabled = true;
      runtime.paintAutomationSwitch();
      try {
        await run(api.setSessionAutomation(id, mode));
      } finally {
        select.disabled = false;
        if (id === runtime.selectedId && generation === runtime.selectionGeneration) {
          delete select.dataset.edited;
          void runtime.refreshSessionControls();
        }
        runtime.paintAutomationSwitch();
      }
    });

    runtime.paintLoopDeliveryTitle();
    $('loopDelivery').addEventListener('change', async () => {
      const id = runtime.selectedId;
      const generation = runtime.selectionGeneration;
      const select = $<HTMLSelectElement>('loopDelivery');
      runtime.paintLoopDeliveryTitle();
      const opening = id && runtime.pendingComposerInputs.find(row => row.sessionId === id && row.opening && !row.deliveredAt && ['queued', 'browser'].includes(row.state));
      if (opening) {
        runtime.inputQueueGeneration++;
        opening.loopAfterTurn = select.value === 'after-turn';
        opening.automation = $<HTMLSelectElement>('chatAutomation').value as InputAutomation;
        await run(api.setInputAutomation(opening.id, opening.automation, opening.loopAfterTurn));
        void runtime.refreshInputQueue();
        return;
      }
      if (!id) {
        const pending = runtime.pendingNewInput;
        if (pending?.generation === generation)
          await run(api.setInputAutomation(pending.id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, select.value === 'after-turn'));
        return;
      }
      select.disabled = true;
      try {
        await run(api.setSessionAutomation(id, $<HTMLSelectElement>('chatAutomation').value as InputAutomation, select.value === 'after-turn'));
      } finally {
        select.disabled = false;
        if (id === runtime.selectedId && generation === runtime.selectionGeneration) void runtime.refreshSessionControls();
      }
    });

    $('sessionObjective').addEventListener('input', () => {
      runtime.cancelGoalRequest();
      runtime.goalIntentGeneration++;
      $('sessionObjective').dataset.edited = 'true';
      delete $('sessionObjective').dataset.saved;
      runtime.paintTaskActions();
    });
    $('sessionObjectiveMode').addEventListener('change', () => {
      runtime.cancelGoalRequest();
      runtime.goalIntentGeneration++;
      $('sessionObjective').dataset.edited = 'true';
      delete $('sessionObjective').dataset.saved;
      runtime.paintTaskActions();
    });

    $('saveSessionObjective').addEventListener('click', async () => {
      const id = runtime.selectedId;
      const objective = $<HTMLTextAreaElement>('sessionObjective');
      if (!id) {
        const draft = objective.value;
        const mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
        if (!draft.trim()) return;
        runtime.closeObjectiveEditor();
        const selection = runtime.selectionGeneration;
        const intent = runtime.goalIntentGeneration;
        const requestId = crypto.randomUUID();
        const projectId = runtime.selectedProjectId;
        const automation = $<HTMLSelectElement>('chatAutomation');
        automation.value = mode;
        automation.dataset.edited = 'true';
        runtime.paintAutomationSwitch();
        runtime.goalProgress = { requestId, selection, phase: 'preparing', text: '' };
        const button = $<HTMLButtonElement>('saveSessionObjective');
        button.dataset.busy = 'true';
        runtime.paintTaskActions();
        runtime.paintGoalProgress();
        const current = () => runtime.selectedId === null && runtime.selectionGeneration === selection &&
          runtime.goalIntentGeneration === intent && objective.value === draft && automation.value === mode;
        try {
          const result = await api.draftGoalOpening(draft.trim(), mode, requestId);
          const opening = result.ok ? result.data : null;
          if (!result.ok && current() && runtime.goalProgress?.requestId === requestId) runtime.goalProgress.error = result.error;
          if (!current()) {
            if (runtime.goalProgress?.requestId === requestId) {
              runtime.goalProgress.phase = 'paused';
              runtime.paintGoalProgress();
            }
            return;
          }
          if (!opening) {
            if (runtime.goalProgress?.requestId === requestId) {
              runtime.goalProgress.phase = 'failed';
              runtime.goalProgress.error ||= 'Opening message generation failed';
              runtime.paintGoalProgress();
            }
            return;
          }
          const dueAt = Date.now();
          const inputId = crypto.randomUUID();
          const entry: InputEntry = {
            id: inputId,
            sessionId: null,
            projectId,
            text: opening.reply,
            objective: draft.trim(),
            authoredSource: 'objective',
            automation: mode,
            loopAfterTurn: runtime.openingLoopDelivery(),
            mode: 'auto',
            dueAt,
            model: null,
            reasoningEffort: null,
            state: 'queued',
            owner: null,
            createdAt: dueAt,
            conversationId: null
          };
          runtime.startingInputs.set(inputId, entry);
          runtime.pendingNewInput = { id: inputId, generation: selection };
          runtime.goalProgress = { requestId, selection, inputId, phase: 'queued', text: '' };
          runtime.paintDeliveryControls();
          try {
            const accepted = await run(api.sendInput(entry));
            if (accepted) {
              runtime.inputQueueGeneration++;
              runtime.pendingComposerInputs = [...runtime.pendingComposerInputs.filter(row => row.id !== inputId), accepted];
              // Reapply automation changed before the accepted outbox row became visible.
              if (runtime.selectionGeneration === selection && runtime.pendingNewInput?.id === inputId &&
                  (automation.value !== mode || runtime.openingLoopDelivery() !== entry.loopAfterTurn))
                await run(api.setInputAutomation(inputId, automation.value as InputAutomation, runtime.openingLoopDelivery()));
              await runtime.adoptAcceptedOpening(accepted);
              if (current()) objective.dataset.saved = draft;
            } else if (runtime.goalProgress?.requestId === requestId) {
              runtime.goalProgress.phase = 'failed';
              runtime.goalProgress.error = 'Opening message could not be queued';
            }
          } finally {
            runtime.startingInputs.delete(inputId);
            runtime.paintDeliveryControls();
            void runtime.refreshInputQueue();
          }
        } finally {
          delete button.dataset.busy;
          runtime.paintTaskActions();
        }
        return;
      }
      if (objective.dataset.sessionId !== id) return;
      const selection = runtime.selectionGeneration;
      const draft = objective.value;
      const text = objective.value.trim();
      if (!text) return;
      runtime.closeObjectiveEditor();
      const mode = $<HTMLSelectElement>('sessionObjectiveMode').value as 'goal' | 'loop';
      const button = $<HTMLButtonElement>('saveSessionObjective');
      button.dataset.busy = 'true';
      runtime.paintTaskActions();
      const requestId = crypto.randomUUID();
      runtime.goalProgress = { requestId, selection, phase: 'saving', text: '' };
      runtime.paintGoalProgress();
      try {
        const saved = await run(api.setSessionObjective(id, text, mode));
        if (runtime.goalProgress?.requestId === requestId) {
          runtime.goalProgress.phase = saved ? 'saved' : 'failed';
          if (!saved) runtime.goalProgress.error = 'Task could not be saved';
          runtime.paintGoalProgress();
        }
        if (saved && runtime.selectedId === id && runtime.selectionGeneration === selection && objective.value === draft &&
            $<HTMLSelectElement>('sessionObjectiveMode').value === mode) {
          delete objective.dataset.edited;
          objective.dataset.saved = objective.value;
        }
      } finally {
        delete button.dataset.busy;
        runtime.paintTaskActions();
        if (runtime.selectedId === id) void runtime.refreshSessionControls();
      }
    });
  }

  return { bindEvents };
}
