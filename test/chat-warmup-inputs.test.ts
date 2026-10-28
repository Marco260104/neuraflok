import { expect, it } from 'vitest';
import type { InputEntry } from '../backend/domains/sessions/input/input.js';
import type { SessionEvent } from '../contracts/session.js';
import {
  optimisticProjectInputEvents,
  optimisticWarmupEvents,
  projectAuthoredInputProgress,
  projectAuthoredInputs,
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
