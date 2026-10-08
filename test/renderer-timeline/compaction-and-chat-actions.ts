import { expect, it, vi } from 'vitest';
import type { SessionEvent } from "../../contracts/session.js";
import type { LocalProject } from "../../contracts/workspace/projects.js";

import { T0, TOKEN, boot, compaction, settle, summary, text, toolCall } from './context.js';

it('folds a whole Compact & Resume into one row that says the new chat opened', async () => {
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1'),
    ...compaction(3),
    toolCall(9, 'call-2')
  ]);
  const timeline = w.document.getElementById('timeline')!;

  const cards = timeline.querySelectorAll('details.compaction');
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  expect(card.className).toContain('tone-good');
  expect(card.querySelector('summary')!.textContent).toMatch(/^Compact & Resume:New chat opened at .* \(44 characters\)$/);
  expect(card.querySelectorAll('summary .step')).toHaveLength(0);

  // The rows the card replaces are gone from the list; nothing else is.
  expect(timeline.querySelector('.ev-handoff')).toBeNull();
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.querySelectorAll('.ev-turn_start, .ev-turn_end')).toHaveLength(0);
  expect(timeline.querySelectorAll('.ev-tool_call')).toHaveLength(2);
  // The card sits where the compaction happened, between the two calls.
  const order = [...timeline.children].map((row) => row.className);
  expect(order).toEqual(['ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  // Everything is still there for whoever unfolds the card.
  card.toggleAttribute('open', true);
  expect(card.textContent).toContain('Brief request');
  expect(card.textContent).toContain('keep the loop running');
  expect(card.textContent).toContain('Handoff saved');
  expect(card.textContent).toContain('Bootstrap sent into the new chat');
});

it('folds a Compact & Resume whose marker ChatGPT escaped as Markdown', async () => {
  // Same fold, same assertions, but the two prompts are recorded the way the composer has written them since 2026-09-16. Every reader of the shared marker regex reads text that came back out of the page, so they all stopped matching at once: this card was not built at all, and the raw marker was left on screen in the rows it should have replaced.
  const { w } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    toolCall(2, 'call-1'),
    ...compaction(3, true),
    toolCall(9, 'call-2')
  ]);
  const timeline = w.document.getElementById('timeline')!;

  const cards = timeline.querySelectorAll('details.compaction');
  expect(cards).toHaveLength(1);
  expect(cards[0]!.querySelector('summary')!.textContent).toMatch(/^Compact & Resume:New chat opened at .* \(44 characters\)$/);
  // Stripped in the form it was recorded in, so no half-removed marker survives either.
  expect(timeline.textContent).not.toContain('[[CLF-');
  expect(timeline.textContent).not.toMatch(/(?:CLF|NEURAFLOK)-RESUME/);
  expect([...timeline.children].map((row) => row.className)).toEqual(['ev ev-tool_call', 'ev ev-compaction', 'ev ev-tool_call']);

  cards[0]!.toggleAttribute('open', true);
  expect(cards[0]!.textContent).toContain('Brief request');
  expect(cards[0]!.textContent).toContain('keep the loop running');
});

it('retires a pending Skills picker when sending replaces its draft', async () => {
  const { w, live } = await boot([], false);
  let resolve!: (value: unknown) => void;
  (w as any).api.skillLibrary = () => new Promise(done => { resolve = done; });
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/'; input.setSelectionRange(1, 1); input.dispatchEvent(new w.Event('input', { bubbles: true }));
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(false);
  input.value = 'Complete my task'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent[0]?.text).toBe('Complete my task');
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(true);
  input.value = 'Next task';
  resolve({ ok: true, data: { skills: [{ id: 'old', name: 'Old', description: '', path: '/skills/old/SKILL.md', scope: 'managed', managed: true, source: 'managed', allowImplicitInvocation: true }], roots: [], errors: [], includeInstructions: true } });
  await settle();
  expect(input.value).toBe('Next task');
  expect((w.document.getElementById('skillPicker') as HTMLElement).hidden).toBe(true);
});

it('uses slash Skills completion and delivers the selected directive once with the unchanged task', async () => {
  const { w, live } = await boot([], false);
  (w as any).api.skillLibrary = vi.fn(async () => ({ ok: true, data: { skills: [
    { id: 'review', name: 'Review code', description: 'Inspect before editing', path: '/skills/review/SKILL.md', managed: true, source: 'managed', scope: 'managed', allowImplicitInvocation: true }
  ], roots: [], errors: [], includeInstructions: true } }));
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Do my entire task.\nKeep the second line.';
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  input.value = '/re\n' + input.value; input.setSelectionRange(3, 3); input.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  w.document.querySelector<HTMLButtonElement>('.skill-choice[data-skill-id="review"]')!.click();
  expect(input.value).toBe('Do my entire task.\nKeep the second line.');
  expect(w.document.querySelectorAll('.composer-selected-skill')).toHaveLength(1);
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent).toHaveLength(1);
  expect(live.sent[0]!.text).toBe('/review\nDo my entire task.\nKeep the second line.');
  expect(w.document.querySelectorAll('.composer-selected-skill')).toHaveLength(0);
});

