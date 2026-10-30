import { expect, it } from 'vitest';
import type { InputEntry } from '../backend/domains/sessions/input/input.js';
import { visibleStartingComposerInputs } from '../frontend/features/chat/chat-input-queue.js';
import { visibleStartingQueuedInputs } from '../frontend/features/chat/queued-task-list.js';

it('keeps internal warmup requests out of the visible composer queue', () => {
  const authored = { id: 'authored', warmup: false } as unknown as InputEntry;
  const warmup = { id: 'warmup', warmup: true } as unknown as InputEntry;
  const deferred = { id: 'deferred', warmupDeferred: { selectionGeneration: 1 } } as unknown as InputEntry;

  expect(visibleStartingComposerInputs(
    [warmup, deferred, authored],
    () => true,
    new Set(),
  )).toEqual([authored]);
});

it('shows active-turn follow-ups in the queue instead of as sent composer messages', () => {
  const queued = {
    id: 'queued-followup', sessionId: 'session-1', mode: 'after-turn', state: 'queued',
    dueAt: 0, warmup: false, text: 'Follow-up'
  } as unknown as InputEntry;

  expect(visibleStartingComposerInputs([queued], () => true, new Set())).toEqual([]);
  expect(visibleStartingQueuedInputs([queued], new Set(), () => true)).toEqual([queued]);
  expect(visibleStartingQueuedInputs([queued], new Set([queued.id]), () => true)).toEqual([]);
});
