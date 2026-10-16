import { expect, it, vi } from 'vitest';
import type { SessionEvent } from "../../contracts/session.js";
import type { InputEntry } from "../../backend/domains/sessions/input/input.js";

import { T0, boot, settle, summary, text } from './context.js';

it('follows the accepted New Chat receipt while preserving a typed follow-up', async () => {
  const { w, live, append } = await boot([], false);
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Opening message';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  composer.value = 'Follow-up while delivery is pending';
  composer.dispatchEvent(new w.Event('input'));
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(w.document.querySelector('#sessionList [data-id].is-sel')).not.toBeNull();
  expect(composer.value).toBe('Follow-up while delivery is pending');
});

it.each(['goal', 'loop'] as const)('keeps a provider-reported Astra model selected when changing %s delivery', async mode => {
  const existing = { ...summary([]), selectedModel: {
    conversationId: 'chat-b', model: 'astra', reasoningEffort: 'pro' as const, observedAt: Date.now()
  } };
  const { w, append } = await boot([], true, [], [], { sessions: [existing] });
  const api = (w as any).api;
  const state = (await api.getState()).data;
  state.config.ui.finishTool = true;
  const controls = { sessionId: summary([]).id, conversationId: 'chat-b', automation: mode, loopAfterTurn: false, blocked: '' };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  api.setSessionAutomation = vi.fn(async (_id: string, next: string, afterTurn: boolean) => {
    controls.automation = next as typeof mode; controls.loopAfterTurn = afterTurn;
    return { ok: true, data: controls };
  });
  await append([]);
  const row = w.document.getElementById('loopDeliveryRow')!;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  expect(row.hidden).toBe(false);
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  await settle();
  expect(api.setSessionAutomation).toHaveBeenLastCalledWith(summary([]).id, mode, true);
  expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe(mode);
  state.config.ui.finishTool = false;
  await append([]);
  expect(row.hidden).toBe(true);
  expect(delivery.value).toBe('after-turn');
  state.config.ui.finishTool = true;
  await append([]);
  expect(row.hidden).toBe(false);
  expect(delivery.value).toBe('after-turn');
});

it('applies Off to the exact accepted New Chat opening while preserving an unrelated composer draft', async () => {
  const { w, live, append } = await boot([], false);
  const api = (w as any).api;
  api.draftGoalOpening = vi.fn(async () => ({ ok: true, data: { reply: 'Say hello once', model: 'fixture' } }));
  const controls = api.getSessionControls;
  api.getSessionControls = async (id: string) => { const result = await controls(id); result.data.objective = 'Greeting goal'; return result; };
  api.setInputAutomation = vi.fn(async (id: string, mode: 'off' | 'goal' | 'loop') => {
    live.inputs = live.inputs.map(row => row.id === id ? { ...row, automation: mode } : row);
    return { ok: true, data: true };
  });
  const composer = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  composer.value = 'Keep my separate draft';
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Greeting goal'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  expect(live.sent).toHaveLength(1);
  const id = live.sent[0]!.id;
  (w.document.querySelector('#automationSwitch [data-mode="off"]') as HTMLButtonElement).click(); await settle();
  expect(api.setInputAutomation).toHaveBeenCalledWith(id, 'off');
  live.inputs = live.inputs.map(row => ({ ...row, state: 'sent', deliveredSessionId: summary([]).id }));
  await append([]);
  expect(composer.value).toBe('Keep my separate draft');
  expect(objective.value).toBe('Greeting goal');
  expect(live.sent).toHaveLength(1);
});

it('cancels pending plan generation when its own draft changes', async () => {
  const { w, live, progress } = await boot([], false);
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Original plan';
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  input.value = 'Replacement plan'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).toHaveBeenCalledWith(requestId);
  progress({ requestId, phase: 'generating', text: 'Old plan text' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Old plan text');
  finish({ ok: true, data: ['Old first stage', 'Old second stage'] }); await settle();
  expect(live.sent).toHaveLength(0);
});

it('preserves composer drafts across chat and settings navigation without forcing a fixed height', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w } = await boot([], true, [], [], { sessions: [first, second] });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Long draft\n'.repeat(60); input.dispatchEvent(new w.Event('input'));
  const draft = input.value;
  expect(input.style.height).toBe('');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('');
  expect(input.style.height).toBe('');
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
  const chat = await import("../../frontend/features/chat/chat.js");
  chat.openChatView('settings');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click(); await settle();
  chat.openChatView('timeline');
  expect(input.value).toBe(draft);
  expect(input.style.height).toBe('');
});

