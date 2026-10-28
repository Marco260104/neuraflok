import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('updates the visible project Plan toggle when clicked and when clicked again', async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="composerPlanBtn" type="button" hidden aria-pressed="false">
      <i class="ico ph ph-list-checks"></i><span>Plan</span>
    </button>
    <textarea id="sessionObjective"></textarea>
    <label for="sessionObjective">Goal</label>
    <button id="saveSessionObjective"><span>Save task</span></button>
    <select id="chatAutomation"><option value="off">Off</option></select>
    <button id="createPlan"><span>Plan</span></button>
  </body></html>`, { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);

  const { createChatTaskControls } = await import('../frontend/features/chat/chat-task-controls.js');
  let active = false;
  let controls!: ReturnType<typeof createChatTaskControls>;
  controls = createChatTaskControls({
    draftKey: () => 'project:one',
    selectedId: null,
    selectedProjectId: 'project-one',
    sessions: [],
    selectionGeneration: 0,
    controlledSessionId: null,
    controlledSelection: 0,
    goalDraftStage: () => undefined,
    hasFinishGoalDraft: () => false,
    taskPlans: {
      getPlan: () => null,
      projectPlanMode: () => active,
      toggleProjectPlanMode: () => { active = !active; controls.paintTaskActions(); },
      clearProjectPlanMode: () => { active = false; controls.paintTaskActions(); }
    },
    state: () => null,
    cancelGoalRequest: () => undefined,
    advanceGoalIntent: () => undefined,
    paintGoalProgress: () => undefined,
    paintDeliveryControls: () => undefined
  });

  const button = dom.window.document.querySelector<HTMLButtonElement>('#composerPlanBtn')!;
  controls.paintTaskActions();
  expect(button.hidden).toBe(false);
  expect(button.getAttribute('aria-pressed')).toBe('false');

  button.click();
  expect(button.getAttribute('aria-pressed')).toBe('true');
  expect(button.classList.contains('is-active')).toBe(true);
  expect(button.querySelector('.ico')?.classList.contains('ph-check-circle')).toBe(true);
  expect(button.querySelector('span')?.textContent).not.toBe('Plan');

  button.click();
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(button.classList.contains('is-active')).toBe(false);
  expect(button.querySelector('.ico')?.classList.contains('ph-list-checks')).toBe(true);
  expect(button.querySelector('span')?.textContent).toBe('Plan');
  dom.window.close();
});
