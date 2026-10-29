import { expect, it, vi } from 'vitest';
import type { SessionEvent } from "../../contracts/session.js";

import { T0, boot, groupTitle, latestCallTitle, nativeStep, settle, summary, text, toolCall } from './context.js';

it('titles a finished round with the native step that ends it, by position and in any language', async () => {
  // ChatGPT closes a round of work with a recap and titles the block with it. It is picked by where it sits, never by its wording: the step that ends the round, once prose follows. Spanish labels.
  const note = (seq: number, label: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'page_tool', messageId: `note-${seq}`, label });
  const prose: SessionEvent = { kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'after-round', message: text('Listo.'), final: true, state: 'final' };
  const { w } = await boot([note(1, 'Planificando la comprobación'), toolCall(2, 'call-a'), toolCall(3, 'call-b'), note(4, 'Se ejecutó la comprobación exacta'), prose]);
  const group = w.document.querySelector<HTMLDetailsElement>('#timeline details.tool-group')!;
  expect(group.querySelector('.activity-title')!.textContent).toBe('Se ejecutó la comprobación exacta');
  expect(group.querySelector('.activity-symbol .ph-check-circle')).not.toBeNull();
  // The recap heads the group rather than repeating inside it; the calls and the earlier note stay, and a step written before any call keeps the globe.
  const inside = [...group.querySelectorAll<HTMLElement>('.tool-group-body .thinking-line')];
  expect(inside.map(line => line.textContent)).toEqual(['Planificando la comprobación']);
  expect(inside[0]!.querySelector('.ph-globe-hemisphere-west')).not.toBeNull();
  expect(group.querySelectorAll('.tool-group-body .ev-tool_call')).toHaveLength(2);
});

it('names a round still in progress after its latest real action, until prose ends it', async () => {
  // The turn still works and nothing follows the step: it is a note, whatever it says, not a recap.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  try {
    const { w, append } = await boot([toolCall(2, 'call-a'), toolCall(3, 'call-b'), nativeStep(4, 'Executed exact command check')]);
    vi.setSystemTime(T0 + 10_000);
    await append([]);
    expect(latestCallTitle(w.document)).toBeTruthy();
    expect(groupTitle(w.document)).toBe(latestCallTitle(w.document));
    const pending = [...w.document.querySelectorAll<HTMLElement>('#timeline .tool-group-body .thinking-line')];
    expect(pending.map(line => line.textContent)).toEqual(['Executed exact command check']);
    expect(pending[0]!.querySelector('.ph-check-circle')).toBeNull();
    // Once prose follows, the same step ends a finished round and titles it.
    await append([{ kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'after-round', message: text('Done.'), final: true, state: 'final' }]);
    expect(groupTitle(w.document)).toBe('Executed exact command check');
  } finally {
    vi.useRealTimers();
  }
});

it('names a finished round that ends in a call after that call, and keeps the globe on a step before its calls', async () => {
  const { w } = await boot([nativeStep(1, 'Searched 3 websites'), toolCall(2, 'call-a'), toolCall(3, 'call-b'),
    { kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'after-search', message: text('Done.'), final: true, state: 'final' }]);
  expect(latestCallTitle(w.document)).toBeTruthy();
  expect(groupTitle(w.document)).toBe(latestCallTitle(w.document));
  expect(w.document.querySelector('#timeline .tool-group-body .thinking-line .ph-globe-hemisphere-west')).not.toBeNull();
});

it('offers a way back to the end of the chat that clears any reserved space', async () => {
  const { w } = await boot([]);
  const jump = w.document.getElementById('jumpLatest') as HTMLButtonElement;
  expect(jump).not.toBeNull();
  expect(jump.getAttribute('aria-label')).toBe('Jump to latest');
  expect(jump.closest('#chatBody')).not.toBeNull();
  const content = w.document.getElementById('timelineContent')!;
  content.style.setProperty('--timeline-scroll-reserve', '300px');
  jump.click();
  expect(content.style.getPropertyValue('--timeline-scroll-reserve')).toBe('');
});