it('retains an existing running chat planner across navigation and accepts its result only in that draft', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live, progress } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  let finish!: (value: any) => void;
  api.draftTaskPlan = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Plan for this running chat'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); await settle();
  const requestId = api.draftTaskPlan.mock.calls[0][2];
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  input.value = 'Unrelated draft'; input.dispatchEvent(new w.Event('input'));
  expect(api.cancelTaskRequest).not.toHaveBeenCalled();
  progress({ requestId, phase: 'generating', text: 'Original chat progress' });
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Original chat progress');
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(input.value).toBe('Plan for this running chat');
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Original chat progress');
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  (w.document.querySelector('#sessionList [data-id="second-chat"]') as HTMLElement).click(); await settle();
  finish({ ok: true, data: ['Original first stage', 'Original checkpoint'] }); await settle();
  expect(input.value).toBe('Unrelated draft');
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(input.value).toBe('');
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: summary([]).id, mode: 'finish', text: 'Original first stage', stages: ['Original checkpoint'] });
});

it('keeps two planner owners independent and ignores a cancelled result after returning to its chat', async () => {
  const first = summary([]), second = { ...first, id: 'second-chat', title: 'Second chat' };
  const { w, live } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const pending = new Map<string, (value: any) => void>();
  api.draftTaskPlan = vi.fn((text: string) => new Promise(resolve => { pending.set(text, resolve); }));
  api.cancelTaskRequest = vi.fn(async () => ({ ok: true, data: true }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const generate = () => { w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true })); };
  const select = async (id: string) => { (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click(); await settle(); };
  input.value = 'Plan A'; generate(); await settle();
  const requestA = api.draftTaskPlan.mock.calls[0][2];
  await select(second.id);
  input.value = 'Plan B'; generate(); await settle();
  pending.get('Plan A')!({ ok: true, data: ['A first', 'A check'] }); await settle();
  expect(w.document.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.getElementById('createPlan')!.getAttribute('aria-busy')).toBe('true');
  await select(first.id);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('A first');
  await select(second.id);
  const requestB = api.draftTaskPlan.mock.calls[1][2];
  w.document.getElementById('createPlan')!.click(); // Explicitly cancel B; A and navigation did not cancel it.
  expect(api.cancelTaskRequest.mock.calls).toEqual([[requestB]]);
  expect(api.cancelTaskRequest).not.toHaveBeenCalledWith(requestA);
  input.value = 'B replacement'; generate(); await settle();
  pending.get('Plan B')!({ ok: true, data: ['Stale B result'] }); await settle();
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toContain('Stale B');
  pending.get('B replacement')!({ ok: false, error: 'Planner unavailable' }); await settle();
  await select(first.id); await select(second.id);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Planner unavailable');
  expect(input.value).toBe('B replacement');
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ sessionId: first.id, text: 'A first', mode: 'finish' });
});

it('renders existing-chat Goal draft stages from main controls without starting another request', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let draft = { stage: 'answering', model: 'fixture', text: 'Actual continuation text', error: null as string | null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', goalDraft: draft } });
  const opening = vi.fn(); api.draftGoalOpening = opening;
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Actual continuation text');
  expect(row.getAttribute('aria-busy')).toBe('true');
  draft = { ...draft, stage: 'ready' }; await append([]);
  expect(row.textContent).toContain('queued for delivery');
  draft = { ...draft, stage: 'failed', error: 'no_api_key' }; await append([]);
  expect(row.textContent).toContain('No API key is configured for the continuation provider.');
  expect(row.textContent).not.toContain('no_api_key');
  expect(row.getAttribute('aria-busy')).toBe('false');
  expect(opening).not.toHaveBeenCalled();
});

