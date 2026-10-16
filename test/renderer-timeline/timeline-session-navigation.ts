import { expect, it, vi } from 'vitest';
import type { Handoff, SessionEvent, SessionSummary } from "../../contracts/session.js";
import type { InputEntry } from "../../backend/domains/sessions/input/input.js";
import type { LocalProject } from "../../contracts/workspace/projects.js";

import { T0, boot, settle, settleHistoryFrame, summary, text, toolCall } from './context.js';

it('ignores a pointer release when the timeline owns no pointer press', async () => {
  const { w } = await boot([]);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  w.dispatchEvent(new w.MouseEvent('pointerup'));
  expect(error).not.toHaveBeenCalled();
});

it('makes parent and worker session selectors keyboard-focusable and activates them with Enter/Space', async () => {
  const parent: SessionSummary = { ...summary([]), id: 'parent-session', title: 'Parent', conversationId: 'parent-chat', chatIds: ['parent-chat'] };
  const worker: SessionSummary = { ...summary([]), id: 'worker-session', title: 'Worker', conversationId: 'worker-chat', chatIds: ['worker-chat'],
    origin: { kind: 'worker', fromSessionId: parent.id, agentId: 'worker-1', task: 'Inspect' } };
  const { w } = await boot([], false, [], [], { sessions: [parent, worker] });
  const parentControl = w.document.querySelector<HTMLElement>(`[data-id="${parent.id}"] [data-session-select]`)!;
  expect(parentControl.getAttribute('role')).toBe('button');
  expect(parentControl.tabIndex).toBe(0);
  parentControl.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.querySelector(`.sess.is-sel[data-id="${parent.id}"]`)).not.toBeNull();

  (w.document.querySelector(`[data-id="${parent.id}"] .worker-toggle`) as HTMLButtonElement).click();
  await settle();
  const workerControl = w.document.querySelector<HTMLElement>(`[data-id="${worker.id}"] [data-session-select]`)!;
  expect(workerControl.tabIndex).toBe(0);
  const activate = new w.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  workerControl.dispatchEvent(activate);
  expect(activate.defaultPrevented).toBe(true);
  await settle();
  expect(w.document.querySelector(`.sess.is-sel[data-id="${worker.id}"]`)).not.toBeNull();
});

it('shows elapsed runtime and stops the owned background process from the dock', async () => {
  const { w, publishBackgroundProcesses } = await boot([]);
  await publishBackgroundProcesses([{
    processId: 4101,
    incarnation: 91,
    command: 'npm run dev',
    startedAt: Date.now() - 90_000,
    tty: false
  }]);
  const row = w.document.getElementById('backgroundExecStatus')!;
  expect(row.hidden).toBe(false);
  expect(row.querySelector('.background-exec-time')?.textContent).toMatch(/^Running for 1m 3\ds$/);
  const stop = row.querySelector<HTMLButtonElement>('.background-exec-stop')!;
  expect(stop.textContent).toContain('Stop');
  stop.click();
  await settle();
  expect((w as any).api.stopProcess).toHaveBeenCalledWith(summary([]).id, 4101, 91);
  expect(row.hidden).toBe(true);
});

