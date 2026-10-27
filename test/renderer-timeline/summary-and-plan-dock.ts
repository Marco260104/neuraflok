import { expect, it, vi } from 'vitest';
import type { SessionEvent } from "../../contracts/session.js";
import type { InputArgs, InputEntry } from "../../backend/domains/sessions/input/input.js";

import { T0, TOKEN, boot, compaction, receivePlan, settle, summary, text, toolCall } from './context.js';

it('keeps one live compaction across refused source calls and unrelated old-turn commentary', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  const late = toolCall(4, 'late-source-call') as Extract<SessionEvent, { kind: 'tool_call' }>;
  late.call.outcome = 'tool_rejected';
  late.call.result = text('COMPACTION_IN_PROGRESS: no local tool was run.');
  await app.append([late, { seq: 5, time: T0 + 5000, source: 'extension', kind: 'assistant_message',
    messageId: 'old-commentary', turnId: 'old-turn', final: false, message: text('Still reading the old task.') }]);
  expect(state()).toBe('Summary requested — waiting for the provider…');
  expect(card.className).toContain('tone-wait');
  expect(card.textContent).not.toContain('Still reading the old task.');
  expect(app.w.document.querySelector('.ev-assistant_message')!.textContent).toContain('Still reading the old task.');
  await app.append([{ ...brief!, seq: 6, time: T0 + 6000 }, { ...end!, seq: 7, time: T0 + 7000 }]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(card.textContent).toContain('Goal: keep the loop running.');
  await app.append([{ ...handoff!, seq: 8, time: T0 + 8000 }, toolCall(9, 'late-recording')]);
  expect(state()).toContain('opening the new chat');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(app.w.document.querySelectorAll('details.compaction')).toHaveLength(1);
  expect(card.className).toContain('tone-good');
});

/** The shape the live recorder actually writes. The brief request is typed by the app, so its row carries no local turn id; the turn ChatGPT answers it in opens right after it. Folding by the request's own turn id left the start, the brief, the end and the handoff loose under an empty card — twenty rows for one compaction. */
it('folds the answer turn into the card when the request row has no turn id', async () => {
  const [request, start, brief, end, handoff, resume] = compaction(2) as [
    SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent, SessionEvent
  ];
  delete (request as { turnId?: string }).turnId;
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request,
    start,
    brief,
    end,
    handoff,
    { seq: 8, time: T0 + 8000, source: 'extension', kind: 'turn_start', turnId: 'turn-next' },
    resume
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-compaction']);
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-good');
});

it('says why a compaction died when the app abandoned it', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!,
    {
      seq: 7,
      time: T0 + 7000,
      source: 'app',
      kind: 'note',
      continuation: TOKEN,
      message: text('Compact & Resume abandoned — the handover never landed and was given up on')
    },
    toolCall(8, 'call-after')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const card = timeline.querySelector('details.compaction')!;
  expect(card.className).toContain('tone-bad');
  expect(card.querySelector('summary .state')!.textContent).toBe('Failed — the handover never landed and was given up on');
  // The note is the card's, not a loose row of its own.
  expect(timeline.querySelectorAll('.ev-note')).toHaveLength(0);
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('abandoned');
});

it('retains the open compaction disclosure and brief request while the summary streams and completes', async () => {
  const [request, start, original, , handoff, resume] = compaction(2);
  const brief = { ...original, origin: original!.seq, state: 'streaming', final: false } as Extract<SessionEvent, { kind: 'assistant_message' }>;
  const { w, append } = await boot([request!, start!, brief]);
  const card = w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  card.open = true;
  card.dispatchEvent(new w.Event('toggle'));
  const requestText = card.querySelector('.pre')!;
  const head = card.querySelector('summary')!;
  head.focus();
  for (let i = 0; i < 3; i++) {
    await append([{ ...brief, seq: 20 + i, message: text('# Brief\n\n' + 'More summary text. '.repeat(i + 2)), final: i === 2, state: i === 2 ? 'final' : 'streaming' }]);
    expect(w.document.querySelector('details.compaction')).toBe(card);
    expect(card.open).toBe(true);
    expect(card.querySelector('.pre')).toBe(requestText);
    expect(w.document.activeElement).toBe(head);
    expect(card.querySelector('.rich')!.textContent).toContain('More summary text.');
  }
  expect(card.querySelector('summary .state')!.textContent).toBe('Summary written — saving the handoff…');
  await append([{ ...handoff!, seq: 23 }, { ...resume!, seq: 24 }]);
  expect(w.document.querySelector('details.compaction')).toBe(card);
  expect(card.className).toContain('tone-good');
  card.open = false;
  card.dispatchEvent(new w.Event('toggle'));
  await append([toolCall(25, 'after-resume')]);
  expect(card.open).toBe(false);
});

