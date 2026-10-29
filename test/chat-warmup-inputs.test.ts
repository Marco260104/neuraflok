import { expect, it } from 'vitest';
import type { InputEntry } from '../backend/domains/sessions/input/input.js';
import type { SessionEvent } from '../contracts/session.js';
import {
  optimisticProjectInputEvents,
  optimisticWarmupEvents,
  isInternallyDeferredAuthoredInput,
  projectAuthoredInputProgress,
  projectAuthoredInputs,
  selectedAuthoredInputPending,
  withoutInternalWarmupEvents,
  warmupDeferredProgress,
} from '../frontend/features/chat/chat-warmup-inputs.js';

const queued = {
  id: 'input-1',
  sessionId: 'chat-1',
  text: 'Continue the task from yesterday.',
  state: 'queued',
  createdAt: 100,
  warmupDeferred: { selectionGeneration: 4 },
} as unknown as InputEntry;

it('hides internal warmup failures and turn markers while retaining authored chat events', () => {
  const setup = { id: 'warmup-input', warmup: true } as unknown as InputEntry;
  const events: SessionEvent[] = [
    { seq: 1, time: 100, source: 'app', kind: 'turn_start', turnId: 'warmup-turn' },
    { seq: 2, time: 101, source: 'extension', kind: 'assistant_message', inputId: setup.id,
      turnId: 'warmup-turn', message: { text: 'NEURAFLOK_READY', chars: 14, truncated: false }, final: true },
    { seq: 3, time: 102, source: 'app', kind: 'chat_error', inputId: setup.id, turnId: 'warmup-turn',
      message: { text: 'Synthetic context check failed', chars: 30, truncated: false } },
    { seq: 4, time: 103, source: 'app', kind: 'turn_end', turnId: 'warmup-turn', outcome: 'failed' },
    { seq: 5, time: 200, source: 'app', kind: 'chat_error', inputId: 'authored-input',
      message: { text: 'Authored request failed', chars: 23, truncated: false } },
  ];

  expect(withoutInternalWarmupEvents(events, [setup])).toEqual([events[4]]);
  expect(withoutInternalWarmupEvents(events, [])).toEqual(events);
});

it('keeps failed internal warmup rows hidden after their outbox entry is gone', () => {
  const events = [
    { seq: 1, time: 100, source: 'app', kind: 'chat_error', inputId: 'expired-warmup',
      text: { text: 'Could not detect the provider chat.', chars: 35, truncated: false }, internalWarmup: true },
    { seq: 2, time: 101, source: 'app', kind: 'turn_end', turnId: 'expired-turn', outcome: 'failed', internalWarmup: true },
    { seq: 3, time: 102, source: 'app', kind: 'chat_error', inputId: 'user-input',
      text: { text: 'The user request failed.', chars: 24, truncated: false } },
  ] as unknown as SessionEvent[];

  expect(withoutInternalWarmupEvents(events, [])).toEqual([events[2]]);
});

it('hides unmarked activity and terminal events belonging to a marked warmup turn', () => {
  const authored: SessionEvent = { seq: 1, time: 10, source: 'app', kind: 'user_message',
    message: { text: 'Pregunta anterior', chars: 17, truncated: false } };
  const oldAnswer: SessionEvent = { seq: 2, time: 20, source: 'extension', kind: 'assistant_message', final: true,
    message: { text: 'Respuesta anterior', chars: 18, truncated: false } };
  const warmupStart: SessionEvent = { seq: 3, time: 30, source: 'extension', kind: 'turn_start',
    turnId: 'warmup-turn', internalWarmup: true };
  const warmupProgress: SessionEvent = { seq: 4, time: 31, source: 'extension', kind: 'progress',
    turnId: 'warmup-turn', message: { text: 'Checking context…', chars: 19, truncated: false } };
  const warmupEnd: SessionEvent = { seq: 5, time: 32, source: 'extension', kind: 'turn_end',
    turnId: 'warmup-turn', outcome: 'completed' };

  expect(withoutInternalWarmupEvents([authored, oldAnswer, warmupStart, warmupProgress, warmupEnd], []))
    .toEqual([authored, oldAnswer]);
});

it('keeps the authored question and its work when provider preparation shares the same turn', () => {
  const warmup: SessionEvent = { seq: 1, time: 10, source: 'app', kind: 'user_message', inputId: 'warmup-input',
    turnId: 'shared-turn', message: { text: 'NEURAFLOK_WARMUP', chars: 16, truncated: false } };
  const setupStart: SessionEvent = { seq: 2, time: 11, source: 'extension', kind: 'turn_start', turnId: 'shared-turn' };
  const setupProgress: SessionEvent = { seq: 3, time: 12, source: 'extension', kind: 'progress', turnId: 'shared-turn',
    message: { text: 'Preparing context', chars: 17, truncated: false } };
  const authored: SessionEvent = { seq: 4, time: 13, source: 'app', kind: 'user_message', inputId: 'authored-input',
    turnId: 'shared-turn', message: { text: 'Continue the project task', chars: 26, truncated: false } };
  const work: SessionEvent = { seq: 5, time: 14, source: 'extension', kind: 'page_tool', turnId: 'shared-turn',
    messageId: 'tool-1', label: 'Read project file' };

  expect(withoutInternalWarmupEvents([warmup, setupStart, setupProgress, authored, work], [
    { id: 'warmup-input', warmup: true } as unknown as InputEntry,
  ])).toEqual([authored, work]);
});