it('expands multiple background processes and stops each one from its own row', async () => {
  const { w, publishBackgroundProcesses } = await boot([]);
  const startedAt = Date.now() - 45_000;
  await publishBackgroundProcesses([
    { processId: 4201, incarnation: 101, command: 'npm run watch', startedAt, tty: false },
    { processId: 4202, incarnation: 102, command: 'node server.js', startedAt: startedAt + 5_000, tty: true },
    { processId: 4203, incarnation: 103, command: 'npm run worker', startedAt: startedAt + 10_000, tty: false }
  ]);
  const summaryRow = w.document.getElementById('backgroundExecStatus')!;
  const list = w.document.getElementById('backgroundExecList')!;
  expect(summaryRow.hidden).toBe(false);
  expect(summaryRow.getAttribute('role')).toBe('button');
  expect(summaryRow.getAttribute('aria-expanded')).toBe('false');
  expect(summaryRow.getAttribute('aria-controls')).toBe('backgroundExecList');
  expect((w.document.getElementById('backgroundExecLiveStatus') as HTMLElement).hidden).toBe(false);
  expect(w.document.getElementById('backgroundExecLiveStatus')?.textContent).toContain('3 background processes running');
  expect(summaryRow.querySelector('.queue-label')?.textContent).toBe('3 background processes running');
  expect(summaryRow.querySelector('.queue-label')?.textContent).not.toContain('npm run watch');
  expect(summaryRow.querySelector<HTMLButtonElement>('.background-exec-stop')!.hidden).toBe(true);
  expect(list.hidden).toBe(true);

  summaryRow.click();
  expect(summaryRow.getAttribute('aria-expanded')).toBe('true');
  expect(list.hidden).toBe(false);
  const processRows = [...list.querySelectorAll<HTMLElement>('.background-exec-process')];
  expect(processRows).toHaveLength(3);
  expect(processRows[0]?.textContent).toContain('#4201 npm run watch');
  expect(processRows[1]?.textContent).toContain('#4202 node server.js');
  expect(processRows[2]?.textContent).toContain('#4203 npm run worker');
  expect(processRows[0]?.querySelector('.background-exec-process-time')?.textContent).toMatch(/^Running for 4\ds$/);
  expect(processRows[0]?.querySelector('.background-exec-stop')?.getAttribute('aria-label')).toContain('#4201 npm run watch');
  expect(processRows[1]?.querySelector('.background-exec-stop')?.getAttribute('aria-label')).toContain('#4202 node server.js');

  const secondStop = processRows[1]!.querySelector<HTMLButtonElement>('.background-exec-stop')!;
  secondStop.focus();
  secondStop.click();
  expect(w.document.activeElement).toBe(secondStop);
  await settle();
  expect((w as any).api.stopProcess).toHaveBeenCalledWith(summary([]).id, 4202, 102);
  expect(w.document.activeElement).toBe(summaryRow);
  expect(summaryRow.querySelector('.queue-label')?.textContent).toBe('2 background processes running');
  expect(summaryRow.getAttribute('role')).toBe('button');
  expect(summaryRow.getAttribute('aria-expanded')).toBe('true');
  expect(list.hidden).toBe(false);
  expect(list.querySelectorAll('.background-exec-process')).toHaveLength(2);
});

it('does not restore background-process Stop focus after navigating away and back', async () => {
  const { w, publishBackgroundProcesses, resolveBackgroundStop } = await boot([], true, [], [], { deferProcessStop: true });
  const startedAt = Date.now() - 30_000;
  await publishBackgroundProcesses([
    { processId: 4301, incarnation: 111, command: 'npm run watch', startedAt, tty: false },
    { processId: 4302, incarnation: 112, command: 'node server.js', startedAt: startedAt + 5_000, tty: false }
  ]);
  const summaryRow = w.document.getElementById('backgroundExecStatus')!;
  summaryRow.click();
  const stop = w.document.querySelectorAll<HTMLButtonElement>('#backgroundExecList .background-exec-stop')[1]!;
  stop.focus();
  stop.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  await settle();
  expect((w as any).api.stopProcess).toHaveBeenCalledWith(summary([]).id, 4302, 112);

  (w.document.getElementById('newChat') as HTMLButtonElement).click();
  await settle();
  (w.document.querySelector('#sessionList [data-id] [data-session-select]') as HTMLElement).click();
  await settle();
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus();
  resolveBackgroundStop();
  await settle();
  expect(w.document.activeElement).toBe(input);
});

it('stacks a running process row with queued plan tasks above the composer', async () => {
  const { w, live, append, publishBackgroundProcesses } = await boot([]);
  await publishBackgroundProcesses([{ processId: 4201, incarnation: 92, command: 'npm run dev', startedAt: Date.now() - 5_000, tty: false }]);
  live.inputs.push(...Array.from({ length: 5 }, (_, index) => ({
    id: `plan-stage-${index}`, sessionId: summary([]).id, text: `Plan task ${index + 1}`, mode: 'after-turn' as const, dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued' as const, owner: null, createdAt: Date.now() + index, conversationId: 'chat-b'
  })));
  await append([]);
  const processRow = w.document.getElementById('backgroundExecStatus')!;
  const queue = w.document.getElementById('finishQueue')!;
  const dock = w.document.querySelector('.composer-dock-body')!;
  expect(processRow.hidden).toBe(false);
  expect(queue.hidden).toBe(false);
  expect(queue.querySelectorAll('.queued-input')).toHaveLength(5);
  expect(queue.textContent).toContain('Plan task 5');
  const visible = [...dock.children].filter(node => !(node as HTMLElement).hidden);
  expect(visible).toContain(processRow);
  expect(visible).toContain(queue);
  expect(visible.indexOf(processRow)).toBeLessThan(visible.indexOf(queue));
});