it('keeps Projects and Chats separate while preserving disclosure state through activity refresh', async () => {
  const project: LocalProject = { id: '33333333-3333-4333-8333-333333333333', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const linked = { ...summary([]), id: 'linked-chat', projectId: project.id };
  const standalone = { ...summary([]), id: 'standalone-chat', projectId: undefined };
  const app = await boot([], false, [], [project], { sessions: [linked, standalone] });
  expect(app.w.document.querySelector('#projectList [data-id="linked-chat"]')).not.toBeNull();
  expect(app.w.document.querySelector('#chatList [data-id="standalone-chat"]')).not.toBeNull();
  expect(app.w.document.querySelector('#chatList [data-id="linked-chat"]')).toBeNull();
  const projects = app.w.document.getElementById('projectsSection') as HTMLDetailsElement;
  projects.open = false; await app.append([]);
  expect(app.w.document.getElementById('projectsSection')).toBe(projects);
  expect(projects.open).toBe(false);
});

it('reviews only an exact recorded edit without expanding its tool row or querying Git', async () => {
  const project: LocalProject = { id: '33333333-3333-4333-8333-333333333333', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const edit = toolCall(2, 'edit-one');
  if (edit.kind !== 'tool_call') throw new Error('Expected a tool call');
  edit.call.tool = 'apply_patch';
  edit.call.summary = { kind: 'edit', title: 'Edited src/main.ts', metric: '+1 −1', tone: 'good' };
  edit.call.changes = [{ path: '/repo/src/main.ts', added: 1, removed: 1, approximate: false, reviewAssetId: 'deadbeef.txt' }];
  const app = await boot([edit], true, [], [project]);
  const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });
  const reviewCall = vi.fn(() => ok({ callId: edit.call.callId, changeIndex: 0, path: 'src/main.ts', added: 1, removed: 1,
    baseText: 'before', currentText: 'after' }));
  app.w.api.getToolEditReview = reviewCall;
  const row = app.w.document.querySelector<HTMLDetailsElement>('details.tool')!;
  const review = row.querySelector<HTMLButtonElement>('.tool-open-diff')!;
  expect(review.getAttribute('aria-label')).toBe('Review this edit');
  review.click(); await settle();
  expect(row.open).toBe(false);
  expect(reviewCall).toHaveBeenCalledWith(expect.any(String), edit.call.callId, 0);
  expect(app.w.document.querySelector<HTMLElement>('.review-panel .file-changes-view')?.hidden).toBe(false);
  expect(app.w.document.querySelector('.review-panel .file-preview-meta')?.textContent).toContain('This edit');
});

it('says why an edit has no diff and how many files a partial review covers (#563)', async () => {
  const project: LocalProject = { id: '44444444-4444-4444-8444-444444444444', name: 'Workspace', path: '/workspace', createdAt: T0 };
  const missing = toolCall(2, 'edit-too-large');
  const partial = toolCall(3, 'edit-partial');
  if (missing.kind !== 'tool_call' || partial.kind !== 'tool_call') throw new Error('Expected tool calls');
  for (const edit of [missing, partial]) {
    edit.call.tool = 'apply_patch';
    edit.call.summary = { kind: 'edit', title: 'Edited files', metric: '+2 −2', tone: 'good' };
  }
  missing.call.changes = [{ path: '/repo/big.json', added: 1, removed: 1, approximate: false, reviewUnavailable: 'too-large' }];
  partial.call.changes = [
    { path: '/repo/src/a.ts', added: 1, removed: 1, approximate: false, reviewAssetId: 'deadbeef.txt' },
    { path: '/repo/src/b.ts', added: 1, removed: 1, approximate: false, reviewUnavailable: 'not-kept' }
  ];
  const app = await boot([missing, partial], true, [], [project]);
  const [first, second] = [...app.w.document.querySelectorAll<HTMLDetailsElement>('details.tool')];
  const unavailable = first!.querySelector<HTMLButtonElement>('.tool-open-diff')!;
  expect(unavailable.classList.contains('is-unavailable')).toBe(true);
  expect(unavailable.getAttribute('aria-disabled')).toBe('true');
  expect(unavailable.getAttribute('aria-label')).toBe('Diff unavailable: this edit was too large to keep');
  unavailable.click(); await settle();
  expect(first!.open).toBe(false);
  expect(second!.querySelector('.tool-open-diff')?.getAttribute('aria-label')).toBe('Review this edit (1 of 2 files)');
});