it('keeps the chat reading state out of Agents & automation, which shares its scroll pane', async () => {
  const { w, append } = await boot([{ kind: 'assistant_message', seq: 1, time: T0 + 1000, source: 'extension', messageId: 'first', message: text('Hello'), final: false }]);
  const pane = w.document.getElementById('chatBody')!;
  const jump = w.document.getElementById('jumpLatest')!;
  // The real navigation: the Agents & automation tab, then Back to chat.
  const view = (name: string) => (w.document.querySelector(name === 'settings' ? 'nav button[data-tab="settings"]' : '#backToChat') as HTMLButtonElement).click();
  Object.defineProperties(pane, { clientHeight: { value: 400, configurable: true }, scrollHeight: { value: 2000, configurable: true } });
  pane.scrollTop = 1600;
  // Settings open at their top, not at the chat's end, and offer no way back to a chat end.
  view('settings');
  expect(pane.scrollTop).toBe(0);
  expect(jump.classList.contains('is-shown')).toBe(false);
  // Reading the settings upwards is not reading the chat.
  pane.scrollTop = 900;
  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -120 }));
  pane.dispatchEvent(new w.Event('scroll'));
  expect(jump.classList.contains('is-shown')).toBe(false);
  // Back in the chat, it is still at its end and still follows new output.
  view('timeline');
  expect(pane.scrollTop).toBe(2000);
  await append([{ kind: 'assistant_message', seq: 2, time: T0 + 2000, source: 'extension', messageId: 'later', message: text('More output'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  expect(jump.classList.contains('is-shown')).toBe(false);
});

it('opens round participants in the existing dock without moving the prime reader or draft', async () => {
  const report = (seq: number, worker: string): SessionEvent => ({ kind: 'agent_message', seq, time: T0 + seq * 1000,
    source: 'app', from: worker, to: 'prime', messageId: `report-${seq}`, delivery: 'delivered', message: text('Verified the build') });
  const rows: SessionEvent[] = [toolCall(1, 'read-first'), report(2, 'worker-1'), report(3, 'worker-2'), report(4, 'worker-1'),
    { kind: 'assistant_message', seq: 5, time: T0 + 5000, source: 'extension', messageId: 'round-break', message: text('Next, verify it.'), final: false },
    toolCall(6, 'read-second'), report(7, 'worker-2')];
  const prime = summary(rows);
  const workers = [1, 2, 3].map(n => ({ ...summary([]), id: `worker-local-${n}`, title: `worker-${n}`, conversationId: `worker-chat-${n}`,
    origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: `worker-${n}`, task: 'Verify build' } }));
  const { w, append } = await boot(rows, true, [], [], { sessions: [prime, ...workers] });
  const api = (w as any).api, original = api.getSession;
  api.getSession = vi.fn((id: string, options: unknown) => original(id, options));
  expect(w.document.getElementById('inlineAgents')).toBeNull();
  expect(w.document.querySelectorAll('#chatBody .agent-panel')).toHaveLength(0);
  const indicators = [...w.document.querySelectorAll<HTMLButtonElement>('#timeline .activity-workers')];
  // One pill per round, whatever the count: the team icon and how many workers it involved.
  expect(indicators.map(button => button.textContent)).toEqual(['2', '1']);
  expect(indicators[0]!.getAttribute('aria-label')).toBe('2 sub-agents in this round');
  // One worker reads as one, not "1 sub-agents" (seen on the 2.1.27 canary).
  expect(indicators[1]!.getAttribute('aria-label')).toBe('1 sub-agent in this round');
  expect(indicators[0]!.type).toBe('button');
  expect(indicators[0]!.querySelectorAll('.ico')).toHaveLength(1);
  expect(indicators[0]!.querySelector('.agent-avatar')).toBeNull();
  const firstRound = indicators[0]!.closest<HTMLDetailsElement>('.tool-group')!;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Keep the prime draft'; input.dispatchEvent(new w.Event('input'));
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 2000 } });
  pane.scrollTop = 300;
  indicators[0]!.focus(); indicators[0]!.click(); await settle();
  expect(firstRound.open).toBe(false);
  expect(api.getSession).not.toHaveBeenCalled();
  const highlighted = () => [...w.document.querySelectorAll<HTMLElement>('#workDockRight .is-round-worker')].map(row => row.dataset.workerSession);
  expect(highlighted()).toEqual(['worker-local-1', 'worker-local-2']);
  expect(w.document.querySelector(`.sess.is-sel[data-id="${prime.id}"]`)).not.toBeNull();
  expect(input.value).toBe('Keep the prime draft');
  expect(pane.scrollTop).toBe(300);
  indicators[1]!.click(); await settle();
  expect(highlighted()).toEqual(['worker-local-2']);
  indicators[1]!.focus();
  await append([{ kind: 'assistant_message', seq: 8, time: T0 + 8000, source: 'extension', messageId: 'live-output', message: text('More prime output'), final: false }]);
  expect(pane.scrollTop).toBe(300);
  expect(w.document.activeElement).toBe(indicators[1]);
  expect(highlighted()).toEqual(['worker-local-2']);
  (w.document.getElementById('jumpLatest') as HTMLButtonElement).click();
  await append([{ kind: 'assistant_message', seq: 9, time: T0 + 9000, source: 'extension', messageId: 'tail-output', message: text('Following again'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  // A detached control cannot act, even while its parent is still selected.
  firstRound.remove(); indicators[0]!.click();
  expect(highlighted()).toEqual(['worker-local-2']);
  const staleActivation = indicators[1]!.onclick!;
  w.document.getElementById('newChat')!.click(); await settle();
  (w.document.querySelector(`#sessionList [data-id="${prime.id}"] [data-session-select]`) as HTMLElement).click(); await settle();
  const currentIndicators = [...w.document.querySelectorAll<HTMLButtonElement>('#timeline .activity-workers')];
  currentIndicators[1]!.click(); await settle();
  expect(highlighted()).toEqual(['worker-local-2']);
  // Exercise the captured A callback after A → B → A, with a connected current node.
  staleActivation.call(currentIndicators[0]!, new w.MouseEvent('click') as unknown as PointerEvent);
  expect(highlighted()).toEqual(['worker-local-2']);

});

it('keeps round inspection at the tail during a dock-induced viewport resize', async () => {
  const observers: Array<{ targets: Set<Element>; notify: () => void }> = [];
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>();
    constructor(callback: () => void) { observers.push({ targets: this.targets, notify: callback }); }
    observe(target: Element): void { this.targets.add(target); }
    unobserve(target: Element): void { this.targets.delete(target); }
    disconnect(): void { this.targets.clear(); }
  });
  try {
    const rows: SessionEvent[] = [toolCall(1, 'round-resize'), { kind: 'agent_message', seq: 2, time: T0 + 2000,
      source: 'app', from: 'worker-1', to: 'prime', messageId: 'resize-report', delivery: 'delivered', message: text('Verified') }];
    const prime = summary(rows);
    const worker = { ...summary([]), id: 'resize-worker', origin: { kind: 'worker' as const, fromSessionId: prime.id, agentId: 'worker-1', task: 'Verify' } };
    const { w } = await boot(rows, true, [], [], { sessions: [prime, worker] });
    const pane = w.document.getElementById('chatBody')!;
    let height = 400;
    Object.defineProperties(pane, { clientHeight: { get: () => height }, scrollHeight: { value: 2000 } });
    const resize = observers.find(observer => observer.targets.size === 1 && observer.targets.has(pane))!;
    expect(resize).toBeDefined();
    resize.notify();
    // Chromium clamps the initial follow to the tail; inspection there is still an explicit read.
    pane.scrollTop = 1600; pane.dispatchEvent(new w.Event('scroll'));
    (w.document.querySelector('#timeline .activity-workers') as HTMLButtonElement).click();
    height = 350; resize.notify();
    expect(pane.scrollTop).toBe(1600);
    (w.document.getElementById('jumpLatest') as HTMLButtonElement).click();
    height = 300; resize.notify();
    expect(pane.scrollTop).toBe(pane.scrollHeight);
  } finally { vi.unstubAllGlobals(); }
});

