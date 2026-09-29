import type { initSkills } from '../settings/skill-composer/composer.js';
import type { ComposerDraftOwner } from './chat-composer-attachments.js';
import { $ } from '../../shared/dom.js';

type SkillPicker = ReturnType<typeof initSkills>;
export interface NewChatTaskDraft {
  objective: string;
  automation: string;
  loopDelivery: string;
}

interface ChatDraftStateRuntime {
  get selectedId(): string | null;
  get selectedProjectId(): string | null;
  get skillPicker(): SkillPicker | undefined;
  cancelGoalRequest(): void;
  paintTaskPlan(): void;
  paintComposerImages(): void;
  paintLoopDeliveryTitle(): void;
}

export function createChatDraftState(runtime: ChatDraftStateRuntime) {
  const inputDrafts = new Map<string, string>();
  const newChatTasks = new Map<string, NewChatTaskDraft>();
  // A replacement invalidates imports even when navigation returns to the same key.
  let generation = 0;

  function draftKey(): string {
    return runtime.selectedId ?? (runtime.selectedProjectId ? `project:${runtime.selectedProjectId}` : 'new');
  }

  function authoredText(): string {
    return runtime.skillPicker?.authoredText() ?? $<HTMLTextAreaElement>('chatInput').value;
  }

  function rememberDraft(): void {
    const key = draftKey();
    inputDrafts.set(key, authoredText());
    if (runtime.selectedId === null) newChatTasks.set(key, {
      objective: $<HTMLTextAreaElement>('sessionObjective').value,
      automation: $<HTMLSelectElement>('chatAutomation').value,
      loopDelivery: $<HTMLSelectElement>('loopDelivery').value
    });
  }

  function restoreDraft(): void {
    runtime.skillPicker?.close();
    runtime.cancelGoalRequest();
    $('activeGoalRow').hidden = true;
    $('recoveryStatus').hidden = true;
    const key = draftKey();
    $<HTMLTextAreaElement>('chatInput').value = inputDrafts.get(key) ?? '';
    runtime.skillPicker?.restore();
    const task = runtime.selectedId === null ? newChatTasks.get(key) : undefined;
    const automation = $<HTMLSelectElement>('chatAutomation');
    automation.value = task?.automation ?? 'off';
    delete automation.dataset.edited;
    $<HTMLSelectElement>('loopDelivery').value = task?.loopDelivery ?? 'finish';
    runtime.paintLoopDeliveryTitle();
    $<HTMLTextAreaElement>('sessionObjective').value = task?.objective ?? '';
    delete $('sessionObjective').dataset.edited;
    delete $('sessionObjective').dataset.sessionId;
    delete $('sessionObjective').dataset.saved;
    runtime.paintTaskPlan();
    runtime.paintComposerImages();
  }

  return {
    draftKey,
    authoredText,
    rememberDraft,
    restoreDraft,
    composerDraftOwner: (): ComposerDraftOwner => ({ key: draftKey(), generation }),
    ownsComposerDraft: (owner: ComposerDraftOwner): boolean => owner.key === draftKey() && owner.generation === generation,
    replaceComposerDraft(): void {
      generation++;
      runtime.skillPicker?.close();
    },
    get generation(): number { return generation; },
    inputDrafts,
    newChatTasks
  };
}
