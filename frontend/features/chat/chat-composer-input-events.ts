import { $ } from '../../shared/dom.js';
import type { ComposerAttachment } from './chat-composer-attachments.js';
import type { createChatTaskPlan } from './chat-task-plan.js';

export interface ChatComposerInputRuntime {
  draftKey: () => string;
  authoredComposerText: () => string;
  imageDrafts: Map<string, ComposerAttachment[]>;
  taskPlans: ReturnType<typeof createChatTaskPlan>;
  skillPicker: { keydown: (event: KeyboardEvent) => boolean } | null | undefined;
  objectiveEditMode: 'goal' | 'loop' | null;
  paintAutomationSwitch: () => void;
  paintDeliveryControls: () => void;
  paintTaskActions: () => void;
  currentPreparedPlan: () => unknown;
  sendPreparedPlan: () => Promise<void>;
  createTaskPlan: (backend: 'api' | 'web') => Promise<void>;
  sendComposer: (delivery?: 'finish', plan?: string[], planObjective?: string, controlAction?: boolean) => Promise<boolean | void>;
  planBackend: () => 'api' | 'web';
}

type Runtime = ChatComposerInputRuntime;

export function bindChatComposerInputEvents(runtime: Runtime): void {
  $('chatInput').addEventListener('input', () => {
    const hasText = !!runtime.authoredComposerText().trim();
    const key = runtime.draftKey();
    const plan = runtime.taskPlans.getPlan(key);
    if (plan && !plan.stages && plan.requestId) {
      runtime.taskPlans.cancelTaskPlan(key);
      if (hasText) runtime.taskPlans.setPlan(key, { text: '', requestId: null, stages: null, sending: false, progress: null, error: null });
    }
    runtime.paintDeliveryControls();
    runtime.paintTaskActions();
  });

  $('chatInput').addEventListener('keydown', event => {
    if (runtime.skillPicker?.keydown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (runtime.currentPreparedPlan() || runtime.authoredComposerText().trim() || runtime.imageDrafts.get(runtime.draftKey())?.length)
        $<HTMLFormElement>('composer').requestSubmit();
    }
  });

  $('composerSettings').addEventListener('toggle', runtime.paintTaskActions);
  $('composerSettings').querySelector('summary')!.addEventListener('click', () => {
    if (!$<HTMLDetailsElement>('composerSettings').open) {
      $('composerSettings').classList.add('mode-picker');
      if (runtime.objectiveEditMode) {
        runtime.objectiveEditMode = null;
        runtime.paintAutomationSwitch();
      }
    }
  });

  $('createPlan').addEventListener('click', () => {
    if (runtime.taskPlans.hasPlan(runtime.draftKey())) runtime.taskPlans.cancelTaskPlan();
    else {
      runtime.taskPlans.setPlan(runtime.draftKey(), { text: '', requestId: null, stages: null, sending: false, progress: null, error: null });
      runtime.taskPlans.paintTaskPlan();
      $('chatInput').focus();
    }
  });

  $('composer').addEventListener('submit', event => {
    event.preventDefault();
    if ($<HTMLButtonElement>('chatSend').disabled) return;
    const controlAction = event.submitter === $('chatSend') && $('chatSend').dataset.action === 'stop';
    if (runtime.currentPreparedPlan()) void runtime.sendPreparedPlan();
    else if (runtime.taskPlans.hasPlan(runtime.draftKey())) {
      if (!$('createPlan').dataset.busy) void runtime.createTaskPlan(runtime.planBackend());
    } else void runtime.sendComposer(undefined, undefined, undefined, controlAction);
  });
}
