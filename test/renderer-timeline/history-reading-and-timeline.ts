import { expect, it, vi } from 'vitest';
import type { SessionEvent } from "../../contracts/session.js";
import { positionOf, projectTimeline } from "../../contracts/chronology.js";

// Tests the live session timeline in the renderer booted in jsdom.

import { T0, TOKEN, boot, settle, settleHistoryFrame, summary, text, toolCall } from './context.js';

it('opens every selected chat at the bottom and preserves manual reading during live updates', async () => {
  const rows = Array.from({ length: 160 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `opening-${i}`, message: text(`Opening item ${i + 1}`) }));
  const first = summary(rows), second = { ...summary(rows), id: '2026-09-02-test0002', title: 'Other chat' };
  const { w, append } = await boot(rows, false, [], [], { sessions: [first, second] });
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => timeline.querySelectorAll('[data-timeline-key]').length * 100 } });
  w.document.getElementById('timelineContent')!.getBoundingClientRect = () => ({ height: pane.scrollHeight } as DOMRect);
  const select = async (id: string) => {
    (w.document.querySelector(`#sessionList [data-id="${id}"]`) as HTMLElement).click();
    await settle();
    expect(pane.scrollTop).toBe(pane.scrollHeight); // Chromium clamps to the actual bottom.
  };
  await select(first.id);
  // The reader's own scrolling: a wheel, then the position it lands on.
  const readTo = (top: number) => {
    pane.dispatchEvent(new w.WheelEvent('wheel'));
    pane.scrollTop = top;
    pane.dispatchEvent(new w.Event('scroll'));
  };
  // A global notification from another chat still refreshes this idle selection. A deliberate small scroll away from its bottom must remain a reading position.
  readTo(pane.scrollHeight - pane.clientHeight - 20);
  const nearTail = pane.scrollTop;
  for (let index = 0; index < 3; index++) {
    await append([]);
    expect(pane.scrollTop).toBe(nearTail);
  }
  for (let i = 0; i < 3; i++) {
    readTo(700);
    await append([]);
    expect(pane.scrollTop).toBe(700);
    await select(second.id);
    readTo(0);
    await select(first.id);
  }

  // A late opening response must neither replace the current chat nor drag its reader down.
  const api = (w as any).api, original = api.getSession;
  const pending: Array<() => void> = [];
  api.getSession = async (id: string, options: unknown) => {
    await new Promise<void>(resolve => pending.push(resolve));
    return original(id, options);
  };
  await append([]); // Old A refresh is still in flight when A -> B -> A begins.
  (w.document.querySelector(`#sessionList [data-id="${second.id}"]`) as HTMLElement).click();
  (w.document.querySelector(`#sessionList [data-id="${first.id}"]`) as HTMLElement).click();
  expect(pending).toHaveLength(3);
  pending[2]!(); await settle();
  expect(pane.scrollTop).toBe(pane.scrollHeight);
  pane.scrollTop = 850;
  pending[1]!(); pending[0]!(); await settle();
  expect(pane.scrollTop).toBe(850);
  expect(w.document.getElementById('chatTitle')!.textContent).toBe(first.title);
});

it.each(['empty', 'failed'])('keeps a fitting chat live after an %s older-page read', async outcome => {
  const { w, append } = await boot([{ seq: 12, time: T0, source: 'extension', kind: 'user_message',
    messageId: 'short', message: text('Short chat') }]);
  const api = (w as any).api, original = api.getSession;
  const read = vi.fn((id: string, options: any) => options?.before && outcome === 'failed'
    ? Promise.resolve({ ok: false, error: 'Read failed' }) : original(id, options));
  api.getSession = read;
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 800 }, scrollHeight: { value: 800 } });
  pane.scrollTop = 0;
  pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settle();
  expect(read).toHaveBeenCalledWith(expect.any(String), { before: 12, limit: 30 });
  expect(pane.scrollTop).toBe(0);
  expect(timeline.querySelector('.timeline-window-note')).toBeNull();
  expect(w.document.getElementById('timelineContent')!.style.getPropertyValue('--timeline-scroll-reserve')).toBe('');
  await append([{ seq: 13, time: T0 + 1, source: 'extension', kind: 'assistant_message',
    messageId: 'fresh', message: text('Still receiving live output'), final: true }]);
  expect(timeline.textContent).toContain('Still receiving live output');
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { from: 13, limit: 30 });
});