it('projects a warmup-delayed composer input into the transcript without a queue row', () => {
  const [message] = optimisticWarmupEvents([], [queued], 'chat-1', 4);
  expect(message).toMatchObject({
    kind: 'user_message',
    inputId: 'input-1',
    messageId: 'input:input-1',
    authoredText: queued.text,
    message: { text: queued.text },
  });
  expect(optimisticWarmupEvents([], [queued, queued], 'chat-1', 4)).toHaveLength(1);
  expect(optimisticWarmupEvents([], [{ ...queued, sessionId: null } as InputEntry], null, 5)).toEqual([]);
});

it('keeps project preparation invisible until the authored message is sent to the provider', () => {
  const [pendingMessage] = optimisticWarmupEvents([], [queued], 'chat-1', 4);
  expect(pendingMessage?.kind).toBe('user_message');
  expect(warmupDeferredProgress([queued], 'chat-1', 4, [])).toBeNull();
  expect(warmupDeferredProgress([queued], 'chat-1', 4, [], { showQueued: true })).toBe('thinking');

  const sent = { ...queued, state: 'sent' } as InputEntry;
  const [user] = optimisticWarmupEvents([], [sent], 'chat-1', 4);
  expect(warmupDeferredProgress([sent], 'chat-1', 4, [])).toBe('thinking');

  const answer = {
    seq: (user as Extract<SessionEvent, { kind: 'user_message' }>).seq + 1,
    time: 200,
    source: 'extension',
    kind: 'assistant_message',
    message: { text: 'I am continuing the task.', chars: 27, truncated: false },
    final: false,
  } satisfies SessionEvent;
  expect(warmupDeferredProgress([sent], 'chat-1', 4, [user!, answer])).toBeNull();
  expect(warmupDeferredProgress([sent, { ...queued, id: 'input-2', createdAt: 150 } as InputEntry],
    'chat-1', 4, [user!, answer])).toBeNull();
});

it('keeps warmup-deferred sends internal and shows work immediately for normal and project chats', () => {
  const normalDeferred = { ...queued, projectId: undefined } as InputEntry;
  const projectDeferred = { ...queued, projectId: 'project-1' } as InputEntry;
  const scheduledFollowup = { ...queued, warmupDeferred: undefined } as InputEntry;

  expect(isInternallyDeferredAuthoredInput(normalDeferred)).toBe(true);
  expect(isInternallyDeferredAuthoredInput(projectDeferred)).toBe(true);
  expect(isInternallyDeferredAuthoredInput(scheduledFollowup)).toBe(false);
  expect(isInternallyDeferredAuthoredInput({ ...queued, warmup: true } as InputEntry)).toBe(false);
  expect(warmupDeferredProgress([normalDeferred], 'chat-1', 4, [], { showQueued: true })).toBe('thinking');
  expect(warmupDeferredProgress([projectDeferred], 'chat-1', 4, [], { showQueued: true })).toBe('thinking');
});

it('isolates pending activity to the selected chat and clears it after a final answer', () => {
  const pending = { ...queued, warmupDeferred: undefined, authoredSource: 'text', state: 'sent' } as InputEntry;
  const user: SessionEvent = { seq: 1, time: 110, source: 'app', kind: 'user_message', inputId: pending.id,
    messageId: 'native-message-1', message: { text: pending.text, chars: pending.text.length, truncated: false } };
  const final: SessionEvent = { seq: 2, time: 120, source: 'extension', kind: 'assistant_message',
    message: { text: 'Done', chars: 4, truncated: false }, final: true };

  expect(selectedAuthoredInputPending([pending], 'chat-1', 4, null, [user])).toBe(true);
  // A stale queue row from chat-1 must not make chat-2 look active during navigation.
  expect(selectedAuthoredInputPending([pending], 'chat-2', 5, null, [user])).toBe(false);
  expect(selectedAuthoredInputPending([pending], 'chat-1', 4, null, [user, final])).toBe(false);
  expect(selectedAuthoredInputPending([pending], null, 6, { id: pending.id, generation: 4 }, [])).toBe(false);
});

it('clears stale thinking receipts when the provider transcript has no local input id', () => {
  const providerUser: SessionEvent = { seq: 20, time: 120, source: 'extension', kind: 'user_message',
    inputId: 'provider-input-id', messageId: 'provider-message-id',
    message: { text: queued.text, chars: queued.text.length, truncated: false } };
  const final: SessionEvent = { seq: 21, time: 130, source: 'extension', kind: 'assistant_message',
    message: { text: 'Continué la tarea.', chars: 18, truncated: false }, final: true };
  const staleDeferred = { ...queued, state: 'browser', offeredAt: 115 } as InputEntry;
  const staleProject = { ...staleDeferred, projectId: 'project-1', warmupDeferred: undefined,
    authoredSource: 'text' } as InputEntry;

  expect(selectedAuthoredInputPending([staleDeferred], 'chat-1', 4, null, [providerUser, final])).toBe(false);
  expect(warmupDeferredProgress([staleDeferred], 'chat-1', 4, [providerUser, final], { showQueued: true })).toBeNull();
  expect(projectAuthoredInputProgress([staleProject], 'chat-1', 'project-1', 4, null,
    [providerUser, final])).toBeNull();
});