it('says the goal was reached instead of still pursuing it, and only once', async () => {
  // Found on Windows (2026-10-04): the helper decided the goal was met and sent nothing, yet the row kept saying "Pursuing goal", so the run looked as if it were still working.
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let draft: unknown = { stage: 'no-reply', model: 'fixture', text: '', error: null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal',
    objective: 'Write one poem about tides', goalDraft: draft } });
  await append([]);
  const goalRow = w.document.getElementById('activeGoalRow')!;
  expect(goalRow.textContent).toContain('Goal reached · Write one poem about tides');
  expect(goalRow.textContent).not.toContain('Pursuing goal');
  expect(goalRow.querySelector('.ico')!.className).toContain('ph-check');
  // Pause and Edit stay: the objective can be continued or changed.
  expect(goalRow.querySelectorAll('.dock-action')).toHaveLength(2);
  expect(w.document.getElementById('goalLifecycle')!.hidden).toBe(true);
  // A newer turn replaces the outcome; the run is pursuing again.
  draft = null; await append([]);
  expect(goalRow.textContent).toContain('Pursuing goal · Write one poem about tides');
  expect(goalRow.querySelector('.ico')!.className).toContain('ph-activity');
});

it('shows the immediate recovery deadline before a draft exists and clears it on fresh work', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let goalWait: object | null = { reason: 'silence', until: Date.now() + 120_000 };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', goalWait, goalDraft: null } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Loop · Waiting before recovery reload');
  expect(row.querySelector('[role="timer"]')).not.toBeNull();
  goalWait = null;
  await append([]);
  expect(row.hidden).toBe(true);
});

it.each([
  { reason: 'silence', kind: 'silence' },
  { reason: 'listening', kind: 'post-reload' },
  { reason: 'native-busy', kind: 'native-busy' },
  { reason: 'quiet', kind: 'post-reload' }
] as const)('shows the shared $reason deadline once while keeping independent Loop waits', async ({ reason, kind }) => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  const deadline = Date.now() + 60_000;
  const goalWait = { reason, until: deadline };
  const recovery = [{ kind: kind as string, deadline, visibleAt: 0 }];
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    automation: 'loop', objective: 'Keep working', goalWait, recovery, goalDraft: null } });
  await append([]);
  const lifecycle = w.document.getElementById('goalLifecycle')!;
  expect(lifecycle.hidden).toBe(true);
  expect(lifecycle.querySelector('[role="timer"]')).toBeNull();
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(false);
  expect(w.document.getElementById('activeGoalRow')!.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(1);

  // A different deadline is independent, even when both owners happen to be waiting.
  goalWait.until += 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);

  // A hidden recovery row must not swallow the only visible indication of a wait.
  goalWait.until = deadline; recovery[0]!.visibleAt = deadline - 15_000;
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);

  // Attribution and pickup have their own actions, even at the same timestamp.
  recovery[0]!.visibleAt = 0; recovery[0]!.kind = 'pickup';
  await append([]);
  expect(lifecycle.hidden).toBe(false);
  expect(w.document.querySelectorAll('#composerDock [role="timer"]')).toHaveLength(2);
});

it.each([false, true])('does not redisplay the old reload receipt after Continue starts the next turn (developer mode: %s)', async developerMode => {
  const reloadedAt = Date.now() - 60_000;
  const repair: SessionEvent = { seq: 1, time: reloadedAt, source: 'app', kind: 'progress',
    progressId: 'browser-repair:fixture', turnId: 'silent-turn',
    message: text('Reloaded chat to recover an unresponsive open turn.') };
  const { w, append, live } = await boot([repair], true, [], [], { developerMode });
  const host = w.document.getElementById('recoveryStatus')!;
  expect(host.hidden).toBe(false);
  await append([{ seq: 2, time: Date.now(), source: 'app', kind: 'turn_start', turnId: 'silent-turn' }]);
  expect(host.hidden).toBe(false); // Reopening the same source is not a new question.
  await append([
    { seq: 3, time: Date.now(), source: 'extension', kind: 'user_message', messageId: 'continue-message', message: text('Continue the work.') },
    { seq: 4, time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'continued-turn' }
  ]);
  expect(host.hidden).toBe(true);
  expect(live.events).toContainEqual(repair);
  if (developerMode) expect(w.document.getElementById('timeline')!.textContent).toContain(repair.message.text);
  await append([{ ...repair, seq: 5, time: Date.now(), turnId: 'continued-turn', progressId: 'browser-repair:new-turn' }]);
  expect(host.hidden).toBe(false);
});

