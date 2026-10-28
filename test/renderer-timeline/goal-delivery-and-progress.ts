import { expect, it, vi } from 'vitest';
import type { SessionEvent } from "../../contracts/session.js";
import type { InputArgs } from "../../backend/domains/sessions/input/input.js";

import { T0, boot, settle, summary, text } from './context.js';

it('disables empty task actions and confirms saving without the old helper sentence', async () => {
  const { w } = await boot([], false);
  const save = w.document.getElementById('saveSessionObjective') as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click();
  expect(w.document.activeElement?.id).toBe('chatInput');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toContain('plan');
  expect(w.document.getElementById('chatSend')!.title).toBe('Click to generate plan');
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Generate plan');
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).placeholder).toBe('Ask anything…');
  expect(w.document.getElementById('chatSend')!.title).toBe('');
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); save.click(); await settle();
  expect(save.textContent).toContain('Saved'); expect(save.disabled).toBe(true);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');
  objective.value += ' everything'; objective.dispatchEvent(new w.Event('input'));
  expect(save.disabled).toBe(false); expect(save.textContent).not.toContain('Saved');
});

it('omits the selected worker identity but retains a different sender', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'assistant_message', agent: 'worker-2', message: text('Own reply'), final: true },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'assistant_message', agent: 'worker-3', message: text('Other reply'), final: true }
  ];
  const { w } = await boot(events, true, [], [], { origin: { kind: 'worker', agentId: 'worker-2', fromSessionId: 'parent', task: 'Audit' } });
  const labels = [...w.document.querySelectorAll('.ev-body > .chip')].map(el => el.textContent);
  expect(labels).toEqual(['worker-3']);
  expect(w.document.querySelector('.timeline')?.textContent ?? w.document.body.textContent).toContain('Own reply');
});

it('renders one legacy interrupted-response card across reloads and updates it after completion', async () => {
  const error: SessionEvent = { seq: 2, time: T0 + 2, source: 'extension', kind: 'chat_error', turnId: 'original', recoverable: true, message: text('Connection interrupted') };
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'question', message: text('Build') },
    error, { ...error, seq: 3, turnId: undefined }, { ...error, seq: 4, turnId: 'replacement' },
    { seq: 5, time: T0 + 5, source: 'app', kind: 'progress', turnId: 'replacement', progressId: 'browser-repair:test', message: text('Reloaded chat') }
  ]);
  expect(w.document.querySelectorAll('.chat-error-notice')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('Reloaded chat');
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(false);
  await append([{ seq: 6, time: T0 + 6, source: 'extension', kind: 'assistant_message', final: true, messageId: 'answer', message: text('Done') }]);
  expect(w.document.querySelectorAll('.chat-error-notice')).toHaveLength(1);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('later completed');
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(true);
  expect(w.document.querySelector('.chat-error-notice strong')!.textContent).toBe('Recovered after interruption');
  await append([{ seq: 7, time: T0 + 7, source: 'app', kind: 'turn_start', turnId: 'replacement' }]);
  expect(w.document.querySelector('.chat-error-notice')!.classList.contains('is-resolved')).toBe(false);
  expect(w.document.querySelector('.chat-error-notice')!.textContent).toContain('Work continued');
});