it('keeps a streaming message anchor and its following tool group across canonical revisions', async () => {
  const message: Extract<SessionEvent, { kind: 'assistant_message' }> = { seq: 1, origin: 1, time: T0, source: 'extension',
    kind: 'assistant_message', messageId: 'live-message', message: text('Working'), state: 'streaming', final: false };
  const { w, append } = await boot([message, toolCall(2, 'live-tool'), toolCall(3, 'next-tool')]);
  const timeline = w.document.getElementById('timeline')!;
  const anchor = timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  group.open = true;
  group.dispatchEvent(new w.Event('toggle'));
  await append([{ ...message, seq: 4, message: text('Working on the next step') }]);
  expect(timeline.querySelector<HTMLElement>('.ev-assistant_message')!.dataset.timelineKey).toBe(anchor);
  expect(timeline.querySelector('.tool-group')).toBe(group);
  expect(group.open).toBe(true);
});

it('keeps an unfolded tool row as the same open node while the chat keeps appending', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const before = timeline.querySelector('.ev-tool_call details.tool') as HTMLDetailsElement;
  expect(before.open).toBe(false);
  before.open = true;
  before.dispatchEvent(new w.Event('toggle'));

  await append([toolCall(3, 'call-2'), toolCall(4, 'call-3')]);
  const rows = timeline.querySelectorAll('.ev-tool_call');
  expect(rows).toHaveLength(3);
  const after = rows[0]!.querySelector('details.tool') as HTMLDetailsElement;
  // Not rebuilt: the very node the user unfolded, still unfolded.
  expect(after).toBe(before);
  expect(after.open).toBe(true);
  const group = timeline.querySelector('details.tool-group') as HTMLDetailsElement;
  expect(group.open).toBe(true);
  group.open = false;
  group.dispatchEvent(new w.Event('toggle'));
  const detached: Node[] = [];
  const observer = new w.MutationObserver(records => records.forEach(record => detached.push(...record.removedNodes)));
  observer.observe(timeline, { childList: true, subtree: true });
  await append([toolCall(5, 'call-4')]);
  observer.disconnect();
  expect(detached.some(node => node === group || node === before || (node as Element).contains?.(before))).toBe(false);
  expect(timeline.querySelector('details.tool-group')).toBe(group);
  expect(group.open).toBe(false);
  expect(group.querySelector('.activity-title')!.textContent).toBe('Read README.md');
  expect(group.querySelector('.activity-count')!.textContent).toBe('4');
  expect(group.querySelector('summary')!.title).toContain('4 actions');
});

it('colors removed lines separately from added lines without changing other tool metrics', async () => {
  const edit = toolCall(1, 'edit-lines') as Extract<SessionEvent, { kind: 'tool_call' }>;
  edit.call.tool = 'apply_patch';
  edit.call.summary = { kind: 'edit', tone: 'good', title: 'Edited 2 files', metric: '+28 −11' };
  edit.call.changes = [{ path: '/repo/file.ts', added: 28, removed: 11, approximate: false }];
  const removal = toolCall(2, 'removed-lines') as Extract<SessionEvent, { kind: 'tool_call' }>;
  removal.call.tool = 'apply_patch';
  removal.call.summary = { kind: 'delete', tone: 'warn', title: 'Deleted file.ts', metric: '~−7' };
  removal.call.changes = [{ path: '/repo/removed.ts', added: 0, removed: 7, approximate: true }];
  const read = toolCall(3, 'read-lines') as Extract<SessionEvent, { kind: 'tool_call' }>;
  read.call.summary = { kind: 'read', tone: 'neutral', title: 'Read file.ts', metric: '12 lines' };

  const { w } = await boot([edit, removal, read]);
  const rows = [...w.document.querySelectorAll<HTMLDetailsElement>('details.tool')];
  expect(rows).toHaveLength(3);
  expect(rows[0]!.querySelector('summary .metric')?.textContent).toBe('+28 −11');
  expect(rows[0]!.querySelector('summary .metric-added')?.textContent).toBe('+28');
  expect(rows[0]!.querySelector('summary .metric-removed')?.textContent).toBe('−11');
  // The outcome metric already states this delta, so the per-call count beside the title stays out.
  expect(rows[0]!.querySelector('summary .tool-change-count')).toBeNull();
  expect(rows[1]!.querySelector('summary .metric')?.textContent).toBe('~−7');
  // A delta metric formatted differently from the count ("~−7" beside "+0 −7") is still one number.
  expect(rows[1]!.querySelector('summary .tool-change-count')).toBeNull();
  expect(rows[1]!.querySelector('summary .metric-removed')?.textContent).toBe('−7');
  expect(rows[2]!.querySelector('summary .metric')?.textContent).toBe('12 lines');
  expect(rows[2]!.querySelector('summary .metric-added, summary .metric-removed')).toBeNull();

  rows[0]!.open = true;
  rows[0]!.dispatchEvent(new w.Event('toggle'));
  expect(rows[0]!.querySelector('.edit-card .metric-added')?.textContent).toBe('+28');
  expect(rows[0]!.querySelector('.edit-card .metric-removed')?.textContent).toBe('−11');
  rows[1]!.open = true;
  rows[1]!.dispatchEvent(new w.Event('toggle'));
  expect(rows[1]!.querySelector('.edit-card summary')?.textContent).toContain('(approx.)');
  expect(rows[1]!.querySelector('.edit-card .metric-removed')?.textContent).toBe('−7');
});