it('does not offer a project diff shortcut in an unfiled chat', async () => {
  const edit = toolCall(2, 'edit-unfiled');
  if (edit.kind !== 'tool_call') throw new Error('Expected a tool call');
  edit.call.tool = 'apply_patch';
  edit.call.summary = { kind: 'edit', title: 'Edited src/main.ts', metric: '+1 −1', tone: 'good' };
  edit.call.changes = [{ path: '/repo/src/main.ts', added: 1, removed: 1, approximate: false, reviewAssetId: 'deadbeef.txt' }];
  const app = await boot([edit]);
  expect(app.w.document.querySelector('.tool-open-diff')).toBeNull();
});

it('starts in New Chat despite active history and selects only the exact acknowledged send', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'A new request';
  (w.document.getElementById('chatAutomation') as HTMLSelectElement).value = 'loop';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(live.sent[0]).toMatchObject({ sessionId: null, text: 'A new request', automation: 'loop', authoredSource: 'text' });
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id);
});

it('selects an acknowledged New Chat while recording notifications keep arriving', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  (w.document.getElementById('chatInput') as HTMLTextAreaElement).value = 'Streaming request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  const timer = setInterval(app.notifySession, 30);
  try {
    await vi.waitFor(() => expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(summary([]).id), { timeout: 2000 });
  } finally { clearInterval(timer); }
});

it.each(['composer', 'bubble'])('clears New Chat drafts and removes a delivery cancelled with %s', async (control) => {
  const app = await boot([], false, [], [], { reserveOpenings: true });
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'Old attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const owner = live.inputs[0]!.sessionId!;
  expect(w.document.querySelector('#sessionList .is-sel')?.getAttribute('data-id')).toBe(owner);
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  live.inputs[0] = { ...live.inputs[0]!, state: 'browser' };
  input.value = 'Discard this draft';
  w.document.getElementById('newChat')!.click();
  await app.append([]);
  expect(input.value).toBe('');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  expect(live.inputs[0]!.state).toBe('browser'); // Preserve ambiguous receipts; never retry them.
  (w.document.querySelector(`#sessionList [data-id="${owner}"]`) as HTMLButtonElement).click();
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Old attempt');
  input.value = ''; input.dispatchEvent(new w.Event('input'));
  const cancel = vi.fn(async (id: string) => { live.inputs = live.inputs.map(row => row.id === id ? { ...row, state: 'cancelled' as const, error: 'Not sent: this delivery was cancelled before Send was authorized.' } : row); return { ok: true, data: true }; });
  (w as any).api.cancelInput = cancel;
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).toBe('Cancel delivery');
  if (control === 'composer') w.document.getElementById('chatSend')!.click();
  else (w.document.querySelector('#inputQueue [title="Cancel delivery"]') as HTMLButtonElement).click();
  await settle();
  expect(cancel).toHaveBeenCalledWith(live.inputs[0]!.id);
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
  w.document.getElementById('newChat')!.click();
  input.value = 'Fresh attempt';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(w.document.getElementById('inputQueue')!.textContent).toContain('Fresh attempt');
  expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Old attempt');
});

it.each([false, true])('dismisses retired delivery errors in selected-chat=%s without resending', async selected => {
  const app = await boot([], selected, [], [], { reserveOpenings: true });
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  const submit = () => w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  input.value = 'Expired request'; submit(); await settle();
  const owner = live.inputs[0]!.sessionId!;
  live.inputs[0] = { ...live.inputs[0]!, state: 'cancelled', error: 'Delivery confirmation timed out. The message may already have reached ChatGPT.' };
  if (!selected) {
    w.document.getElementById('newChat')!.click();
    await app.append([]);
    expect(w.document.getElementById('inputQueue')!.textContent).not.toContain('Expired request');
    (w.document.querySelector(`#sessionList [data-id="${owner}"]`) as HTMLButtonElement).click();
  }
  await app.append([]);
  const queue = w.document.getElementById('inputQueue')!;
  expect(queue.textContent).toContain('Expired request');
  expect(queue.textContent).toContain('may already have reached ChatGPT');
  const retry = queue.querySelector<HTMLButtonElement>('[aria-label="Retry delivery"]')!;
  expect(retry.classList.contains('delivery-retry')).toBe(true);
  expect(retry.textContent).toBe('');
  expect(retry.querySelector('.ico.ph-arrow-clockwise')).not.toBeNull();
  expect(w.document.getElementById('chatSend')!.getAttribute('aria-label')).not.toBe('Cancel delivery');
  (queue.querySelector('[title="Dismiss delivery notice"]') as HTMLButtonElement).click();
  await app.append([]);
  expect(queue.textContent).not.toContain('Expired request');
  w.document.getElementById('newChat')!.click();
  input.value = 'Fresh request'; submit(); await settle();
  expect(live.sent.at(-1)).toMatchObject({ text: 'Fresh request' });
  expect(queue.textContent).not.toContain('Expired request');
});