it('explicitly queues an image injection before the first MCP call without choosing browser delivery', async () => {
  const app = await boot([]);
  const api = (app.w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { sessionId: summary([]).id,
    activeTurnId: 'plain-turn', canInject: false, canSendDirectly: true, queueAtFinish: false } });
  await app.append([]);
  const image = { id: '11111111-2222-4333-8444-555555555555', name: 'image.png', mimeType: 'image/png', size: 42 };
  api.chooseFiles = async () => ({ ok: true, data: [image] });
  app.w.document.getElementById('attachImages')!.click(); await settle();
  const action = app.w.document.querySelector('[data-delivery="tool"]') as HTMLButtonElement;
  expect(action.hidden).toBe(false); action.click();
  (app.w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'Describe this image';
  app.w.document.getElementById('composer')!.dispatchEvent(new app.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(app.live.sent).toHaveLength(1);
  expect(app.live.sent[0]).toMatchObject({ mode: 'auto', delivery: 'tool', text: 'Describe this image', attachments: [image] });
});

it('docks recent app repair progress without hiding authored lookalikes', async () => {
  const events: SessionEvent[] = [
    { seq: 1, time: Date.now(), source: 'app', kind: 'progress', progressId: 'browser-repair:test', message: text('Restored the browser connection') },
    { seq: 2, time: Date.now(), source: 'extension', kind: 'assistant_message', message: text('Reopened chat to recover a missing browser tab.'), final: true }
  ];
  const { w } = await boot(events);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Restored the browser connection');
  expect(w.document.querySelectorAll('.ev-progress')).toHaveLength(0);
  expect(w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Reopened chat');
  w.document.getElementById('newChat')!.click();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('keeps historical repair details in developer mode without reviving a status', async () => {
  const { w } = await boot([{ seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'browser-repair:old', message: text('Historical repair') }], true, [], [], { developerMode: true });
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.querySelector('.ev-progress')!.textContent).toContain('Historical repair');
});

it('keeps accepted pending-send Stop while the durable queue refresh is still in flight', async () => {
  const { w } = await boot([], false);
  const api = (w as any).api;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  const listings: Array<(value: any) => void> = [];
  api.listInputs = () => new Promise(resolve => listings.push(resolve));
  api.sendInput = async (value: InputArgs) => ({ ok: true, data: { ...value, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null } });
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('stop');
  await settle();
  expect(send.dataset.action).toBe('stop');
  listings[0]!({ ok: true, data: [] });
  await settle();
  expect(send.dataset.action).toBe('stop');
});

it('dismisses only the displayed recovery revision and reveals a changed status or new incident', async () => {
  const time = Date.now();
  const repair: SessionEvent = { seq: 1, time, source: 'app', kind: 'progress', progressId: 'browser-repair:dismiss', message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode: true });
  const status = w.document.getElementById('recoveryStatus')!;
  const dismiss = () => (status.querySelector('[aria-label="Dismiss recovery notice"]') as HTMLButtonElement).click();
  expect(status.hidden).toBe(false); dismiss(); expect(status.hidden).toBe(true);
  expect(live.events).toEqual([repair]);
  expect(w.document.querySelector('.ev-progress')?.textContent).toContain('Reloaded chat');
  await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 2, message: text('The browser connection is restored.') }]);
  expect(status.hidden).toBe(false); expect(status.textContent).toContain('connection is restored');
  dismiss(); await append([]); expect(status.hidden).toBe(true);
  await append([{ ...repair, seq: 3, progressId: 'browser-repair:new' }]);
  expect(status.hidden).toBe(false);
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).disabled).toBe(false);
});

it('blocks an empty stage, deletes it explicitly, and hides the whole dock in settings', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Write poem', 'Verify lines'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Rain poem'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = ''; stage.dispatchEvent(new w.Event('input'));
  expect(stage.getAttribute('aria-invalid')).toBe('true');
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(true);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  expect((w.document.getElementById('chatSend') as HTMLButtonElement).disabled).toBe(false);
  const chat = await import("../../frontend/features/chat/chat.js");
  chat.openChatView('settings');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(true);
  chat.openChatView('timeline');
  expect(w.document.getElementById('composerDock')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle(); expect(live.sent[0]).toMatchObject({ text: 'Verify lines', stages: [] });
});

it('cancels pending planning without replacing the draft with a late result', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep this draft';
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  plan.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  plan.click();
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Stale cancelled plan' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale cancelled plan');
  finish({ ok: true, data: ['First', 'Second'] }); await settle();
  expect(input.value).toBe('Keep this draft');
  expect(plan.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(0);
});

it('keeps completed stages after clearing or replacing the composer until explicitly deleted', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  for (const replacement of ['', 'Unrelated next message', '']) {
    input.value = replacement; input.dispatchEvent(new w.Event('input'));
    expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
    expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Verify it');
  }
  expect(live.sent).toHaveLength(0);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(1);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Delete stage 1"]')!.click();
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
});

it('queues every generated stage in an existing session without Send and preserves them after clearing the composer', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, text: 'Build foundation', stages: ['Verify it'], mode: 'finish', model: null, reasoningEffort: null, authoredSource: 'objective' });
  expect(input.value).toBe('');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.querySelectorAll('[aria-label="Remove queued task"]')).toHaveLength(2);
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  api.cancelInput = vi.fn(async (id: string) => { live.inputs = live.inputs.filter(row => row.id !== id); return { ok: true, data: true }; });
  w.document.querySelector<HTMLButtonElement>('[aria-label="Remove queued task"]')!.click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(live.sent).toHaveLength(1);
});