it('opens a round with the ChatGPT caption and keeps its mixed tool and agent activity in one latest-action disclosure', async () => {
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'progress', message: text('Checking the implementation') },
    toolCall(2, 'first'),
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'agent_message', messageId: 'agent-update', from: 'worker-2', to: 'prime', delivery: 'delivered', message: text('Found the root cause') },
    toolCall(4, 'last')
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  expect(group.open).toBe(false);
  // The caption is what ChatGPT said before the step: it stands as the round's opening line.
  expect(timeline.children[0]!.className).toContain('ev-progress');
  expect(timeline.children[0]!.textContent).toContain('Checking the implementation');
  expect(group.querySelector('.activity-title')!.textContent).toBe(group.querySelector('.ev-tool_call:last-of-type .tool > summary b')!.textContent);
  expect(group.querySelector('.agent-communication summary')!.textContent).toContain('Message from worker-2');
  expect(group.querySelector('.agent-avatar')).not.toBeNull();
  expect(group.querySelectorAll('.ev')).toHaveLength(3);
  await append([
    { seq: 5, time: T0 + 5000, source: 'extension', kind: 'progress', message: text('Now validating') },
    toolCall(6, 'next'), toolCall(7, 'next-2')
  ]);
  expect(timeline.querySelectorAll('.tool-group')).toHaveLength(2);
  expect(timeline.children[0]!.className).toContain('ev-progress');
});

it('never titles a tool group with the app\'s own recovery note', async () => {
  // #882: after a run of reloads, every tool group read "Reloaded chat to recover an interrupted response.", because the note in front of a group was taken for ChatGPT's phase caption. Repair notes are shown in developer mode, where that reporter saw it.
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'progress', progressId: 'browser-repair:chat:one',
      message: text('Reloaded chat to recover an interrupted response.') },
    toolCall(2, 'first'), toolCall(3, 'last')
  ], true, [], [], { developerMode: true });
  const timeline = w.document.getElementById('timeline')!;
  const group = timeline.querySelector<HTMLDetailsElement>('.tool-group')!;
  const title = group.querySelector('.activity-title')!.textContent;
  expect(title).not.toContain('Reloaded chat');
  expect(title).toBe(group.querySelector('.ev-tool_call:last-of-type .tool > summary b')?.textContent ?? title);
  // The note itself stays in the transcript, in front of the group.
  expect(timeline.children[0]!.textContent).toContain('Reloaded chat to recover an interrupted response.');
});

it('closes a stopped turn with a line saying it stopped, after any late work, and keeps the request line', async () => {
  // A stop request remains pending until the provider confirms that generation stopped.
  const request = 'Stop requested. The finish hold was released; the assistant has not yet confirmed that generation stopped.';
  const stoppedLine = 'Stopped. The provider page no longer shows this turn running.';
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'g-stop' },
    { ...toolCall(2, 'before-stop'), turnId: 'g-stop' } as SessionEvent,
    { seq: 3, time: T0 + 3000, source: 'app', kind: 'progress', turnId: 'g-stop', progressId: 'finish-release:g-stop', message: text(request) }
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const lines = () => [...timeline.querySelectorAll('.ev')].map(row => row.textContent ?? '');
  const last = () => lines().at(-1)!;
  expect(lines().some(line => line.includes(stoppedLine))).toBe(false);
  await append([{ seq: 4, time: T0 + 3200, source: 'extension', kind: 'turn_end', turnId: 'g-stop', outcome: 'stopped' }]);
  expect(last()).toContain(stoppedLine);
  expect(lines().filter(line => line.includes(request))).toHaveLength(1);
  // A tool dispatched before the stop reopens the turn until it stops again.
  await append([
    { ...toolCall(5, 'late'), time: T0 + 4000, turnId: 'g-stop' } as SessionEvent,
    { seq: 6, time: T0 + 4000, source: 'app', kind: 'turn_start', turnId: 'g-stop' }
  ]);
  expect(lines().some(line => line.includes(stoppedLine))).toBe(false);
  // The page ends it again: the line closes the turn, after the late call.
  await append([{ seq: 7, time: T0 + 9000, source: 'extension', kind: 'turn_end', turnId: 'g-stop', outcome: 'stopped' }]);
  expect(lines().filter(line => line.includes(stoppedLine))).toHaveLength(1);
  expect(last()).toContain(stoppedLine);
  expect(lines().filter(line => line.includes(request))).toHaveLength(1);
});