it('keeps legacy Files, Agents and Review toggles out of the chat while dock controls remain available', async () => {
  const project: LocalProject = { id: '33333333-3333-4333-8333-333333333333', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const { w } = await boot([], false, [], [project]);
  const chat = w.document.querySelector('[data-panel="chat"]')!;
  expect(chat.querySelectorAll('#filePanelToggle, #agentPanelToggle, .file-panel-toggle')).toHaveLength(0);
  expect([...chat.children].filter(node => node.tagName === 'BUTTON')).toHaveLength(0);
  expect(w.document.getElementById('rightDockToggle')).not.toBeNull();
  expect(w.document.getElementById('terminalToggle')).not.toBeNull();
  w.document.getElementById('rightDockToggle')!.click();
  expect(w.document.getElementById('workDockRight')?.hidden).toBe(false);
});

it('patches native reactions in place and hides streamed envelopes without changing authored messages', async () => {
  const user: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', messageId: 'reaction-user', message: text('Question') };
  const answer: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 1, source: 'extension', messageId: 'reaction-answer', message: text('\uE200message_'), final: false };
  const { w, append } = await boot([user, answer]);
  const bubble = w.document.querySelector('.said.is-user')!;
  expect(w.document.querySelector<HTMLElement>('.ev-assistant_message')!.hidden).toBe(true);
  for (const [index, reaction] of ['😂', '❤️', null].entries()) {
    await append([{ ...user, seq: index + 3, origin: 1, reaction }]);
    expect(w.document.querySelector('.said.is-user')).toBe(bubble);
    expect(w.document.querySelector('.message-reaction')?.textContent ?? null).toBe(reaction);
  }
  expect(bubble.textContent).toContain('Question');
  await append([{ ...answer, seq: 7, origin: 2, message: text('\uE200message_reaction\uE202😂\uE201\nThe answer.'), final: true }]);
  expect(w.document.querySelector('.ev-assistant_message .msg')?.textContent?.trim()).toBe('The answer.');
  expect(w.document.querySelector('.message-reaction')).toBeNull(); // Never infer a target from adjacency.
});

it('keeps a reaction on the native question across 100 interim messages, tool calls and injected corrections', async () => {
  const question: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension',
    messageId: 'native-question', message: text('Original native question'), reaction: '👀' };
  const middle: SessionEvent[] = Array.from({ length: 100 }, (_, i) => ({ kind: 'assistant_message', seq: i + 2,
    time: T0 + i + 1, source: 'extension', messageId: `interim-${i}`, message: text(`Update ${i}`), final: false }));
  const tools = Array.from({ length: 15 }, (_, i) => ({ ...toolCall(i + 102, `call-${i}`), time: T0 + i + 101 }));
  const injected: SessionEvent = { kind: 'user_message', seq: 117, time: T0 + 116, source: 'app', messageId: 'input:correction',
    inputId: 'correction', inputDelivery: 'confirmed', message: text('An injected correction') };
  const final: SessionEvent = { kind: 'assistant_message', seq: 118, time: T0 + 117, source: 'extension', messageId: 'final',
    message: text('\uE200message_reaction\uE202👀\uE201\nFinished.'), final: true };
  const { w } = await boot([question, ...middle, ...tools, injected, final]);
  const correction = [...w.document.querySelectorAll('.said.is-user')].find(node => node.textContent?.includes('An injected correction'))!;
  expect(correction.querySelector('.message-reaction')).toBeNull();
  expect(w.document.querySelector('.message-reaction')).toBeNull(); // The native question is on an older page.
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 10000 } });
  for (let page = 0; page < 3; page++) {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  }
  const badges = [...w.document.querySelectorAll('.message-reaction')];
  expect(badges).toHaveLength(1);
  expect(badges[0]!.closest('.said')!.textContent).toContain('Original native question');
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('message_reaction');
});