it('loads bounded earlier pages on deliberate upward scrolling without draining on render', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `history-${i}`, message: text(`History item ${i + 1}`) }));
  const { w, append } = await boot(rows);
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  expect(timeline.querySelector('[data-history="older"]')).toBeNull();
  pane.dispatchEvent(new w.Event('scroll')); await settle();
  expect(timeline.textContent).toContain('History item 360');
  expect(timeline.textContent).not.toContain('History item 121');
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 10000 });
  for (const row of timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')) row.getBoundingClientRect = () => {
    const top = [...timeline.querySelectorAll('[data-timeline-key]')].indexOf(row) * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) };
  };
  const up = async () => {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  };
  await up();
  expect(pane.scrollTop).toBe(600);
  expect(timeline.textContent).toContain('History item 301');
  expect(timeline.textContent).toContain('History item 360');
  await append([{ seq: 361, time: T0 + 361, source: 'extension', kind: 'user_message', messageId: 'newest', message: text('Newest live input') }]);
  expect(timeline.textContent).toContain('History item 301');
  expect(timeline.textContent).not.toContain('Newest live input');
  for (let page = 0; page < 12 && !timeline.textContent?.includes('History item 1'); page++) await up();
  expect(timeline.textContent).toContain('History item 1');
  expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
  expect(timeline.querySelector('[data-history="latest"]')).toBeNull();
});

it('scrolls forward through evicted history with wheel, keyboard and scrollbar, then resumes live deltas', async () => {
  const rows = Array.from({ length: 400 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `bidirectional-${i}`, message: text(`Bidirectional item ${i + 1}.`) }));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  const read = vi.fn(async (_id: string, options: { from?: number; before?: number; after?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || positionOf(e) < options.before) && (options.after === undefined || positionOf(e) > options.after));
    const page = options.from === undefined && options.after === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  });
  api.getSession = read;
  const timeline = w.document.getElementById('timeline')!;
  const pane = w.document.getElementById('chatBody')!;
  Object.defineProperties(pane, { clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, get: () => timeline.querySelectorAll('[data-timeline-key]').length * 20 } });
  // Model one layout snapshot per DOM revision. A selector scan inside every rectangle read made this mock quadratic and exhausted Windows CI's timeout.
  let geometryRows: Map<Element, number> | null = null;
  const geometryChanges = new w.MutationObserver(() => { geometryRows = null; });
  geometryChanges.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-key'] });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (geometryChanges.takeRecords().length) geometryRows = null;
    geometryRows ??= new Map([...timeline.querySelectorAll('[data-timeline-key]')].map((row, index) => [row, index]));
    const index = geometryRows.get(this) ?? -1;
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  for (let i = 0; i < 14 && !timeline.textContent?.includes('Bidirectional item 1.'); i++) {
    pane.scrollTop = 0;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
    await settleHistoryFrame(w);
  }
  expect(timeline.textContent).toContain('Bidirectional item 1.');
  expect(timeline.textContent).not.toContain('Bidirectional item 400.');
  const downward = async (kind: string) => {
    pane.scrollTop = pane.scrollHeight - pane.clientHeight;
    const anchor = [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')].find(row => {
      const rect = row.getBoundingClientRect(); return rect.bottom > 0 && rect.top >= 0;
    })!;
    const before = anchor.getBoundingClientRect().top;
    if (kind === 'wheel') pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 }));
    else if (kind === 'keyboard') pane.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'PageDown' }));
    else {
      pane.scrollTop -= 100;
      pane.dispatchEvent(new w.Event('pointerdown'));
      pane.scrollTop += 100; pane.dispatchEvent(new w.Event('scroll'));
      w.dispatchEvent(new w.Event('pointerup'));
    }
    await settleHistoryFrame(w);
    expect(anchor.isConnected).toBe(true);
    expect(anchor.getBoundingClientRect().top).toBe(before);
    expect(timeline.querySelectorAll('[data-timeline-key]').length).toBeLessThanOrEqual(160);
    const count = read.mock.calls.length;
    pane.dispatchEvent(new w.Event('scroll')); await settleHistoryFrame(w);
    expect(read).toHaveBeenCalledTimes(count);
  };
  for (let page = 0; page < 14 && !timeline.textContent?.includes('Bidirectional item 400.'); page++) {
    await downward(['wheel', 'keyboard', 'scrollbar'][page % 3]!);
  }
  expect(timeline.textContent).toContain('Bidirectional item 400.');
  expect(read.mock.calls.every(([, options]) => options.limit === 30)).toBe(true);
  await downward('wheel'); // Empty forward page proves we reached the current tail.
  await append([{ seq: 401, time: T0 + 401, source: 'extension', kind: 'user_message', messageId: 'live-again', message: text('Live again') }]);
  expect(timeline.textContent).toContain('Live again');
  geometryChanges.disconnect();
});