it('folds five consecutive status polls while retaining each exact tool row', async () => {
  const status = (seq: number): SessionEvent => {
    const event = toolCall(seq, `status-${seq}`) as Extract<SessionEvent, { kind: 'tool_call' }>;
    return { ...event, call: { ...event.call, tool: 'agents', summary: { kind: 'agent', tone: 'neutral', title: 'Checked agent status' } } };
  };
  const { w, append } = await boot([status(1), status(2), status(3), status(4)]);
  const timeline = w.document.getElementById('timeline')!;
  expect(timeline.querySelector('.routine-activity')).toBeNull();
  await append([status(5)]);
  const fold = timeline.querySelector<HTMLDetailsElement>('.routine-activity')!;
  expect(fold.querySelector('.routine-count')!.textContent).toBe('×5');
  expect(fold.querySelectorAll('.ev-tool_call')).toHaveLength(5);
  fold.open = true;
  fold.dispatchEvent(new w.Event('toggle'));
  await append([status(6)]);
  expect(timeline.querySelector('.routine-activity')).toBe(fold);
  expect(fold.open).toBe(true);
  expect(fold.querySelectorAll('.ev-tool_call')).toHaveLength(6);
  expect(fold.querySelector('.routine-count')!.textContent).toBe('×6');
  const failed = status(7) as Extract<SessionEvent, { kind: 'tool_call' }>;
  await append([{ ...failed, call: { ...failed.call, outcome: 'tool_rejected', summary: { ...failed.call.summary, tone: 'bad' } } }]);
  expect(fold.querySelectorAll('.ev-tool_call')).toHaveLength(6);
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(7);
});

it("shows a created file's line count once when the outcome metric already states it", async () => {
  const created = toolCall(1, 'created-file') as Extract<SessionEvent, { kind: 'tool_call' }>;
  created.call.tool = 'apply_patch';
  created.call.summary = { kind: 'create', tone: 'good', title: 'Created CHANGELOG-0.4.5.txt', metric: '+39' };
  created.call.changes = [{ path: 'CHANGELOG-0.4.5.txt', added: 39, removed: 0, approximate: false }];
  const { w } = await boot([created]);
  const row = w.document.querySelector<HTMLDetailsElement>('details.tool')!;
  expect(row.querySelectorAll('summary .metric-added')).toHaveLength(1);
  expect(row.querySelector('summary .tool-change-count')).toBeNull();
  expect(row.querySelector('summary .metric')?.textContent).toBe('+39');
});

it('keeps an artifact action as the activity title rather than its tool tag', async () => {
  const shell = toolCall(3, 'shell') as Extract<SessionEvent, { kind: 'tool_call' }>;
  const { w } = await boot([toolCall(2, 'read'), { ...shell, call: {
    ...shell.call, tool: 'exec_command', summary: { kind: 'run', tone: 'good', title: 'Ran build checks' },
    changes: [{ path: 'src/app.ts', added: 2, removed: 1, approximate: true }]
  } }]);
  const group = w.document.querySelector('.tool-group')!;
  expect(group.querySelector('.activity-title')!.textContent).toBe('Ran build checks');
  expect(group.querySelector('.tool-tag')!.textContent).toBe('shell');
  expect(group.querySelector('.tool-change-count')!.textContent).toContain('approx.');
});

it('controls the selected session without submitting another user message', async () => {
  const { w, live } = await boot([]);
  const mode = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  mode.value = 'loop'; mode.dispatchEvent(new w.Event('change'));
  await settle();
  expect(live.controlCalls).toEqual([{ id: summary([]).id, action: 'loop' }]);
  expect(live.sent).toEqual([]);
  w.document.getElementById('compactSession')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'compact' });
  expect((w.document.getElementById('compactSession') as HTMLButtonElement).disabled).toBe(true);
  expect((w.document.getElementById('cancelCompaction') as HTMLElement).hidden).toBe(false);
  w.document.getElementById('cancelCompaction')!.click(); await settle();
  expect(live.controlCalls.at(-1)).toEqual({ id: summary([]).id, action: 'cancel' });
  w.document.getElementById('newChat')!.click(); await settle();
  expect((w.document.getElementById('sessionControls') as HTMLElement).hidden).toBe(false);
});