it.each(['compaction', 'blocked', 'worker'])('retires %s control status when leaving its session, including late IPC and locale refresh', async kind => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const controls = { sessionId: summary([]).id, automation: 'off', objective: '',
    blocked: kind === 'compaction' ? '' : kind, job: kind === 'compaction' ? { busy: true } : null };
  api.getSessionControls = async () => ({ ok: true, data: controls });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).not.toBe('');
  let release!: (value: unknown) => void;
  api.getSessionControls = () => new Promise(resolve => { release = resolve; });
  await append([]);
  // An ordinary refresh of the same selected owner retains its last known status.
  expect(status.textContent).not.toBe('');
  w.document.getElementById('newChat')!.click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('compactSession')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  release({ ok: true, data: controls }); await settle();
  const { setLanguage } = await import("../../frontend/shared/i18n.js");
  setLanguage('zh-CN');
  expect(status.textContent).toBe('');
  setLanguage('en');
  // Returning to A is a new selection epoch; only its new read may restore status.
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
  expect(status.textContent).toBe('');
  release({ ok: true, data: controls }); await settle();
  expect(status.textContent).not.toBe('');
});

it('clears control projections on an existing-session switch and fences A to B to A responses', async () => {
  const first = summary([]), second = { ...summary([]), id: '2026-09-02-test0002', title: 'Other session' };
  const { w, append } = await boot([], true, [], [], { sessions: [first, second] });
  const api = (w as any).api;
  const busy = { automation: 'off', objective: '', blocked: '', job: { busy: true },
    recovery: [{ kind: 'unattributed', deadline: Date.now() + 60_000 }] };
  api.getSessionControls = async () => ({ ok: true, data: busy });
  await append([]);
  const status = w.document.getElementById('sessionControlStatus')!;
  expect(status.textContent).toContain('Compaction');
  expect(w.document.getElementById('recoveryStatus')!.textContent).toContain('Reload in');
  const pending: Array<(value: unknown) => void> = [];
  api.getSessionControls = () => new Promise(resolve => pending.push(resolve));
  await append([]); // old A refresh
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!({ ok: true, data: { ...busy, job: null, recovery: [] } }); await settle();
  pending[1]!({ ok: true, data: busy });
  pending[0]!({ ok: true, data: busy }); await settle();
  expect(status.textContent).toBe('');
  expect(w.document.getElementById('cancelCompaction')!.hidden).toBe(true);
  expect(w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('keeps the prior transcript inert until the selected detail arrives and fences A to B to A', async () => {
  const attachment = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'a-only.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  const aEvents: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'a-question', message: text('A QUESTION'), attachments: [attachment] },
    { seq: 2, time: T0 + 1, source: 'extension', kind: 'assistant_message', messageId: 'a-answer', message: text('A ANSWER'), state: 'final', final: true }
  ];
  const first = { ...summary(aEvents), title: 'Session A', lastHandoffId: 'handoff-a' };
  const second = { ...summary([]), id: '2026-09-02-test0000', title: 'Session B', lastHandoffId: null };
  const saved: Handoff = { id: 'handoff-a', sessionId: first.id, createdAt: T0, text: 'A HANDOFF', sourceEvents: 2, sourceTokens: 10, notes: [] };
  const app = await boot(aEvents, true, [], [], { sessions: [first, second], handoff: saved });
  const { w } = app;
  const api = (w as any).api;
  api.getSessionControls = async () => ({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: { busy: true }, recovery: [] } });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).not.toBeNull();
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('A HANDOFF');
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toContain('Compaction');

  type Reply = (value: unknown) => void;
  const details: Array<{ id: string; reply: Reply }> = [];
  const controls: Array<{ id: string; reply: Reply }> = [];
  api.getSession = vi.fn((id: string) => new Promise(resolve => details.push({ id, reply: resolve })));
  api.getSessionControls = vi.fn((id: string) => new Promise(resolve => controls.push({ id, reply: resolve })));
  const detail = (sum: SessionSummary, rows: SessionEvent[]) => ({ ok: true, data: { summary: sum, events: rows, total: rows.length,
    nextFrom: rows.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0) } });

  // Begin an A refresh, then change ownership twice. A stale response cannot become current merely because the selected id later returns to A.
  app.notifySession();
  await vi.waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id]));
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLButtonElement).click();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session B');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).not.toBeNull();
  expect(timeline.hasAttribute('inert')).toBe(true);
  expect(timeline.getAttribute('aria-busy')).toBe('true');
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);
  expect(w.document.getElementById('handoffBox')!.textContent).toBe('');
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');
  await vi.waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id, second.id]));
  // The queue read also repaints detail while the destination read remains pending.
  await settle();
  expect(timeline.textContent).toContain('A QUESTION');
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);

  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLButtonElement).click();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).toContain('A QUESTION');
  await vi.waitFor(() => expect(details.map(entry => entry.id)).toEqual([first.id, second.id, first.id]));

  const staleA: Extract<SessionEvent, { kind: 'user_message' }> = {
    seq: 4, time: T0 + 4, source: 'extension', kind: 'user_message', messageId: 'stale-a', message: text('STALE A QUESTION'), attachments: [attachment]
  };
  details[1]!.reply({ ok: false, error: 'B detail unavailable' });
  details[0]!.reply(detail(first, [staleA]));
  controls[0]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: { busy: true } } });
  controls[1]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: 'blocked', job: null } });
  await settle();
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Session A');
  expect(timeline.textContent).not.toContain('STALE A QUESTION');
  expect(timeline.textContent).toContain('A QUESTION');
  expect(timeline.hasAttribute('inert')).toBe(true);
  expect(w.document.getElementById('sessionControlStatus')!.textContent).toBe('');

  const current: SessionEvent[] = [{ seq: 3, time: T0 + 3, source: 'extension', kind: 'assistant_message', messageId: 'a-current', message: text('CURRENT A ANSWER'), state: 'final', final: true }];
  details[2]!.reply(detail(first, current));
  controls[2]!.reply({ ok: true, data: { automation: 'off', objective: '', blocked: '', job: null, recovery: [] } });
  await settle();
  expect(timeline.textContent).toContain('CURRENT A ANSWER');
  expect(timeline.textContent).not.toContain('STALE A QUESTION');
  expect(timeline.querySelector('img[alt="a-only.png"]')).toBeNull();
  expect(timeline.hasAttribute('inert')).toBe(false);
  expect(timeline.hasAttribute('aria-busy')).toBe(false);
  expect(w.document.getElementById('timelineEmpty')!.hidden).toBe(true);
});

