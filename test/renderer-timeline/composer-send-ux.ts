import { expect, it } from 'vitest';
import type { InputEntry } from '../../backend/domains/sessions/input/input.js';
import { boot, summary } from './context.js';

function queued(over: Partial<InputEntry> = {}): InputEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: summary([]).id,
    text: 'Continue the dashboard work',
    mode: 'auto',
    dueAt: Date.now(),
    model: null,
    reasoningEffort: null,
    state: 'queued',
    owner: null,
    createdAt: Date.now(),
    conversationId: 'chat-b',
    ...over
  };
}

it('paints a queued send as a delivered bubble while the project is still being read', async () => {
  const project = { id: '11111111-1111-4111-8111-111111111111', name: 'repo', path: 'C:\\repo', createdAt: Date.now() };
  const { w, live, append } = await boot([], true, [], [project]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({
    ok: true,
    data: { sessionId: id, conversationId: 'chat-b', automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null }
  });
  live.inputs.push(queued());
  await append([]);
  const row = w.document.querySelector('#inputQueue .pending-message')!;
  expect(row.classList.contains('is-delivered')).toBe(true);
  expect(row.getAttribute('data-phase')).toBe('preparing');
  expect(row.querySelector('.ph-clock')).toBeNull();
  expect(row.querySelector('.ph-check')).not.toBeNull();
  expect(row.textContent).toContain('Continue the dashboard work');
  expect(row.textContent).not.toContain('Queued');
  const now = w.document.querySelector('.turn-now-text')?.textContent;
  expect(now).toBe('Reading project…');
});

it('switches the live cue to Thinking once the queued send is offered', async () => {
  const { w, live, append } = await boot([]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({
    ok: true,
    data: { sessionId: id, conversationId: 'chat-b', automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null }
  });
  live.inputs.push(queued({ state: 'sent', messageId: 'm-offered' }));
  await append([]);
  const row = w.document.querySelector('#inputQueue .pending-message')!;
  expect(row.classList.contains('is-delivered')).toBe(true);
  expect(row.getAttribute('data-phase')).toBeNull();
  expect(w.document.querySelector('.turn-now-text')?.textContent).toBe('Thinking…');
});

it('keeps Send enabled on an old chat that has no live turn', async () => {
  const { w, append } = await boot([]);
  const state = (await (w as any).api.getState()).data;
  state.bridge.webProviders = { deepseek: { signedIn: true, open: true, tabId: 1, lastSeenAt: Date.now() } };
  state.config.ui.webProvider = 'deepseek';
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({
    ok: true,
    data: { sessionId: id, conversationId: 'chat-b', automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null }
  });
  await append([]);
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  expect(send.dataset.action).toBe('send');
});

it('shows a rewritten auto follow-up as a sent bubble instead of a task card', async () => {
  const { w, live, append } = await boot([]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({
    ok: true,
    data: { sessionId: id, conversationId: 'chat-b', automation: 'off', activeTurnId: 'live-turn', finishHeld: false, blocked: '', job: null }
  });
  live.inputs.push(queued({
    mode: 'after-turn',
    afterTurn: true,
    requestedMode: 'auto',
    text: 'Second question while the first is running'
  }));
  await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')?.textContent).toContain('Second question while the first is running');
  expect(w.document.querySelector('#finishQueue .queued-input')).toBeNull();
});

it('leaves an explicit after-turn task in the follow-up list', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push(queued({
    id: '22222222-2222-4222-8222-222222222222',
    mode: 'after-turn',
    afterTurn: true,
    text: 'Run the remaining tests after this turn'
  }));
  await append([]);
  expect(w.document.querySelector('#inputQueue .pending-message')).toBeNull();
  expect(w.document.querySelector('#finishQueue .queued-input')?.textContent).toContain('Run the remaining tests after this turn');
});

it('still shows a failed delivery instead of a sent check', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push(queued({
    state: 'failed',
    error: 'Connect DeepSeek in NEURAFLOK\'s browser before sending.'
  }));
  await append([]);
  const row = w.document.querySelector('#inputQueue .pending-message')!;
  expect(row.classList.contains('is-delivered')).toBe(false);
  expect(row.classList.contains('is-delivery-error')).toBe(true);
  expect(row.textContent).toContain('Connect DeepSeek');
});