it('offers deliberate helper retry only for the selected source session', async () => {
  const sourceSessionId = summary([]).id;
  const { w, live } = await boot([], true, [
    { id: 'paused-selected', sourceSessionId },
    { id: 'paused-other', sourceSessionId: 'another-session' }
  ]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Its old chat may still be running');
  expect(queue.querySelectorAll('button')).toHaveLength(1);
  expect(live.controlCalls).toEqual([]);
  (queue.querySelector('button') as HTMLButtonElement).click();
  await settle();
  expect(live.controlCalls).toEqual([{ id: sourceSessionId, action: 'retry:paused-selected' }]);
  expect(queue.querySelectorAll('button')).toHaveLength(0);
});

it('does not expose the retired End turn menu action', async () => {
  const { w, live } = await boot([]);
  expect(w.document.getElementById('releaseFinish')).toBeNull();
  expect(live.controlCalls).toEqual([]);
  expect(live.sent).toEqual([]);
});

it('updates an offered injection receipt in its existing transcript position', async () => {
  const message: SessionEvent = { seq: 1, time: T0, source: 'app', kind: 'user_message', messageId: 'input:receipt-test', message: text('Injected instruction'), inputDelivery: 'offered' };
  const app = await boot([message, toolCall(2, 'later-work')]);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Sent to the active turn · awaiting receipt');
  app.live.events[0] = { ...message, seq: 3, inputDelivery: 'confirmed' };
  await app.append([]);
  expect(app.w.document.querySelectorAll('.input-receipt')).toHaveLength(1);
  expect(app.w.document.querySelector('.input-receipt')?.getAttribute('aria-label')).toBe('Delivery confirmed');
});

it.each(['menu', 'send'])('queues an Astra finish message through %s using the existing staged queue', async action => {
  const app = await boot([]);
  const { w, live } = app;
  const api = (w as any).api;
  const original = api.getSessionControls;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data, queueAtFinish: true, canInject: true } });
  await app.append([]);
  expect(w.document.getElementById('queueAtFinish')!.hidden).toBe(false);
  expect(w.document.getElementById('afterTurnLabel')!.textContent).toBe('Queue at Session finish');
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'The next stage';
  input.dispatchEvent(new w.Event('input'));
  if (action === 'menu') w.document.getElementById('queueAtFinish')!.click();
  else {
    (w.document.getElementById('sendMode') as HTMLSelectElement).value = 'after-turn';
    w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  }
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'The next stage', mode: 'finish' });
});

it('shows injection only for an exact active turn, never merely recent chat activity', async () => {
  const { w, append } = await boot([toolCall(1, 'recent-call')]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An authored follow-up'; input.dispatchEvent(new w.Event('input'));
  expect(options.hidden).toBe(false);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([toolCall(2, 'more-recent-call')]);
  expect(options.hidden).toBe(true);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('auto');
});

// A text for the running turn goes through ChatGPT's composer (#1231), so a running turn offers Send directly alone; Inject now stays for a Pro turn, which keeps tool injection.
it('shows Send directly alone for a running turn, keeps After this turn selected, and offers Inject now on a Pro turn', async () => {
  const { w, append } = await boot([]);
  const api = (w as any).api;
  const original = api.getSessionControls;
  let pro = false;
  api.getSessionControls = async (id: string) => ({ ok: true, data: { ...(await original(id)).data,
    activeTurnId: 'plain-turn', canInject: pro, canSendDirectly: !pro, queueAtFinish: false } });
  await append([]);
  const options = w.document.getElementById('sendOptions')!;
  expect(options.hidden).toBe(false);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Send directly');
  expect((options.querySelector('[data-delivery="tool"]') as HTMLElement).hidden).toBe(true);
  await append([toolCall(1, 'first-mcp-call')]);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Send directly');
  (options.querySelector('[data-delivery="after-turn"]') as HTMLButtonElement).click();
  await append([]);
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
  pro = true;
  await append([toolCall(2, 'second-mcp-call')]);
  expect((options.querySelector('[data-delivery="tool"]') as HTMLElement).hidden).toBe(false);
  expect(options.querySelector('[data-delivery="auto"]')!.textContent).toBe('Inject now');
  expect((w.document.getElementById('sendMode') as HTMLSelectElement).value).toBe('after-turn');
});

it('shows elapsed work for the exact recorded turn without exposing lifecycle rows', async () => {
  const { w, append } = await boot([{ seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'held-turn' }]);
  expect(w.document.getElementById('chatState')!.textContent).toMatch(/^Working for /);
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true, data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  await append([{ seq: 2, time: T0 + 65_000, source: 'extension', kind: 'turn_end', turnId: 'held-turn', outcome: 'completed' }]);
  expect(w.document.getElementById('chatState')!.textContent).toBe('Worked for 1m 5s');
});

/** A chat whose page stopped reporting turns still says it is working. Every branch of this caption needs a turn to describe, and a page that stopped reporting supplies none — so the line either fell silent or went on describing the previous turn as finished while the chat kept working. Measured on 2026-09-25: a conversation resumed after an automatic compaction made 650 exactly attributed tool calls over two and a half hours with no turn reported by its page, and the app said nothing about any of it. The person then sits in front of a chat that looks idle and waits for work that is already happening. The recorded tool clock is what the page is not: `lastToolCallAt` comes from calls the request-id join has already tied to this exact conversation. */
it('says a chat is working when its page reports no turn but its tools keep arriving', async () => {
  const ended: SessionEvent[] = [
    { seq: 1, time: T0, source: 'extension', kind: 'turn_start', turnId: 'page-turn' },
    { seq: 2, time: T0 + 5_000, source: 'extension', kind: 'turn_end', turnId: 'page-turn', outcome: 'completed' }
  ];
  const row = { ...summary(ended), lastToolCallAt: null as number | null };
  const { w, append } = await boot(ended, true, [], [], { sessions: [row] });
  // No turn from the page's side, which is the whole subject.
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  const note = w.document.getElementById('chatState')!;

  // The turn the page did report is over, and nothing has happened since.
  await append([]);
  expect(note.textContent).toBe('Worked for 5s');

  row.lastToolCallAt = Date.now() - 20_000;
  await append([]);
  expect(note.textContent, 'a blind chat still claimed to be finished').toBe('Working…');
  expect(note.classList.contains('is-working')).toBe(true);

  // Old enough to be the record of a chat that has since stopped: the caption lets go again.
  row.lastToolCallAt = Date.now() - 10 * 60_000;
  await append([]);
  expect(note.textContent).toBe('Worked for 5s');
});

it('says a chat worked as soon as its page reports the end after its last tool call', async () => {
  // A normal turn: tools run, then the page reports the end. The last call is recent, but the reported end is newer, so nothing is unaccounted for and the caption must not wait out the blind window.
  const start = Date.now() - 40_000;
  const turn: SessionEvent[] = [
    { seq: 1, time: start, source: 'extension', kind: 'turn_start', turnId: 'page-turn' },
    { seq: 2, time: start + 38_000, source: 'extension', kind: 'turn_end', turnId: 'page-turn', outcome: 'completed' }
  ];
  const row = { ...summary(turn), lastToolCallAt: start + 33_000 as number | null };
  const { w, append } = await boot(turn, true, [], [], { sessions: [row] });
  (w as any).api.getSessionControls = (id: string) => Promise.resolve({ ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null } });
  const note = w.document.getElementById('chatState')!;
  await append([]);
  expect(note.textContent).toBe('Worked for 38s');
  expect(note.classList.contains('is-working')).toBe(false);

  // A call after that reported end is still work the page has not accounted for.
  row.lastToolCallAt = start + 39_000;
  await append([]);
  expect(note.textContent).toBe('Working…');
});