it('does not present a scheduled follow-up as an active response', () => {
  const scheduled = { ...queued, warmupDeferred: undefined, mode: 'after-turn', state: 'queued' } as InputEntry;
  expect(selectedAuthoredInputPending([scheduled], 'chat-1', 4, null, [])).toBe(false);
});

it('reuses the optimistic timeline identity when the delivered history event arrives', () => {
  const canonical = {
    seq: 12,
    time: 101,
    source: 'app',
    kind: 'user_message',
    inputId: 'input-1',
    messageId: 'native-message-1',
    message: { text: queued.text, chars: queued.text.length, truncated: false },
  } satisfies SessionEvent;
  expect(optimisticWarmupEvents([canonical], [queued], 'chat-1', 4)).toEqual([]);
});

it('keeps a project composer send in its transcript while the delivery queue stays internal', () => {
  const projectId = '66666666-6666-4666-8666-666666666666';
  const pending = { ...queued, id: 'project-input', projectId, warmupDeferred: undefined, authoredSource: 'text' } as InputEntry;
  const rows = projectAuthoredInputs([pending], 'chat-1', projectId, 4, null);
  expect(rows).toEqual([pending]);
  expect(projectAuthoredInputs([pending], 'another-chat', projectId, 4, null)).toEqual([]);
  expect(projectAuthoredInputs([pending], null, projectId, 4, null)).toEqual([]);
  expect(projectAuthoredInputs([pending], 'chat-1', null, 4, null)).toEqual([]);

  const [message] = optimisticProjectInputEvents([], rows, 'chat-1', projectId, 4, null);
  expect(message).toMatchObject({ kind: 'user_message', inputId: pending.id, authoredText: pending.text,
    message: { text: pending.text } });
  expect(projectAuthoredInputProgress(rows, 'chat-1', projectId, 4, null, [])).toBe('thinking');

  const canonical: SessionEvent = { seq: 2, time: 200, source: 'app', kind: 'user_message',
    inputId: pending.id, messageId: 'native-project-message', message: { text: pending.text, chars: pending.text.length, truncated: false } };
  expect(optimisticProjectInputEvents([canonical], rows, 'chat-1', projectId, 4, null)).toEqual([]);
  expect(projectAuthoredInputProgress([pending], 'chat-1', projectId, 4, null, [canonical])).toBe('thinking');
  expect(projectAuthoredInputProgress([{ ...pending, state: 'cancelled' } as InputEntry], 'chat-1', projectId, 4, null, [])).toBeNull();
});

it('does not restore a completed, durably recorded project send as a duplicate or active reply', () => {
  const projectId = '77777777-7777-4777-8777-777777777777';
  const completed = {
    ...queued,
    id: 'completed-project-input',
    projectId,
    warmupDeferred: undefined,
    authoredSource: 'text',
    state: 'sent',
    deliveredAt: 100,
    historyRecorded: true,
    historyAnchored: true,
  } as InputEntry;

  expect(projectAuthoredInputs([completed], 'chat-1', projectId, 4, null, 200)).toEqual([]);
  expect(projectAuthoredInputs([completed], 'chat-1', projectId, 4, null)).toEqual([]);
  expect(optimisticProjectInputEvents([], [completed], 'chat-1', projectId, 4, null, 200)).toEqual([]);
  expect(projectAuthoredInputProgress([completed], 'chat-1', projectId, 4, null, [], 200)).toBeNull();
  expect(projectAuthoredInputProgress([completed], 'chat-1', projectId, 4, null, [])).toBeNull();
  expect(selectedAuthoredInputPending([completed], 'chat-1', 4, null, [])).toBe(false);

  const active = { ...completed, historyAnchored: false, deliveredAt: 300 };
  expect(projectAuthoredInputs([active], 'chat-1', projectId, 4, null, 200)).toEqual([active]);
  expect(projectAuthoredInputProgress([active], 'chat-1', projectId, 4, null, [], 200)).toBe('thinking');
});

it('settles an old normal-chat send from its durable receipt when a history page omits its user row', () => {
  const completed = {
    ...queued,
    warmupDeferred: undefined,
    authoredSource: 'text',
    state: 'sent',
    deliveredAt: 100,
    historyRecorded: true,
  } as InputEntry;
  expect(selectedAuthoredInputPending([completed], 'chat-1', 4, null, [], Date.now(), 200)).toBe(false);
  expect(selectedAuthoredInputPending([{ ...completed, deliveredAt: 300 } as InputEntry], 'chat-1', 4, null, [], Date.now(), 200)).toBe(true);
});