it.each([
  { setting: undefined, reader: 'moved', follows: true },
  { setting: undefined, reader: 'wheel', follows: false },
  { setting: undefined, reader: 'delayed-wheel', follows: false },
  { setting: undefined, reader: 'delayed-touch', follows: false },
  { setting: undefined, reader: 'delayed-key', follows: false },
  { setting: undefined, reader: 'delayed-scrollbar', follows: false },
  { setting: false, reader: 'moved', follows: false }
])('follows new output unless the reader scrolled away (setting $setting, view $reader)', async ({ setting, reader, follows }) => {
  // 2026-10-02: in a busy chat the view often stopped short of the end although the reader had not scrolled. Anything that moved it (an interrupted smooth scroll, a clamp during heavy repaints) made the next repaint read "scrolled away". With "Follow new output" only the reader's own scrolling counts; switched off, the per-repaint check stays as it was.
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `follow-${i}`, message: text(`Follow item ${i + 1}`) }));
  const { w, append } = await boot(rows, true, [], [], setting === undefined ? {} : { followOutput: setting });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight; pane.dispatchEvent(new w.Event('scroll'));
  await settle();
  // Chromium queues scroll delivery until a rendering opportunity. The Windows hidden-window verifier delivered it a second after the wheel, outside the old 300 ms intent heuristic. Advance only the sampled clock, not timers or the frame: this is one delayed render step.
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    if (reader.endsWith('wheel')) pane.dispatchEvent(new w.WheelEvent('wheel'));
    if (reader === 'delayed-touch') pane.dispatchEvent(new w.Event('touchmove'));
    if (reader === 'delayed-key') pane.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageUp' }));
    if (reader === 'delayed-scrollbar') pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0 }));
    if (reader.startsWith('delayed-')) clock.mockReturnValue(now + 1000);
    pane.scrollTop = 300;
    pane.dispatchEvent(new w.Event('scroll'));
    if (reader === 'delayed-scrollbar') w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
    pane.dispatchEvent(new w.Event('scrollend'));
  } finally { clock.mockRestore(); }
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message', messageId: 'follow-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(follows ? pane.scrollHeight : 300);
});