it('stops directly from the empty composer without a second Stop menu action', async () => {
  const { w } = await boot([]);
  const stop = vi.fn(async () => ({ ok: true, data: {} }));
  (w as any).api.stopSessionTurn = stop;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  expect(send.getAttribute('aria-label')).toBe('Stop turn');
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle(); expect(stop).not.toHaveBeenCalled();
  input.value = 'Keep this draft'; input.dispatchEvent(new w.Event('input'));
  expect(send.getAttribute('aria-label')).toBe('Send message');
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  expect(w.document.getElementById('stopTurnAction')).toBeNull();
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('sendOptions')!.hidden).toBe(false);
  send.click();
  await settle();
  expect(stop).toHaveBeenCalledWith('2026-09-02-test0001', 'held-turn');
  expect(input.value).toBe('');
});

it('shows Stop immediately for a queued first send, switches to Send for a new draft, and cancels through the same button', async () => {
  const { w, live } = await boot([], false);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const send = w.document.getElementById('chatSend') as HTMLButtonElement;
  const form = w.document.getElementById('composer')!;
  input.value = 'First request';
  form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  expect(send.dataset.action).toBe('stop');
  expect(send.disabled).toBe(false);
  await settle();
  expect(send.dataset.action).toBe('stop');
  expect(w.document.querySelector('#inputQueue button')?.textContent).not.toBe('Cancel');
  input.value = 'Second request'; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('send');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(send.dataset.action).toBe('stop');
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  send.click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.sent[0]!.id);
  expect(send.dataset.action).toBe('send');
});

it('opens the saved task editor from the Goal dock and still closes it on outside clicks', async () => {
  const { w } = await boot([]);
  (w.document.querySelector('#automationSwitch [data-mode="goal"]') as HTMLButtonElement).click();
  await settle();
  const menu = w.document.getElementById('composerSettings') as HTMLDetailsElement;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  const edit = w.document.querySelector('#activeGoalRow button[aria-label="Edit task"]') as HTMLButtonElement;
  expect(edit).not.toBeNull();
  menu.open = false;
  edit.click();
  expect(menu.open).toBe(true);
  expect(w.document.activeElement).toBe(objective);
  w.document.body.click();
  expect(menu.open).toBe(false);
  await settle();
});