it.each(['failed', 'empty', 'new-chat'] as const)('retires retained rows after a %s destination without a welcome flash', async outcome => {
  const rows: SessionEvent[] = [{ seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'a', message: text('Previous chat') }];
  const first = summary(rows), second = { ...summary([]), id: 'other', title: 'Other session' };
  const { w } = await boot(rows, true, [], [], { sessions: [first, second] });
  let reply!: (value: unknown) => void;
  (w as any).api.getSession = () => new Promise(resolve => { reply = resolve; });
  const timeline = w.document.getElementById('timeline')!;
  const welcome = w.document.getElementById('timelineEmpty')!;
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  await settle();
  expect(timeline.textContent).toContain('Previous chat');
  expect(welcome.hidden).toBe(true);
  if (outcome === 'new-chat') w.document.getElementById('newChat')!.click();
  reply(outcome === 'failed' ? { ok: false, error: 'Read failed' } : { ok: true, data: { summary: second, events: [], total: 0, nextFrom: 0 } });
  await settle();
  expect(timeline.textContent).toBe('');
  expect(timeline.hasAttribute('inert')).toBe(false);
  expect(timeline.hasAttribute('aria-busy')).toBe(false);
  expect(welcome.hidden).toBe(outcome !== 'new-chat');
});

it('keeps the current transcript and handoff mounted when Write Directly focuses the same session', async () => {
  const attachment = { id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'current.png', mimeType: 'image/png', size: 42, preview: 'data:image/webp;base64,YQ==' };
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'current-question', message: text('CURRENT QUESTION'), attachments: [attachment] },
    toolCall(2, 'current-tool')
  ];
  const current = { ...summary(rows), title: 'Current session', lastHandoffId: 'current-handoff' };
  const saved: Handoff = { id: 'current-handoff', sessionId: current.id, createdAt: T0, text: 'CURRENT HANDOFF', sourceEvents: 2, sourceTokens: 10, notes: [] };
  const app = await boot(rows, true, [], [], { sessions: [current], handoff: saved });
  const { w } = app;
  const api = (w as any).api;
  let reject!: (value: unknown) => void;
  api.getSession = vi.fn(() => new Promise(resolve => { reject = resolve; }));

  app.writeSession(current.id);
  expect(w.document.activeElement).toBe(w.document.getElementById('chatInput'));
  expect(w.document.getElementById('chatTitle')!.textContent).toBe('Current session');
  expect(w.document.getElementById('timeline')!.textContent).toContain('CURRENT QUESTION');
  expect(w.document.querySelector('img[alt="current.png"]')).not.toBeNull();
  expect(w.document.querySelector('details.tool')?.textContent).toContain('Read README.md');
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('CURRENT HANDOFF');
  expect(api.getSession).toHaveBeenCalledWith(current.id, { from: 3, limit: 30 });

  reject({ ok: false, error: 'same-session refresh unavailable' });
  await settle();
  expect(w.document.getElementById('timeline')!.textContent).toContain('CURRENT QUESTION');
  expect(w.document.getElementById('handoffBox')!.textContent).toContain('CURRENT HANDOFF');
});

