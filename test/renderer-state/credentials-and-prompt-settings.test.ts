import { mountChat, settle } from './context.js';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from "../../contracts/automation/goal-prompts.js";
import { DEFAULT_HANDOFF_PROMPT } from "../../contracts/sessions/continuity-brief.js";
import { expect, it, vi } from 'vitest';

it('reports stored API credentials without exposing app-wide Goal switches', async () => {
  const mounted = await mountChat();
  expect(mounted.window.document.getElementById('goalEnabled')).toBeNull();
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(true);

  mounted.push({ ...mounted.state, hasGoalKey: true });
  await settle();
  expect(mounted.window.document.getElementById('goalKeyState')!.textContent).toContain('A key is stored');
  expect((mounted.window.document.getElementById('goalKeyRemove') as HTMLButtonElement).disabled).toBe(false);
});

it('sends the key to the secret store and never into the settings patch', async () => {
  const mounted = await mountChat();
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = 'sk-or-v1-not-a-real-key';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();

  expect(mounted.keys).toEqual([{ method: 'setGoalKey', value: 'sk-or-v1-not-a-real-key' }]);
  // Cleared from the input as well: a stored key has no reason to stay on screen.
  expect(field.value).toBe('');
  expect(JSON.stringify(mounted.calls)).not.toContain('sk-or-v1');
});

it('keeps secret-key input on secure-storage failure', async () => {
  const failed = await mountChat({}, [], {
    setGoalKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' }),
    setCustomProviderKey: () => Promise.resolve({ ok: false, error: 'safeStorage unavailable' })
  });
  const goalFailed = failed.window.document.getElementById('goalKey') as HTMLInputElement;
  goalFailed.value = 'sk-or-v1-retry-me';
  goalFailed.dispatchEvent(new failed.window.Event('blur'));
  const customFailed = failed.window.document.getElementById('goalCustomKey') as HTMLInputElement;
  customFailed.value = 'custom-retry-me';
  customFailed.dispatchEvent(new failed.window.Event('blur'));
  await settle();
  expect(goalFailed.value).toBe('sk-or-v1-retry-me');
  expect(customFailed.value).toBe('custom-retry-me');
});

it('never lets an older secret save erase a newer value typed while IPC is in flight', async () => {
  let releaseGoal!: (value: any) => void;
  let releaseCustom!: (value: any) => void;
  const deferred = await mountChat({}, [], {
    setGoalKey: () => new Promise((resolve) => (releaseGoal = resolve)),
    setCustomProviderKey: () => new Promise((resolve) => (releaseCustom = resolve))
  }, {}, { kind: 'custom', baseUrl: 'https://example.test/v1' });
  const goal = deferred.window.document.getElementById('goalKey') as HTMLInputElement;
  goal.value = 'sk-or-v1-old';
  goal.dispatchEvent(new deferred.window.Event('blur'));
  goal.value = 'sk-or-v1-new';
  const custom = deferred.window.document.getElementById('goalCustomKey') as HTMLInputElement;
  custom.value = 'custom-old';
  custom.dispatchEvent(new deferred.window.Event('blur'));
  custom.value = 'custom-new';

  releaseGoal({ ok: true, data: { ...deferred.state, hasGoalKey: true } });
  releaseCustom({ ok: true, data: { ...deferred.state, hasCustomProviderKey: true } });
  await settle();
  await settle();
  expect(goal.value).toBe('sk-or-v1-new');
  expect(custom.value).toBe('custom-new');
});

it('does not turn whitespace in the OpenRouter key field into a remove-key request', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const field = mounted.window.document.getElementById('goalKey') as HTMLInputElement;
  field.value = '   ';
  field.dispatchEvent(new mounted.window.Event('blur'));
  await settle();
  expect(mounted.keys).toEqual([]);
  expect(field.value).toBe('   ');
});

it('opens, saves and restores the editable goal prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('goalPromptPanel')!;
  const edit = doc.getElementById('goalPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('goalPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);

  prompt.value = 'custom gate: continue only explicit missing work. otherwise NO_REPLY.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(prompt.value);

  (doc.getElementById('goalPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
  expect(mounted.calls.at(-1)?.goal.prompt).toBe(DEFAULT_GOAL_SYSTEM_PROMPT);
});

it('asks before Clear workers ends running workers and removes their histories', async () => {
  const resetSwarm = vi.fn(async () => ({ ok: true as const, data: { running: false, agents: [], retainedHistory: false } }));
  const mounted = await mountChat({ hasGoalKey: true }, [], { resetSwarm });
  const w = mounted.window;
  const button = w.document.getElementById('swarmReset') as HTMLButtonElement;
  button.disabled = false;
  const confirm = vi.fn(() => false);
  w.confirm = confirm;
  button.click();
  await settle();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('removed for good'));
  expect(resetSwarm).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  button.click();
  await settle();
  expect(resetSwarm).toHaveBeenCalledTimes(1);
});

it('opens, saves and restores the editable handoff prompt', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const panel = doc.getElementById('handoffPromptPanel')!;
  const edit = doc.getElementById('handoffPromptEdit') as HTMLButtonElement;
  const prompt = doc.getElementById('handoffPrompt') as HTMLTextAreaElement;

  expect(panel.hidden).toBe(true);
  edit.click();
  expect(panel.hidden).toBe(false);
  expect(prompt.value).toBe(DEFAULT_HANDOFF_PROMPT);

  prompt.value = 'Keep only continuation-critical state and the exact next action.';
  prompt.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(prompt.value);

  (doc.getElementById('handoffPromptReset') as HTMLButtonElement).click();
  await settle();
  await settle();
  expect(prompt.value).toBe(DEFAULT_HANDOFF_PROMPT);
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(DEFAULT_HANDOFF_PROMPT);
});

it('offers the handoff length, starting at the thorough default, and saves a shorter choice', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const length = mounted.window.document.getElementById('handoffLength') as HTMLSelectElement;
  expect(length.value).toBe('thorough');
  expect([...length.options].map(option => option.value)).toEqual(['thorough', 'standard', 'short']);
  length.value = 'short';
  length.dispatchEvent(new mounted.window.Event('change'));
  await settle();
  await settle();
  expect(mounted.calls.at(-1)?.compaction.handoffLength).toBe('short');
  expect(mounted.calls.at(-1)?.compaction.handoffPrompt).toBe(DEFAULT_HANDOFF_PROMPT);
});