it.each(['off', 'goal', 'loop'])('retains the first-message draft and task across chat navigation (%s)', async mode => {
  const { w, live } = await boot([], false, [], [], { reserveOpenings: true });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  const automation = w.document.getElementById('chatAutomation') as HTMLSelectElement;
  const delivery = w.document.getElementById('loopDelivery') as HTMLSelectElement;
  (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
  input.value = 'First message\nwith pasted context'; input.dispatchEvent(new w.Event('input'));
  objective.value = 'Keep the original task'; objective.dispatchEvent(new w.Event('input'));
  delivery.value = 'after-turn'; delivery.dispatchEvent(new w.Event('change'));
  const visitExisting = () => (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  const returnToDraft = () => w.document.getElementById('newChat')!.click();
  visitExisting(); await settle();
  expect(input.value).toBe('');
  input.value = 'Separate existing-chat draft';
  returnToDraft(); await settle();
  returnToDraft(); await settle();
  expect(input.value).toBe('First message\nwith pasted context');
  expect(objective.value).toBe('Keep the original task');
  expect(automation.value).toBe(mode);
  expect(delivery.value).toBe('after-turn');
  visitExisting(); await settle();
  expect(input.value).toBe('Separate existing-chat draft');
  returnToDraft(); await settle();
  input.value = ''; objective.value = '';
  visitExisting(); returnToDraft(); await settle();
  expect(input.value).toBe(''); expect(objective.value).toBe('');
  input.value = 'Actually send this';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Actually send this', automation: mode });
  returnToDraft(); await settle();
  expect(input.value).toBe(''); expect(objective.value).toBe(''); expect(automation.value).toBe('off');
});

it('retains the New Chat objective through Goal, Off and Goal toggles', async () => {
  const { w } = await boot([], false);
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  objective.value = 'Build and verify the requested feature';
  objective.dispatchEvent(new w.Event('input'));
  for (const mode of ['goal', 'off', 'goal']) {
    (w.document.querySelector(`#automationSwitch [data-mode="${mode}"]`) as HTMLButtonElement).click();
    await settle();
    expect(objective.value).toBe('Build and verify the requested feature');
    expect(objective.hidden).toBe(mode === 'off');
    expect(w.document.getElementById('saveSessionObjective')!.hidden).toBe(mode === 'off');
    expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe(mode);
  }
  expect(w.document.getElementById('clearSessionObjective')).toBeNull();
  expect(w.document.getElementById('showHandoff')).toBeNull();
});

it('keeps editable stages and sends the original request with the full workflow exactly once', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  const api = (w as any).api;
  (await api.getState()).data.config.ui.finishTool = true;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task';
  input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Build the whole task', planOnly: true });
  await receivePlan(app, ['Build foundation', 'Verify it']);
  expect(w.document.getElementById('taskPlanPreview')!.textContent).not.toMatch(/Start plan|Review stages/);
  const edit = w.document.querySelector<HTMLButtonElement>('[aria-label="Edit stage 1"]')!;
  edit.click();
  const stage = w.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit stage 1"]')!;
  stage.value = 'Build the edited foundation'; stage.dispatchEvent(new w.Event('input'));
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Approve plan');
  (w.document.querySelector(`[data-id="${summary([]).id}"]`) as HTMLButtonElement).click();
  await settle();
  w.document.getElementById('newChat')!.click(); await settle();
  expect(w.document.getElementById('taskPlanPreview')!.textContent).toContain('Build the edited foundation');
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Build the edited foundation', stages: ['Verify it'], objective: 'Build the whole task', authoredSource: 'objective' });
  expect(w.document.getElementById('taskPlanPreview')!.hidden).toBe(true);
  expect(w.document.getElementById('finishQueue')!.hidden).toBe(false);
  expect(w.document.getElementById('finishQueue')!.textContent).toContain('Verify it');
  expect(w.document.querySelector('[aria-label="Plan stage · waiting for the first message to be sent"]')).not.toBeNull();
});

it.each([true, false])('hands plan presentation to queued stages while sending and restores a rejected draft (accepted=%s)', async accepted => {
  const app = await boot([], false);
  const { w, live, append } = app;
  const api = (w as any).api;
  const stages = ['Define the build', 'Assign first worker', 'Assign second worker', 'Integrate', 'Verify', 'Acceptance'];
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Build the whole task'; input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('createPlan')!.click(); w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await settle();
  await receivePlan(app, stages);
  const preview = w.document.getElementById('taskPlanPreview')!;
  expect(preview.hidden).toBe(false);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(6);
  let finish!: (result: unknown) => void;
  let first!: InputEntry;
  api.sendInput = vi.fn((args: InputArgs) => {
    live.sent.push(args);
    first = { ...args, state: 'queued', owner: null, createdAt: Date.now(), conversationId: 'chat-b' };
    // An outbox observation can arrive before the original send IPC response. Its checkpoint projection must not coexist with the editable six-stage draft.
    live.inputs = [first];
    return new Promise(resolve => { finish = resolve; });
  });
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await append([]);
  expect(preview.hidden).toBe(true);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(0);
  expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(5);
  expect(live.sent.at(-1)).toMatchObject({ text: stages[0], stages: stages.slice(1) });
  if (!accepted) live.inputs = [];
  finish(accepted ? { ok: true, data: first } : { ok: false, error: 'Fixture send rejected' });
  await settle();
  expect(preview.hidden).toBe(accepted);
  expect(preview.querySelectorAll('.plan-stage')).toHaveLength(accepted ? 0 : 6);
  if (!accepted) expect(input.value).toBe('');
});

it.each(['delivery', 'enqueue-failed'])('retries the durable full plan without pasting stage one (%s)', async failure => {
  const { w, live, append } = await boot([], true);
  const api = (w as any).api;
  const original: InputEntry = { id: 'failed-plan', sessionId: summary([]).id, requestedSessionId: null, opening: true, projectId: null, text: 'Implement everything',
    objective: 'Original complete request', stages: ['Verify gameplay', 'Verify voice', 'Final review'], automation: 'off',
    model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'high', mode: 'auto', dueAt: 1, createdAt: 1, state: 'failed',
    owner: 'old-page', conversationId: null, error: 'Delivery failed' };
  live.inputs = [original]; await append([]);
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'An independent draft'; input.dispatchEvent(new w.Event('input'));
  if (failure === 'enqueue-failed') api.sendInput = vi.fn(async () => ({ ok: false, error: 'Connection failed' }));
  const retry = w.document.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!;
  retry.click(); retry.click(); await settle(); await append([]);
  expect(input.value).toBe('An independent draft');
  if (failure === 'enqueue-failed') {
    expect(live.sent).toHaveLength(0);
    expect(w.document.querySelector('[aria-label="Retry delivery"]')).not.toBeNull();
    expect(live.inputs[0]!.stages).toEqual(original.stages);
    expect(w.localStorage.getItem('dismissed-input-notices') ?? '').not.toContain(original.id);
  } else {
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]).toMatchObject({ text: original.text, objective: original.objective, stages: original.stages,
      automation: 'off', model: original.model, reasoningEffort: 'high', mode: 'auto' });
    expect(live.sent[0]!.id).not.toBe(original.id);
    expect(live.sent[0]).not.toHaveProperty('owner');
    expect(w.document.querySelectorAll('#finishQueue .queued-input')).toHaveLength(3);
  }
});