it.each(['scrollend', 'no-movement-frame'])(
  'does not borrow a finished reader gesture for programmatic movement (%s)', async end => {
    const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
      source: 'extension', kind: 'user_message', messageId: `ended-${i}`, message: text(`Item ${i + 1}`) }));
    const { w, append } = await boot(rows);
    const pane = w.document.getElementById('chatBody')!;
    const timeline = w.document.getElementById('timeline')!;
    Object.defineProperties(pane, { clientHeight: { value: 400 },
      scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new w.WheelEvent('wheel'));
    if (end === 'scrollend') {
      pane.dispatchEvent(new w.Event('scroll'));
      pane.dispatchEvent(new w.Event('scrollend'));
    } else {
      // Input that moved nothing expires after two frames and at least 100 ms.
      const armed = w.performance.now();
      for (let frames = 0; frames < 3 || w.performance.now() - armed < 150; frames++)
        await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
    }
    // No fresh input: a repaint/clamp is not the reader moving away from the end.
    pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
    await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
      messageId: 'ended-answer', message: text('A growing answer'), final: false }]);
    expect(pane.scrollTop).toBe(pane.scrollHeight);
  }
);

it('counts a smooth wheel scroll that starts a frame after its wheel event as reading', async () => {
  // A smooth scroll's first movement comes a frame after the wheel event. Expiring the wheel at that frame meant one notch up never counted, and the next delivery pulled the reader back down.
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `notch-${i}`, message: text(`Item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight;
  pane.dispatchEvent(new w.WheelEvent('wheel'));
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'notch-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(300);
});

it('keeps a slow scrolling gesture through its final position at the end', async () => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `inertia-${i}`, message: text(`Item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    pane.dispatchEvent(new w.WheelEvent('wheel'));
    pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
    await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
    clock.mockReturnValue(now + 2000);
    pane.scrollTop = pane.scrollHeight - pane.clientHeight;
    pane.dispatchEvent(new w.Event('scroll'));
    pane.dispatchEvent(new w.Event('scrollend'));
  } finally { clock.mockRestore(); }
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'inertia-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
});