it('reorders queued tasks by drag and keyboard through the durable IPC operation', async () => {
  const { w, live, append } = await boot([]);
  const sessionId = summary([]).id;
  for (const [index, label] of ['first', 'second'].entries()) live.inputs.push({
    id: `queue-${index}`, sessionId, text: label, mode: 'finish', dueAt: 0, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  const reorder = vi.fn(async () => ({ ok: true, data: true }));
  (w as any).api.reorderQueuedInputs = reorder;
  await append([]);
  let labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  expect(labels[0]!.draggable).toBe(true);
  labels[1]!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  await settle();
  expect(reorder).toHaveBeenCalledWith(sessionId, ['queue-1', 'queue-0']);
  const data = new Map<string, string>();
  const transfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => data.get(key) ?? '', effectAllowed: '', dropEffect: '' };
  labels = w.document.querySelectorAll<HTMLElement>('#finishQueue .queue-label');
  const start = new w.Event('dragstart', { bubbles: true }); Object.defineProperty(start, 'dataTransfer', { value: transfer });
  labels[1]!.dispatchEvent(start);
  const drop = new w.MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 0 }); Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  labels[0]!.parentElement!.dispatchEvent(drop);
  await settle();
  expect(reorder).toHaveBeenCalledTimes(2);
});

it.each([false, true])('closes a saved queue editor while Save has focus (delayed refresh: %s)', async delayedRefresh => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = '  Saved task  ';
  const save = field.nextElementSibling as HTMLButtonElement;
  const edit = vi.fn(async () => { live.inputs[0]!.text = field.value.trim(); return { ok: true, data: true }; });
  (w as any).api.editQueuedInput = edit;
  // A refresh can wait on unrelated outbox work. Its completion is not the save receipt.
  if (delayedRefresh) (w as any).api.listInputs = () => new Promise(() => {});
  save.focus(); save.click(); await settle();
  expect(edit).toHaveBeenCalledWith('edit-task', '  Saved task  ');
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.querySelector('#finishQueue .queue-label')?.textContent).toBe('Saved task');
});

it('keeps queue edits during refresh and allows only one pending save, retaining failed drafts', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'edit-task', sessionId: summary([]).id, text: 'Before', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Keep my edit';
  const save = field.nextElementSibling as HTMLButtonElement;
  let finish!: (result: unknown) => void;
  const edit = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  (w as any).api.editQueuedInput = edit;
  save.focus(); save.click(); save.click();
  expect(edit).toHaveBeenCalledTimes(1);
  expect(save.disabled).toBe(true);
  expect(save.textContent).toBe('Saving…');
  w.document.getElementById('chatInput')!.focus(); await append([]);
  expect(w.document.querySelector('#finishQueue textarea')).toBe(field);
  finish({ ok: false, error: 'Could not save this task' }); await settle();
  expect(field.value).toBe('Keep my edit'); expect(field.readOnly).toBe(false);
  expect(save.disabled).toBe(false); expect(save.textContent).toBe('Save');
  expect(w.document.body.textContent).toContain('Could not save this task');
});