it('keeps a revised long answer reachable in both directions and never uses its revision as a history boundary', async () => {
  const rows = Array.from({ length: 360 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `origin-${i}`, message: text(`Origin row ${i + 1}.`) }));
  rows[99] = { seq: 1000, origin: 100, time: T0 + 99, source: 'extension', kind: 'assistant_message',
    messageId: 'long-reviewed-answer', message: text('Detailed ratings. '.repeat(1000)), final: true };
  const { w } = await boot(rows);
  const api = (w as any).api;
  const read = vi.fn(api.getSession);
  api.getSession = read;
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  // The renderer fills a requested edge across animation frames. A permanently underfilled mock kept that demand alive, making the last read depend on timing.
  Object.defineProperties(pane, { clientHeight: { value: 400 },
    scrollHeight: { get: () => Math.max(400, timeline.querySelectorAll('[data-timeline-key]').length * 20) } });
  let geometryRows: Map<Element, number> | null = null;
  const geometryChanges = new w.MutationObserver(() => { geometryRows = null; });
  geometryChanges.observe(timeline, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-timeline-key'] });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (geometryChanges.takeRecords().length) geometryRows = null;
    geometryRows ??= new Map([...timeline.querySelectorAll('[data-timeline-key]')].map((row, index) => [row, index]));
    const index = geometryRows.get(this) ?? -1;
    const top = index < 0 ? 0 : index * 20 - pane.scrollTop;
    return { top, bottom: top + 20, height: 20 } as DOMRect;
  };
  const page = async (deltaY: number) => {
    pane.scrollTop = deltaY < 0 ? 0 : pane.scrollHeight - pane.clientHeight;
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY }));
    await settleHistoryFrame(w);
  };
  for (let index = 0; index < 12 && !timeline.textContent?.includes('Detailed ratings.'); index++) await page(-100);
  expect(timeline.textContent).toContain('Detailed ratings.');
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(1);
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { before: 121, limit: 30 });
  const newestBefore = Math.max(...[...timeline.querySelectorAll<HTMLElement>('.ev-user_message')]
    .map(row => Number(row.textContent?.match(/Origin row (\d+)\./)?.[1] ?? 0)));
  await page(100);
  expect(read).toHaveBeenLastCalledWith(expect.any(String), { after: newestBefore, limit: 30 });
  expect(timeline.textContent).toContain(`Origin row ${newestBefore + 30}.`);
  await page(-100);
  expect(timeline.textContent).toContain('Detailed ratings.');
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(1);
  geometryChanges.disconnect();
});