it('retries a materialized finish checkpoint without recreating its already independent siblings', async () => {
  const { w, live, append } = await boot([]);
  live.inputs = [{ id: 'failed-first-checkpoint', sessionId: summary([]).id, text: 'Retry just this checkpoint', stages: ['Deleted sibling'],
    stagesApplied: true, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null, state: 'failed', owner: null,
    createdAt: 0, conversationId: 'chat-b', error: 'Provider rejected opted-in after-turn delivery' }];
  await append([]);
  w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!.click(); await settle();
  expect((w.document.getElementById('chatInput') as HTMLTextAreaElement).value).toBe('Retry just this checkpoint');
  expect(live.sent).toHaveLength(0);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
});

it('retains a rejected queue admission independently of composer edits and retries as finish only', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let reject!: (value: unknown) => void;
  api.sendInput = vi.fn(() => new Promise(resolve => { reject = resolve; }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan the remaining checks';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  reject({ ok: false, error: 'Queue full' }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(2);
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Queue plan at Session finish');
  api.sendInput = send;
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ mode: 'finish', text: 'First checkpoint', stages: ['Last checkpoint'] });
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
});

it('clears the planner prompt and starts a new-chat plan with Enter without overriding provider model selection', async () => {
  const { w, live } = await boot([], false);
  (w as any).api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['Build foundation', 'Verify it'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original objective';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(input.value).toBe('');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, cancelable: true }));
  await settle(); expect(live.sent).toHaveLength(0);
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ objective: 'Original objective', text: 'Build foundation', stages: ['Verify it'], model: null, reasoningEffort: null });
});

it('does not erase a new composer draft while completed-plan queue admission is pending', async () => {
  const { w } = await boot([]);
  const api = (w as any).api, send = api.sendInput;
  let admit!: () => Promise<void>;
  api.sendInput = vi.fn((args: InputArgs) => new Promise(resolve => { admit = async () => resolve(await send(args)); }));
  api.draftTaskPlan = vi.fn(async () => ({ ok: true, data: ['First checkpoint', 'Last checkpoint'] }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Planner request';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  expect(input.value).toBe('');
  input.value = 'My next correction'; input.dispatchEvent(new w.Event('input'));
  await admit(); await settle();
  expect(input.value).toBe('My next correction');
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
});

it('clearing the complete planner task cancels generation and restores Create plan', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Write a poem'; w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalled();
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('createPlan')!.textContent).toBe('Plan');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-label')).toBe('Create plan');
  finish({ ok: true, data: ['Old stage', 'Old check'] }); await settle();
  expect(live.sent).toHaveLength(0);
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
});