it('shows ordinary after-turn messages in the task dock until actual delivery', async () => {
  const { w, live, append } = await boot([]);
  for (const [index, label] of ['Next task', 'Following task'].entries()) live.inputs.push({
    id: `after-${index}`, sessionId: summary([]).id, text: label, mode: 'after-turn', dueAt: 0,
    model: 'gpt-5.6-sol', reasoningEffort: 'high', state: 'queued', owner: null, createdAt: index, conversationId: 'chat-b'
  });
  await append([]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(2);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Next task');
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', historyRecorded: true, messageId: 'after-message' };
  await append([{ seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'after-message', inputId: 'after-0', message: text('Next task') }]);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(1);
  expect(w.document.getElementById('timeline')!.textContent).toContain('Next task');
});

it('identifies automatic Continue without user-task editing or reordering and keeps its cancellation', async () => {
  const { w, live, append } = await boot([]);
  const sessionId = summary([]).id;
  const recovery: InputEntry = { id: 'automatic-continue', sessionId, text: 'Resume the unfinished work.', mode: 'after-turn',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b',
    recovery: { questionId: 'source-question', pro: false, busyUntil: Date.now() + 60_000, phase: 'ready' } };
  live.inputs.push(recovery, ...['first', 'second'].map((text, index): InputEntry => ({
    id: `authored-${index}`, sessionId, text, mode: 'after-turn', dueAt: 0, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: index + 1, conversationId: 'chat-b'
  })));
  const api = (w as any).api;
  api.reorderQueuedInputs = vi.fn(async () => ({ ok: true, data: true }));
  await append([]);
  const card = w.document.querySelector<HTMLElement>('#finishQueue [data-input-id="automatic-continue"]')!;
  expect(card.textContent).toContain('Automatic Continue');
  expect(card.textContent).toContain(recovery.text);
  expect(card.querySelector<HTMLElement>('.queue-label')!.title).toContain('without a final answer');
  expect(card.querySelector('[aria-label="Edit queued task"]')).toBeNull();
  expect(card.querySelector('[draggable="true"]')).toBeNull();
  const second = w.document.querySelector('#finishQueue [data-input-id="authored-1"] .queue-label')!;
  second.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  await settle();
  expect(api.reorderQueuedInputs).toHaveBeenCalledWith(sessionId, ['authored-1', 'authored-0']);
  w.document.querySelector<HTMLButtonElement>('#finishQueue [aria-label="Cancel automatic Continue"]')!.click();
  await settle();
  expect(api.cancelInput).toHaveBeenCalledWith(recovery.id);
  expect(live.inputs[0]!.state).toBe('cancelled');
  expect(w.document.querySelector('#finishQueue [data-input-id="automatic-continue"]')).toBeNull();
  expect(w.document.querySelectorAll('#finishQueue [aria-label="Edit queued task"]')).toHaveLength(2);
});

it('keeps a transport-deferred immediate upload visible with cancellation instead of an invalid task editor', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'native-correction', sessionId: summary([]).id, text: 'Waiting upload', mode: 'after-turn', requestedMode: 'auto',
    dueAt: 0, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b',
    attachments: [{ id: 'native-file', name: 'notes.txt', mimeType: 'text/plain', size: 12 }] });
  await append([]);
  const row = w.document.querySelector('#inputQueue [data-input-id="native-correction"]');
  expect(row?.textContent).toContain('Waiting upload');
  expect(row?.textContent).toContain('notes.txt');
  expect(w.document.querySelector('#finishQueue [data-input-id="native-correction"]')).toBeNull();
  (row!.querySelector('[aria-label="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(live.inputs[0]?.state).toBe('cancelled');
  expect(w.document.querySelector('[data-input-id="native-correction"]')).toBeNull();
});