it('keeps reloaded interim messages above their tool groups through live results and repaint', async () => {
  const working = '11111111-1111-4111-8111-111111111111';
  const exchange = '22222222-2222-4222-8222-222222222222';
  const parent = '33333333-3333-4333-8333-333333333333';
  const turns = { working: { origin: 1, time: T0 } };
  const rows: SessionEvent[] = [
    { seq: 1, time: T0, kind: 'turn_start', source: 'extension', turnId: 'working' },
    { seq: 2, time: T0 + 2000, kind: 'assistant_message', source: 'extension', turnId: 'working',
      messageId: `assistant:${parent}:${working}:${exchange}`, message: text('FIRST UPDATE'), final: false },
    ...[3, 4].map(seq => ({ ...toolCall(seq, `before-${seq}`), turnId: 'working' })),
    { seq: 7, origin: 5, time: T0 + 5000, kind: 'assistant_message', source: 'extension',
      messageId: `assistant:${exchange}:${working}:${exchange}`, message: text('SECOND UPDATE'), final: false },
    { ...toolCall(6, 'after-6'), turnId: 'working' },
    { ...toolCall(8, 'after-8'), turnId: 'working' }
  ];
  const { w, append } = await boot(projectTimeline(rows, turns));
  const timeline = w.document.getElementById('timeline')!;
  const reading = () => [...timeline.children].filter(row => row.matches('.ev-assistant_message, .tool-group'));
  expect(reading().map(row => row.classList.contains('tool-group') ? 'TOOLS' : row.textContent))
    .toEqual([expect.stringContaining('FIRST UPDATE'), 'TOOLS', expect.stringContaining('SECOND UPDATE'), 'TOOLS']);
  const group = reading()[3] as HTMLDetailsElement;
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  await append(projectTimeline([{ ...toolCall(9, 'after-9'), turnId: 'working' }], turns, {}, rows));
  expect(reading()[3]).toBe(group);
  expect(group.open).toBe(true);
  expect(group.querySelectorAll('.ev-tool_call')).toHaveLength(3);
  await append([]);
  expect(reading()[2]?.textContent).toContain('SECOND UPDATE');
  expect(reading()[3]).toBe(group);
  expect(timeline.querySelectorAll('.ev-assistant_message')).toHaveLength(2);
});

it('keeps long surrounding prose while materializing large tool results only on expansion', async () => {
  const call = toolCall(2, 'large-output');
  if (call.kind !== 'tool_call') throw new Error('Expected fixture tool');
  call.call.result = text('Recorded output. '.repeat(150000));
  const { w, append } = await boot([
    { seq: 1, time: T0, kind: 'assistant_message', source: 'extension', messageId: 'before-large', message: text('Prose before the large tool'), final: false },
    call,
    { seq: 3, time: T0 + 3000, kind: 'assistant_message', source: 'extension', messageId: 'after-large', message: text('Prose after the large tool'), final: true }
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const disclosure = timeline.querySelector<HTMLDetailsElement>('details.tool')!;
  expect(disclosure.querySelector('.raw')).toBeNull();
  expect(timeline.textContent).toContain('Prose before the large tool');
  expect(timeline.textContent).toContain('Prose after the large tool');
  disclosure.open = true; disclosure.dispatchEvent(new w.Event('toggle')); await settle();
  expect(disclosure.querySelector('.raw')?.textContent).toContain('Recorded output.');
  await append([]);
  expect(timeline.querySelector('details.tool')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(timeline.textContent).toContain('Prose before the large tool');
});

it('retains the visible collapsed group beyond the normal resident target and still admits newer data', async () => {
  const rows = Array.from({ length: 400 }, (_, i) => toolCall(i + 1, `dense-${i}`));
  const { w, live, append } = await boot(rows);
  const api = (w as any).api;
  api.getSession = async (_id: string, options: { from?: number; before?: number; after?: number; limit: number }) => {
    const eligible = live.events.filter(e => (options.from === undefined || e.seq >= options.from) && (options.before === undefined || positionOf(e) < options.before) && (options.after === undefined || positionOf(e) > options.after));
    const page = options.from === undefined && options.after === undefined ? eligible.slice(-options.limit) : eligible.slice(0, options.limit);
    return { ok: true, data: { summary: summary(live.events), events: page, total: live.events.length,
      nextFrom: page.reduce((next, e) => Math.max(next, e.seq + 1), options.from ?? 0) } };
  };
  const pane = w.document.getElementById('chatBody')!;
  const timeline = w.document.getElementById('timeline')!;
  Object.defineProperties(pane, { clientHeight: { value: 400 }, scrollHeight: { value: 400 } });
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, bottom: this.classList.contains('tool-group') ? 30 : 0,
      height: this.classList.contains('tool-group') ? 30 : 0 } as DOMRect;
  };
  const group = timeline.querySelector('.tool-group');
  // One deliberate movement keeps filling the edge through collapsed batches. Await the actual read result, including its animation-frame yields.
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 }));
  await vi.waitFor(() => expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(rows.length), { timeout: 5000 });
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(timeline.querySelectorAll('.raw')).toHaveLength(0);
  for (let i = 0; i < 14; i++) {
    pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: 100 })); await settle();
  }
  await append([{ seq: 401, time: T0 + 401_000, source: 'extension', kind: 'user_message',
    messageId: 'dense-live', message: text('New data at the resident bound') }]);
  expect(timeline.textContent).toContain('New data at the resident bound');
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(timeline.querySelectorAll('.ev').length).toBeLessThanOrEqual(rows.length + 1);
});