it('does not steal a newer New Chat draft when an older queued send is acknowledged', async () => {
  const app = await boot([], false);
  const { w, live } = app;
  const input = w.document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = 'First request';
  w.document.getElementById('composer')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  w.document.getElementById('newChat')!.click();
  input.value = 'Newer unsent draft';
  live.inputs[0] = { ...live.inputs[0]!, state: 'sent', conversationId: 'chat-b', deliveredSessionId: summary([]).id };
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
  expect(input.value).toBe('Newer unsent draft');
  w.document.getElementById('newChat')!.click();
  input.value = '';
  await app.append([]);
  expect(w.document.querySelector('#sessionList .is-sel')).toBeNull();
});

it.each(['stopped', 'failed'] as const)('shows the exact summary turn %s instead of writing, then updates the same card on recovery', async outcome => {
  const [request, start, brief, end, handoff, resume] = compaction(2);
  const app = await boot([request!, start!, { ...brief!, final: false, state: 'streaming' } as SessionEvent]);
  const card = app.w.document.querySelector<HTMLDetailsElement>('details.compaction')!;
  const state = () => card.querySelector('summary .state')!.textContent;
  expect(state()).toBe('The provider is writing the summary…');
  await app.append([{ ...end!, outcome, detail: outcome === 'failed' ? 'Provider request limit' : undefined } as SessionEvent]);
  expect(state()).toBe(outcome === 'stopped' ? 'Summary generation stopped' : 'Summary generation failed — Provider request limit');
  expect(card.className).toContain('tone-bad');
  await app.append([{ ...handoff!, seq: 9, time: T0 + 9000 }]);
  expect(state()).toContain('Summary saved');
  expect(card.className).toContain('tone-wait');
  await app.append([{ ...resume!, seq: 10, time: T0 + 10000 }]);
  expect(app.w.document.querySelector('details.compaction')).toBe(card);
  expect(state()).toContain('New chat opened');
  expect(card.className).toContain('tone-good');
});

it('keeps a stopped empty summary truthful without adopting another turn or its completed outcome', async () => {
  const [request, start, , end] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'stopped' } as SessionEvent]);
  await app.append([
    { seq: 10, time: T0 + 10000, source: 'extension', kind: 'turn_start', turnId: 'other' },
    { seq: 11, time: T0 + 11000, source: 'extension', kind: 'turn_end', turnId: 'other', outcome: 'completed' }
  ]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toBe('Summary generation stopped');
});

it('a committed resume supersedes an older abandonment on the same compaction', async () => {
  const [request, start, , end, , resume] = compaction(2);
  const app = await boot([request!, start!, { ...end!, outcome: 'failed' } as SessionEvent,
    { seq: 8, time: T0 + 8000, source: 'app', kind: 'note', continuation: TOKEN, message: text('Compact & Resume abandoned — earlier failure') }]);
  await app.append([{ ...resume!, seq: 9, time: T0 + 9000 }]);
  expect(app.w.document.querySelector('details.compaction summary .state')!.textContent).toContain('New chat opened');
});

it('does not infer compaction failure from a later tool call while the handoff is being saved', async () => {
  const [request, start, brief, end] = compaction(2);
  const { w, append } = await boot([
    { seq: 1, time: T0, source: 'app', kind: 'session_start', conversationId: 'chat-a', title: 'Loop under test' },
    request!,
    start!,
    brief!,
    end!
  ]);
  const timeline = w.document.getElementById('timeline')!;
  const state = () => timeline.querySelector('details.compaction summary .state')!.textContent;
  // Still the newest thing recorded: the summary is written, the app is saving it.
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');

  // A late call does not settle the continuation transaction.
  await append([toolCall(9, 'call-late')]);
  expect(state()).toBe('Summary written — saving the handoff…');
  expect(timeline.querySelector('details.compaction')!.className).toContain('tone-wait');
});