it('the Plan toggle only arms planning; Send generates from the draft', async () => {
  const { w, live } = await boot([], false);
  const api = (w as any).api;
  api.draftTaskPlan = vi.fn(() => new Promise(() => {}));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const plan = w.document.getElementById('createPlan') as HTMLButtonElement;
  input.value = 'Existing draft'; input.dispatchEvent(new w.Event('input'));
  plan.click(); await settle();
  expect(api.draftTaskPlan).not.toHaveBeenCalled();
  expect(live.sent).toHaveLength(0);
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  expect(plan.getAttribute('aria-pressed')).toBe('true');
  input.value = 'Plan this'; input.dispatchEvent(new w.Event('input'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); await settle();
  expect(api.draftTaskPlan).not.toHaveBeenCalled();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]).toMatchObject({ text: 'Plan this', planOnly: true });
});

it('the mode-menu pencil edits an objective without switching automation until Save', async () => {
  const { w, live } = await boot([]);
  const api = (w as any).api;
  api.setSessionObjective = vi.fn(async () => ({ ok: true, data: {} }));
  const objective = w.document.getElementById('sessionObjective') as HTMLTextAreaElement;
  (w.document.querySelector('#automationSwitch [data-edit-mode="goal"]') as HTMLButtonElement).click(); await settle();
  expect(live.controlCalls).toEqual([]);
  expect((w.document.getElementById('chatAutomation') as HTMLSelectElement).value).toBe('off');
  expect(objective.hidden).toBe(false);
  expect(w.document.activeElement).toBe(objective);
  expect(w.document.querySelector('label[for="sessionObjective"]')!.textContent).toBe('Goal');
  objective.value = 'Ship the dashboard'; objective.dispatchEvent(new w.Event('input'));
  w.document.getElementById('saveSessionObjective')!.click(); await settle();
  expect(api.setSessionObjective).toHaveBeenCalledWith(summary([]).id, 'Ship the dashboard', 'goal');
  expect(live.controlCalls).toEqual([]);
  expect((w.document.getElementById('composerSettings') as HTMLDetailsElement).open).toBe(false);
});