it.each(['older', 'newer'])('does not apply a %s-page response or scroll after switching to a new chat', async direction => {
  const rows = Array.from({ length: 200 }, (_, i): SessionEvent => ({ seq: i + 1, time: T0 + i,
    source: 'extension', kind: 'user_message', messageId: `prior-${i}`, message: text(`Prior row ${i}`) }));
  const { w } = await boot(rows);
  const api = (w as any).api;
  const pane = w.document.getElementById('chatBody')!;
  if (direction === 'newer') {
    pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -100 })); await settle();
  }
  const original = api.getSession;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  api.getSession = async (id: string, options: any) => { if (options?.before || options?.after !== undefined) await pending; return original(id, options); };
  pane.scrollTop = 0; pane.dispatchEvent(new w.WheelEvent('wheel', { deltaY: direction === 'older' ? -100 : 100 }));
  await settle();
  (w.document.getElementById('newChat') as HTMLElement).click(); await settle();
  pane.scrollTop = 73;
  release(); await settle();
  expect(w.document.getElementById('timeline')!.textContent).not.toContain('Prior row');
  expect(pane.scrollTop).toBe(73);
});

it('clears a delivered check when later model activity arrives without a timer', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt', inputId: 'receipt', inputDelivery: 'confirmed', message: text('Continue') };
  const app = await boot([message]);
  const receipt = app.w.document.querySelector('.input-receipt') as HTMLElement;
  expect(receipt.hidden).toBe(false);
  await app.append([toolCall(2, 'next-tool')]);
  expect(app.w.document.querySelector('.input-receipt')).toBe(receipt);
  expect(receipt.hidden).toBe(true);
});

it('keeps a cancelled automatic draft at its creation time as later messages arrive', async () => {
  const app = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'user_message', messageId: 'before-draft', message: text('Original work') },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'user_message', messageId: 'after-draft', message: text('Later continuation') }
  ]);
  const { w, live } = app;
  live.inputs.push({ id: 'retired-auto', sessionId: summary([]).id, conversationId: 'chat-b', text: 'Unused automatic instruction',
    mode: 'auto', dueAt: T0 + 1000, createdAt: T0 + 1000, state: 'cancelled', owner: null, model: null, reasoningEffort: null,
    finishOwner: { turnId: 'old-turn', periodic: false },
    error: 'Automatic follow-up cancelled because its active turn or setting changed.' });
  await app.append([]);
  const timeline = w.document.getElementById('timeline')!;
  const retired = timeline.querySelector<HTMLElement>('[data-input-id="retired-auto"]')!;
  expect(retired).not.toBeNull();
  expect(retired.querySelector('time')!.textContent).toBe(new Date(T0 + 1000).toLocaleString('en'));
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Unused automatic instruction');
  const before = () => timeline.textContent!.indexOf('Unused automatic instruction') < timeline.textContent!.indexOf('Later continuation');
  expect(before()).toBe(true);
  await app.append([{ seq: 3, time: T0 + 3000, source: 'extension', kind: 'assistant_message', messageId: 'new-progress', message: text('New work continues'), final: false }]);
  expect(timeline.querySelector('[data-input-id="retired-auto"]')).toBe(retired);
  expect(before()).toBe(true);
  expect(live.sent).toHaveLength(0);
  retired.querySelector<HTMLButtonElement>('[title="Dismiss delivery notice"]')!.click();
  await app.append([]);
  expect(timeline.textContent).not.toContain('Unused automatic instruction');
  expect(live.sent).toHaveLength(0);
});