it('routes an armed empty-composer plan through the planner and paints only its live progress', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  let finish!: (value: unknown) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  w.document.getElementById('createPlan')!.click();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Create an SVG cat';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(0);
  expect(api.draftTaskPlan.mock.calls[0][0]).toBe('Create an SVG cat');
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  progress({ requestId: 'another-request', phase: 'generating', text: 'Wrong work' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Wrong work');
  progress({ requestId, phase: 'generating', text: 'Design the SVG paths' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Design the SVG paths');
  progress({ requestId, phase: 'retrying', text: '', attempt: 2, retryAt: Date.now() + 30000, error: 'rate_limited' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Provider busy · retry 2');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  finish({ ok: true, data: ['Write SVG paths', 'Validate the SVG'] }); await settle();
  expect(live.sent).toHaveLength(0);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Write SVG paths', stages: ['Validate the SVG'] });
});

it('does not turn an empty or repeated form submission into a Stop request', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  const form = w.document.getElementById('composer')!;
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(stop).not.toHaveBeenCalled();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'A single correction'; input.dispatchEvent(new w.Event('input'));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent.map(row => row.text)).toEqual(['A single correction']);
  expect(stop).not.toHaveBeenCalled();
});

it('keeps actual-turn Stop through two authored sends and stops only the captured active turn', async () => {
  const { w, live, append } = await boot([]);
  const api = (w as any).api;
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  api.cancelInput = cancel;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  const startedAt = Date.now();
  await append([
    { seq: 1, time: startedAt, source: 'app', kind: 'user_message', messageId: 'current-question', message: text('Current question') },
    { seq: 2, time: startedAt + 1, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }
  ]);
  for (const text of ['First new direction', 'Second new direction']) {
    expect(send.dataset.action).toBe('stop');
    input.value = text; input.dispatchEvent(new w.Event('input'));
    expect(send.dataset.action).toBe('send');
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    expect(send.dataset.action).toBe('stop');
    await settle();
    expect(send.dataset.action).toBe('stop');
  }
  expect(live.sent.map(row => row.text)).toEqual(['First new direction', 'Second new direction']);
  expect(live.sent.every(row => row.sessionId === '2026-09-02-test0001' && row.mode === 'auto')).toBe(true);
  // A queued follow-up does not replace the real active turn as Stop's authority.
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(cancel).not.toHaveBeenCalled();
  expect(input.value).toBe('');
});

it('keeps a reselected chat on Send when a stale controls read resolves', async () => {
  const { w } = await boot([{ seq: 1, time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  const api = (w as any).api;
  const baseControls = api.getSessionControls;
  const original = async (id: string) => ({ ok: true, data: { ...(await baseControls(id)).data,
    plan: { updatedAt: 2, plan: [{ step: 'Current plan', status: 'in_progress', details: 'Current selection' }] } } });
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  api.stopSessionTurn = stop;
  let resolve!: (value: any) => void;
  api.getSessionControls = () => new Promise(done => { resolve = done; });
  w.document.getElementById('chatSend')!.click();
  api.getSessionControls = original;
  w.document.getElementById('newChat')!.click();
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  await settle();
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  resolve({ ok: true, data: { ...(await original('2026-09-02-test0001')).data,
    plan: { updatedAt: 1, plan: [{ step: 'Stale plan', status: 'pending' }] } } });
  await settle();
  expect(stop).not.toHaveBeenCalled();
  expect(w.document.getElementById('chatSend')!.dataset.action).toBe('send');
  expect(w.document.getElementById('chatSend')!.classList.contains('is-stop')).toBe(false);
  expect(w.document.getElementById('agentPlan')!.textContent).toContain('Current plan');
  expect(w.document.getElementById('agentPlan')!.textContent).not.toContain('Stale plan');
});

it('streams a new Goal opening, queues it once, and displays authoritative delivery failure', async () => {
  const { w, live, progress, append } = await boot([], false);
  let finish!: (value: any) => void;
  const opening = vi.fn((_text: string, _mode: string, _requestId: string) => new Promise(resolve => { finish = resolve; }));
  (w as any).api.draftGoalOpening = opening;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Implement and verify'; objective.dispatchEvent(new w.Event('input'));
  (w.document.getElementById('saveSessionObjective') as HTMLButtonElement).click();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Preparing the opening message');
  expect(row.getAttribute('aria-busy')).toBe('true');
  const requestId = opening.mock.calls[0]![2];
  progress({ requestId: 'unrelated-request', phase: 'generating', text: 'Wrong Goal' });
  expect(row.textContent).not.toContain('Wrong Goal');
  progress({ requestId, phase: 'retrying', text: '', error: 'rate_limited', attempt: 2, retryAt: Date.now() + 30000 });
  expect(row.textContent).toContain('Provider busy · retry 2');
  expect(row.getAttribute('aria-busy')).toBe('true');
  progress({ requestId, phase: 'generating', text: 'Inspect the existing code first' });
  expect(row.textContent).toContain('Inspect the existing code first');
  expect(live.sent).toEqual([]);
  finish({ ok: true, data: { reply: 'Inspect and implement the task', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Inspect and implement the task', objective: 'Implement and verify', automation: 'goal', authoredSource: 'objective', model: null, reasoningEffort: null });
  expect(row.textContent).toContain('Opening message queued');
  live.inputs = live.inputs.map(input => ({ ...input, state: 'failed', error: 'Model could not be selected' }));
  await append([]);
  expect(row.textContent).toContain('Model could not be selected');
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('preserves an Off goal and never sends its late generated opening after Off and On', async () => {
  const { w, live, progress } = await boot([], false);
  const cancel = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.cancelTaskRequest = cancel;
  let finish!: (value: any) => void;
  let requestId = '';
  (w as any).api.draftGoalOpening = (_text: string, _mode: string, id: string) => { requestId = id; return new Promise(resolve => { finish = resolve; }); };
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Keep this objective'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  for (const mode of ['off', 'goal']) (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
  expect(cancel).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Late provider text' });
  finish({ ok: true, data: { reply: 'Must not send', model: 'fixture' } });
  await settle();
  expect(live.sent).toEqual([]);
  expect(objective.value).toBe('Keep this objective');
  expect(w.document.getElementById('goalLifecycle')!.hidden).toBe(true);
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Late provider text');
});

it.each(['navigate', 'objective edit', 'mode change', 'automation change'] as const)('cancels native Goal generation on %s and ignores stale progress', async (action) => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftGoalOpening = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Original task'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click();
  const requestId = api.draftGoalOpening.mock.calls[0][2];
  if (action === 'navigate') {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await settle();
  } else if (action === 'objective edit') {
    objective.value = 'Replacement task'; objective.dispatchEvent(new w.Event('input'));
  } else if (action === 'mode change') {
    const mode = w.document.getElementById('sessionObjectiveMode') as HTMLSelectElement;
    mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  } else {
    (w.document.querySelector('#automationSwitch [data-mode="loop"]') as HTMLButtonElement).click();
  }
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Obsolete provider progress' });
  expect(w.document.getElementById('goalLifecycle')!.textContent).not.toContain('Obsolete provider progress');
  finish({ ok: true, data: { reply: 'Obsolete opening', model: 'fixture' } });
  await settle();
  expect(live.sent).toHaveLength(0);
});

it('shows Loop settling, its real waiting deadline, and generated text in the same row', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const controls = { automation: 'loop', objective: 'Continue the task', blocked: '', job: null,
    goalWait: { reason: 'quiet', until: Date.now() + 125_000 }, goalDraft: null as unknown };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting for tool inactivity');
  expect(row.querySelector('[role="timer"]')?.textContent).toContain('2:05');
  expect(row.getAttribute('aria-busy')).toBe('true');
  controls.goalDraft = { stage: 'answering', model: 'fixture', text: 'Continue with the remaining checks', error: null };
  await append([]);
  expect(w.document.getElementById('goalLifecycle')).toBe(row);
  expect(row.textContent).toContain('Generating a continuation');
  expect(row.textContent).toContain('Continue with the remaining checks');
  expect(row.querySelector('[role="timer"]')).toBeNull();
  controls.automation = 'off'; await append([]);
  expect(row.hidden).toBe(true);
  expect(row.textContent).toBe('');
});

it('names the wait for this chat’s own sub-agents without inventing a countdown', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  // The wait ends when the last worker stops, which is not a time this page can predict, so the row says what it is waiting for and shows no timer at all.
  const controls = { automation: 'loop', objective: 'Continue the task', blocked: '', job: null,
    goalWait: { reason: 'workers' }, goalDraft: null as unknown };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting for this chat’s sub-agents');
  expect(row.querySelector('[role="timer"]')).toBeNull();
  expect(row.getAttribute('aria-busy')).toBe('true');
  api.getSessionControls = async () => ({ ok: true, data: { ...controls, goalWait: null } });
  await append([]);
  expect(row.hidden).toBe(true);
});

it('says a Goal waits for its closed chat, without a spinner or a countdown', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  // The person closed the chat's tab before the Goal decided; nothing settles until it opens again.
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'goal', objective: 'Ship the release', blocked: '', job: null,
    goalWait: { reason: 'closed' }, goalDraft: null } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Goal · Paused until this chat is open in the browser');
  expect(row.textContent).not.toContain('Answer settling');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(row.querySelector('.session-status.is-working')).toBeNull();
  expect(row.querySelector('[role="timer"]')).toBeNull();
  // The row offers the way on: opening the chat, as its sidebar row does.
  const opened: string[] = [];
  api.openSessionChat = async (id: string) => { opened.push(id); return { ok: true, data: true }; };
  const open = row.querySelector<HTMLButtonElement>('button.dock-action')!;
  expect(open.getAttribute('aria-label')).toBe('Open this chat in your browser');
  open.click();
  await vi.waitFor(() => expect(opened).toHaveLength(1));
  // Any other wait has no such button.
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'goal', objective: 'Ship the release', blocked: '', job: null,
    goalWait: { reason: 'settling' }, goalDraft: null } });
  await append([]);
  expect(row.textContent).toContain('Answer settling');
  expect(row.querySelector('button.dock-action')).toBeNull();
});
