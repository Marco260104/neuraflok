import { expect, it } from 'vitest';
import type { InputEntry } from '../backend/domains/sessions/input/input.js';
import { visibleStartingComposerInputs } from '../frontend/features/chat/chat-input-queue.js';

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