it('keeps the latest recovery verdict in view until the chat works again', async () => {
  // 2026-09-26: a stopped prime was explained only by timeline notes that scrolled away.
  const verdict = 'Could not restart this chat automatically: the browser chat was closed. Send a message here to continue it.';
  const app = await boot([
    { seq: 1, time: T0 + 1000, source: 'extension', kind: 'turn_start', turnId: 'stalled' },
    { seq: 2, time: T0 + 2000, source: 'extension', kind: 'turn_end', turnId: 'stalled', outcome: 'stalled' },
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'note', message: text(verdict) }
  ] as SessionEvent[]);
  const host = app.w.document.getElementById('recoveryStatus')!;
  expect(host.hidden).toBe(false);
  expect(host.textContent).toContain('Could not restart this chat automatically');
  await app.append([{ seq: 4, time: T0 + 4000, source: 'extension', kind: 'turn_start', turnId: 'resumed' } as SessionEvent]);
  expect(host.hidden).toBe(true);
});

it('does not show a handoff note as a recovery verdict', async () => {
  const app = await boot([{ seq: 1, time: T0 + 1000, source: 'app', kind: 'note', continuation: TOKEN, message: text('Compact & Resume abandoned') }] as SessionEvent[]);
  expect(app.w.document.getElementById('recoveryStatus')!.hidden).toBe(true);
});

it('uses the Working label for active turns', async () => {
  const { w } = await boot([{ seq: 1, time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Working for /);
});

it('offers copy and Markdown export under the answer of a completed turn only', async () => {
  const ask: SessionEvent = { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'done-turn', messageId: 'ask', message: text('Write hello.txt') };
  const reply: SessionEvent = { kind: 'assistant_message', seq: 2, time: T0 + 1_000, source: 'extension', turnId: 'done-turn', messageId: 'reply', message: text('Created **hello.txt**.'), final: true, state: 'final' };
  const { w, append } = await boot([ask, reply]);
  const api = (w as any).api;
  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'copied' } }));
  // Still open: the answer may yet change, so it offers nothing.
  expect(w.document.querySelector('.answer-actions')).toBeNull();

  await append([{ seq: 3, time: T0 + 2_000, source: 'extension', kind: 'turn_end', turnId: 'done-turn', outcome: 'completed' }]);
  const actions = w.document.querySelector('.ev-assistant_message .said .answer-actions');
  expect(actions).not.toBeNull();
  expect(w.document.querySelectorAll('.answer-actions')).toHaveLength(1);

  (actions!.querySelector('button.answer-action') as HTMLButtonElement).click(); await settle();
  expect(api.exportMarkdown).toHaveBeenCalledWith({ id: summary([]).id, scope: 'answer', turnId: 'done-turn', target: 'clipboard' });
  expect(actions!.querySelector('button.answer-action')!.classList.contains('is-done')).toBe(true);

  api.exportMarkdown = vi.fn(async () => ({ ok: true, data: { done: 'saved', name: 'chat.md' } }));
  const choices = [...actions!.querySelectorAll<HTMLButtonElement>('.answer-export-choice')];
  expect(choices.map(choice => choice.textContent)).toEqual(['This answer', 'Whole session']);
  choices[1]!.click(); await settle();
  expect(api.exportMarkdown).toHaveBeenCalledWith({ id: summary([]).id, scope: 'session', turnId: undefined, target: 'file' });
});

it('does not offer copy or export after an interrupted turn', async () => {
  const reply: SessionEvent = { kind: 'assistant_message', seq: 1, time: T0, source: 'extension', turnId: 'cut-turn', messageId: 'cut', message: text('Half an answer'), final: true, state: 'final' };
  const { w } = await boot([reply, { seq: 2, time: T0 + 1_000, source: 'extension', kind: 'turn_end', turnId: 'cut-turn', outcome: 'interrupted' }]);
  expect(w.document.querySelector('.answer-actions')).toBeNull();
});