it.each([false, true])('keeps a scrollbar press until release, even before its first movement (released: %s)', async released => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `pointer-${i}`, message: text(`Item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.scrollTop = pane.scrollHeight;
  pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0 }));
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  if (released) w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
  pane.dispatchEvent(new w.Event('scrollend'));
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'pointer-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(released ? pane.scrollHeight : 300);
});

it.each(['pending', 'escape', 'outside-click', 'scrollbar-click'])(
  'handles a middle-click toggle whose first movement comes after release (%s)', async mode => {
    const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
      source: 'extension', kind: 'user_message', messageId: `middle-${i}`, message: text(`Item ${i + 1}`) }));
    const { w, append } = await boot(rows);
    const pane = w.document.getElementById('chatBody')!;
    const timeline = w.document.getElementById('timeline')!;
    Object.defineProperties(pane, { clientHeight: { value: 400 },
      scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
    pane.scrollTop = pane.scrollHeight;
    pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 1 }));
    w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 1 }));
    await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
    if (mode === 'escape') w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    if (mode === 'outside-click') w.document.body.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0, bubbles: true }));
    if (mode === 'scrollbar-click') pane.dispatchEvent(new w.PointerEvent('pointerdown', { pointerId: 7, button: 0 }));
    pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
    if (mode === 'scrollbar-click') w.dispatchEvent(new w.PointerEvent('pointerup', { pointerId: 7, button: 0 }));
    pane.dispatchEvent(new w.Event('scrollend'));
    await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
      messageId: 'middle-answer', message: text('A growing answer'), final: false }]);
    expect(pane.scrollTop).toBe(mode === 'pending' || mode === 'scrollbar-click' ? 300 : pane.scrollHeight);
  }
);

it('does not lend a reader gesture to a new selection after A to B to A', async () => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `epoch-${i}`, message: text(`Item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, true, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  pane.dispatchEvent(new w.WheelEvent('wheel'));
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  for (const id of [second.id, first.id]) {
    w.document.querySelector<HTMLElement>(`#sessionList [data-id="${id}"]`)!.click();
    await settle();
  }
  pane.scrollTop = 300; pane.dispatchEvent(new w.Event('scroll'));
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message',
    messageId: 'epoch-answer', message: text('A growing answer'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
});

it('opens the next chat at its end after the reader scrolled away from a sent message', async () => {
  const rows = Array.from({ length: 40 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `reading-${i}`, message: text(`Reading item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, false, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  const select = async (id: string) => {
    (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click();
    await settle();
  };
  await select(first.id);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Hold this one'; input.dispatchEvent(new w.Event('input'));
  (w.document.getElementById('chatSend') as HTMLButtonElement).click();
  await settle();
  // The reader scrolls up with the wheel, releasing the hold on the sent message.
  pane.dispatchEvent(new w.WheelEvent('wheel'));
  pane.scrollTop = 300;
  pane.dispatchEvent(new w.Event('scroll'));
  await select(second.id);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  // Its answer keeps growing: the reader who just opened it follows the end.
  await append([{ seq: 100, time: T0 + 100, source: 'extension', kind: 'assistant_message', messageId: 'grown', message: text('A new answer'), final: false }]);
  expect(pane.scrollTop).toBe(pane.scrollHeight);
});