it('keeps cancelled Continue attempts at their own times across a long session instead of stacking them under the current chat', async () => {
  const rows: SessionEvent[] = [0, 1, 2, 3].map(index => ({
    seq: index + 1, time: T0 + index * 60_000, source: 'extension', kind: 'user_message',
    messageId: `night-question-${index}`, message: text(`NIGHT QUESTION ${index}`)
  }));
  const { w, live, append } = await boot(rows);
  for (let index = 0; index < 3; index++) live.inputs.push({
    id: `retired-continue-${index}`, sessionId: summary(rows).id, text: `UNSENT CONTINUE ${index}`,
    mode: 'after-turn', dueAt: T0 + index * 60_000 + 1000, createdAt: T0 + index * 60_000 + 1000,
    model: null, reasoningEffort: null, state: 'cancelled', owner: null, conversationId: `old-chat-${index}`,
    error: 'Automatic Continue cancelled: the source turn, activity or setting changed.',
    recovery: { questionId: `night-question-${index}`, pro: false, busyUntil: T0 + index * 60_000 + 61_000, phase: 'ready' }
  });
  await append([]);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('UNSENT CONTINUE');
  const timeline = w.document.getElementById('timeline')!;
  for (let index = 0; index < 3; index++) {
    const card = timeline.querySelector<HTMLElement>(`[data-input-id="retired-continue-${index}"]`)!;
    expect(card).not.toBeNull();
    expect(card.querySelector('time')?.textContent).toBe(new Date(live.inputs[index]!.createdAt).toLocaleString('en'));
    const content = timeline.textContent!;
    expect(content.indexOf(`NIGHT QUESTION ${index}`)).toBeLessThan(content.indexOf(`UNSENT CONTINUE ${index}`));
    expect(content.indexOf(`UNSENT CONTINUE ${index}`)).toBeLessThan(content.indexOf(`NIGHT QUESTION ${index + 1}`));
  }
});

it.each(['trash', 'empty-save'])('removes a queued message during editing via %s even while a refresh is delayed', async action => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'remove-edit', sessionId: summary([]).id, text: 'Delete me', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  (w as any).api.listInputs = () => new Promise(() => {});
  if (action === 'empty-save') field.value = ' \n\t ';
  const button = action === 'trash' ? w.document.querySelector('#finishQueue [aria-label="Remove queued task"]') : field.nextElementSibling;
  expect(button).not.toBeNull();
  (button as HTMLButtonElement).click(); await settle();
  expect((w as any).api.cancelInput).toHaveBeenCalledWith('remove-edit');
  expect(live.inputs[0]?.state).toBe('cancelled');
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
});

it.each(['cancelled', 'browser'])('retires the editor when Save learns the queued message became %s', async state => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'retired-edit', sessionId: summary([]).id, text: 'Original', mode: 'after-turn', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Late edit';
  (w as any).api.editQueuedInput = async () => {
    live.inputs[0]!.state = state as InputEntry['state'];
    return { ok: true, data: false };
  };
  (field.nextElementSibling as HTMLButtonElement).click(); await settle();
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(live.inputs[0]?.text).toBe('Original');
  if (state === 'cancelled') expect(w.document.querySelector('#finishQueue [data-input-id="retired-edit"]')).toBeNull();
  else expect(w.document.querySelector('#finishQueue [data-input-id="retired-edit"]')).not.toBeNull();
});

it('retires a queued editor synchronously on New Chat and ignores its delayed save after returning', async () => {
  const { w, live, append } = await boot([]);
  live.inputs.push({ id: 'old-editor', sessionId: summary([]).id, text: 'Original', mode: 'finish', dueAt: 0,
    model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: 0, conversationId: 'chat-b' });
  await append([]);
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  let resolveSave!: (value: unknown) => void;
  (w as any).api.editQueuedInput = () => new Promise(resolve => { resolveSave = resolve; });
  const field = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  field.value = 'Old save'; (field.nextElementSibling as HTMLButtonElement).click();
  w.document.getElementById('newChat')!.click();
  expect(w.document.querySelector('#finishQueue textarea')).toBeNull();
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(true);
  (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click(); await settle();
  (w.document.querySelector('[aria-label="Edit queued task"]') as HTMLButtonElement).click();
  const fresh = w.document.querySelector<HTMLTextAreaElement>('#finishQueue textarea')!;
  fresh.value = 'New edit'; resolveSave({ ok: true, data: true }); await settle();
  expect(w.document.querySelector('#finishQueue textarea')).toBe(fresh);
  expect(fresh.value).toBe('New edit');
});