it('opens each turn with how long it has worked, live while running and still once ended', async () => {
  const start: SessionEvent = { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'long-turn' };
  const ask: SessionEvent = { kind: 'user_message', seq: 2, origin: 2, time: T0 + 100, source: 'extension', turnId: 'long-turn', messageId: 'q', message: text('Check the sites') };
  const note: SessionEvent = { kind: 'assistant_message', seq: 3, time: T0 + 2_000, source: 'extension', turnId: 'long-turn', messageId: 'c', message: text('Checking both.'), final: true, state: 'final' };
  const reply: SessionEvent = { kind: 'assistant_message', seq: 4, time: T0 + 70_000, source: 'extension', turnId: 'long-turn', messageId: 'r', message: text('Both sites return 200 OK.'), final: true, state: 'final' };
  const { w, append } = await boot([start, ask, note, reply]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([{ seq: 5, time: T0 + 72_000, source: 'extension', kind: 'turn_end', turnId: 'long-turn', outcome: 'completed' }]);
  const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
  expect(lines.map(line => line.textContent)).toEqual(['Worked for 1m 11s']);
  // At the top of the turn: after your message, before its first reply.
  expect(lines[0]!.previousElementSibling?.matches('.ev-user_message')).toBe(true);
  expect(lines[0]!.nextElementSibling?.textContent).toContain('Checking both.');
  // The header no longer repeats it.
  expect(w.document.getElementById('chatState')!.classList.contains('is-mirrored')).toBe(true);
});

it('keeps a still worked line on earlier turns while the latest turn has its own', async () => {
  const turn = (id: string, at: number, seq: number): SessionEvent[] => [
    { seq, time: at, source: 'extension', kind: 'turn_start', turnId: id },
    { kind: 'user_message', seq: seq + 1, origin: seq + 1, time: at + 10, source: 'extension', turnId: id, messageId: `q-${id}`, message: text(`Ask ${id}`) },
    { kind: 'assistant_message', seq: seq + 2, time: at + 5_000, source: 'extension', turnId: id, messageId: `r-${id}`, message: text(`Answer ${id}`), final: true, state: 'final' },
    { seq: seq + 3, time: at + 9_000, source: 'extension', kind: 'turn_end', turnId: id, outcome: 'completed' }
  ];
  const { w, append } = await boot([...turn('first', T0, 1), ...turn('second', T0 + 60_000, 5)]);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([]);
  const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
  expect(lines.map(line => line.textContent)).toEqual(['Worked for 8s', 'Worked for 8s']);
  expect(lines.map(line => line.nextElementSibling?.textContent ?? '')).toEqual([expect.stringContaining('Answer first'), expect.stringContaining('Answer second')]);
});

it('shows the running turn working at its top while it works', async () => {
  const running: SessionEvent[] = [
    { seq: 1, time: Date.now() - 12_000, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: Date.now() - 11_900, source: 'extension', turnId: 'held-turn', messageId: 'q-live', message: text('Build it') },
    { kind: 'assistant_message', seq: 3, time: Date.now() - 9_000, source: 'extension', turnId: 'held-turn', messageId: 'c-live', message: text('Starting the build.'), final: true, state: 'final' }
  ];
  const { w } = await boot(running);
  const line = w.document.querySelector<HTMLElement>('#timeline .turn-status')!;
  expect(line.textContent).toMatch(/^Working for /);
  expect(line.classList.contains('is-working')).toBe(true);
  expect(line.previousElementSibling?.matches('.ev-user_message')).toBe(true);
});

it('clears the thinking indicator when a failed turn ends even if controls still report it active', async () => {
  const now = Date.now();
  const { w, append } = await boot([
    { seq: 1, time: now - 5_000, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: now - 4_900, source: 'extension', turnId: 'held-turn', messageId: 'q-failed', message: text('Test a failed reply') },
    { kind: 'chat_error', seq: 3, time: now - 2_000, source: 'extension', turnId: 'held-turn', recoverable: false, message: text('Sign in to DeepSeek in this browser, then try again.') },
    { seq: 4, time: now - 1_900, source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'failed' }
  ]);
  await append([]);

  expect(w.document.getElementById('timeline')!.textContent).toContain('Sign in to DeepSeek in this browser');
  expect(w.document.querySelectorAll('.turn-status.is-working, .turn-now:not([hidden])')).toHaveLength(0);
});

it('ends the running turn with a row saying what it is doing now', async () => {
  const asked = Date.now() - 12_000;
  const { w, append } = await boot([
    { seq: 1, time: asked - 100, source: 'extension', kind: 'turn_start', turnId: 'held-turn' },
    { kind: 'user_message', seq: 2, origin: 2, time: asked, source: 'extension', turnId: 'held-turn', messageId: 'q-now', message: text('Run the tests') }
  ]);
  const now = () => w.document.querySelector<HTMLElement>('#timeline .turn-now')!;
  // The Working line keeps only its clock; the step is the last row of the turn's work.
  expect(w.document.querySelector('#timeline .turn-status')!.textContent).toMatch(/^Working for \d+s$/);
  expect(now().parentElement!.lastElementChild).toBe(now());
  const shown = () => now().hidden ? null : [now().querySelector('.turn-now-text')!.textContent, now().querySelector('.turn-now-time')!.textContent];
  // Nothing visible has happened since the message.
  expect(shown()).toEqual(['Thinking…', '']);
  // A call of this app runs for this chat: it is named, with its own clock once it lasts.
  const asks: string[][] = [];
  (w as any).api.runningTools = (ids: string[]) => {
    asks.push(ids);
    return Promise.resolve({ ok: true, data: [{ title: 'Running npm test', kind: 'run', since: Date.now() - 5_000 }] });
  };
  await append([]); await append([]);
  expect(asks.at(-1)).toEqual(['chat-b', 'chat-a']);
  expect(shown()).toEqual(['Running npm test', '5s']);
  // No call of ours: ChatGPT's own step, while it is still going on.
  (w as any).api.runningTools = () => Promise.resolve({ ok: true, data: [] });
  await append([{ seq: 3, time: Date.now(), source: 'extension', kind: 'page_tool', messageId: 'thought-1', label: 'Searching the web' }]);
  await append([]);
  expect(shown()?.[0]).toBe('Searching the web');
  // It follows the work: a new step lands above it, and it stays the last row.
  expect(now().previousElementSibling?.textContent).toContain('Searching the web');
  expect(now().parentElement!.lastElementChild).toBe(now());
  // Prose speaks for itself while it is being written…
  await append([{ kind: 'assistant_message', seq: 4, time: Date.now(), source: 'extension', messageId: 'a-now', message: text('Two tests fail…'), final: false, state: 'streaming' }]);
  expect(shown()).toBeNull();
  // …and once it stops changing the turn is still working: an interim paragraph stays "streaming".
  await new Promise(resolve => setTimeout(resolve, 2_600));
  await append([]);
  expect(shown()?.[0]).toBe('Thinking…');
});

it('shows a just-started turn working right after your message, never in the header first', async () => {
  // The controls report a running turn before any of its rows reached the timeline.
  const { w } = await boot([]);
  const line = w.document.querySelector<HTMLElement>('.turn-status')!;
  expect(line.textContent).toMatch(/^Working/);
  expect(line.classList.contains('is-working')).toBe(true);
  expect(line.previousElementSibling?.id).toBe('inputQueue');
  expect(w.document.getElementById('chatState')!.classList.contains('is-mirrored')).toBe(true);
});

it('anchors the worked line to your message when the page reports an empty turn and untagged work', async () => {
  // Measured in a live session: the page opened and closed an empty turn right after the message, then every row of the real work arrived with no turn id at all.
  const asked = T0;
  const rows: SessionEvent[] = [
    { kind: 'user_message', seq: 1, origin: 1, time: asked, source: 'extension', turnId: 'message-scope-id', messageId: 'ask-5', message: text('Legal, mais uma vez') },
    { seq: 2, time: asked + 200, source: 'extension', kind: 'turn_start', turnId: 'ghost-turn' },
    { seq: 3, time: asked + 300, source: 'extension', kind: 'turn_end', turnId: 'ghost-turn', outcome: 'completed' },
    { kind: 'assistant_message', seq: 4, time: asked + 2_000, source: 'extension', messageId: 'plan-5', message: text('Claro. Vou repetir em um quinto arquivo.'), final: true, state: 'final' },
    { kind: 'assistant_message', seq: 5, time: asked + 21_000, source: 'extension', messageId: 'done-5', message: text('Feito novamente.'), final: true, state: 'final' }
  ];
  const { w, append } = await boot(rows);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([]);
  const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
  expect(lines.map(line => line.textContent)).toEqual(['Worked for 21s']);
  expect(lines[0]!.previousElementSibling?.matches('.ev-user_message')).toBe(true);
  expect(lines[0]!.nextElementSibling?.textContent).toContain('quinto arquivo');
});