it('reuses the Goal animation for a session-finish draft while ordinary automation is off', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = { stage: 'answering', model: 'fixture', text: 'Next useful action', error: null };
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'off', finishGoalDraft } });
  await append([]);
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.hidden).toBe(false);
  expect(row.textContent).toContain('Next useful action');
  expect(row.getAttribute('aria-busy')).toBe('true');
  finishGoalDraft = null; await append([]);
  expect(row.hidden).toBe(true);
  expect(row.getAttribute('aria-busy')).toBe('false');
});

it('shows the active finish animation after an earlier ordinary Goal save failed', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let finishGoalDraft: object | null = null;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, automation: 'goal', finishGoalDraft } });
  api.setSessionObjective = vi.fn(async () => ({ ok: false, error: 'Save failed' }));
  await append([]);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Verify remaining work'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  const row = w.document.getElementById('goalLifecycle')!;
  expect(row.textContent).toContain('Task could not be saved');
  finishGoalDraft = { stage: 'answering', model: 'fixture', text: 'Check the active task', error: null };
  await append([]);
  expect(row.textContent).toContain('Check the active task');
  expect(row.textContent).not.toContain('Task could not be saved');
  expect(row.getAttribute('aria-busy')).toBe('true');
  expect(row.querySelector('.session-status.is-working')).not.toBeNull();
});

it('offers Generate Goal only at an empty finish wait and preserves the manual draft', async () => {
  const { w, append, live } = await boot([]);
  const api = (w as any).api, original = api.getSessionControls;
  let waiting = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, finishWaiting: waiting } });
  const generate = vi.fn(async () => ({ ok: true, data: 'Goal queued' })); api.generateFinishGoal = generate;
  const button = w.document.getElementById('generateFinishGoal') as HTMLButtonElement;
  await append([]); expect(button.hidden).toBe(true);
  waiting = true; await append([]); expect(button.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'My own follow-up'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect(input.disabled).toBe(false);
  button.click(); await settle();
  expect(generate).toHaveBeenCalledWith(summary(live.events).id, 'held-turn');
  expect(input.value).toBe('My own follow-up');
  live.inputs.push({ id: 'pending', sessionId: summary(live.events).id, state: 'queued', mode: 'finish', text: 'Prior task', dueAt: Date.now(), createdAt: Date.now() } as InputEntry);
  await append([]); expect(button.hidden).toBe(true);
  button.click(); await settle(); expect(generate).toHaveBeenCalledTimes(1);
});

it('offers a per-task post-turn opt-in only for Astra', async () => {
  const { w, live, append } = await boot([]);
  const current = summary([]);
  live.inputs.push({ id: 'choice-task', sessionId: current.id, text: 'Next task', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  expect(w.document.querySelector('.queue-delivery')).toBeNull();
  current.selectedModel = { conversationId: 'chat-b', model: 'gpt-6-pro', reasoningEffort: 'pro', observedAt: T0 };
  (w as any).api.listSessions = async () => ({ ok: true, data: { sessions: [current], activeId: current.id, pressure: [] } });
  (w as any).api.getSession = async () => ({ ok: true, data: { summary: current, events: [], total: 0, nextFrom: 0 } });
  const edit = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.editQueuedInput = edit;
  await append([]);
  const toggle = w.document.querySelector<HTMLButtonElement>('.queue-delivery');
  expect(toggle?.getAttribute('aria-pressed')).toBe('false');
  toggle!.click();
  await settle();
  expect(edit).toHaveBeenCalledWith('choice-task', 'Next task', true);
});
