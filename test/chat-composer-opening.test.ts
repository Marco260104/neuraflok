import { expect, it, vi } from 'vitest';
import type { InputEntry } from '../backend/domains/sessions/input/input.js';
import { waitForPendingOpeningSession } from '../frontend/features/chat/chat-composer-delivery.js';

it('waits for a new chat session to be adopted before delivering a second message', async () => {
  const openingId = 'opening-session';
  const accepted = { id: openingId, opening: true } as InputEntry;
  let selectedId: string | null = null;
  let selectionGeneration = 4;
  let pendingNewInput: { id: string; generation: number } | null = { id: openingId, generation: selectionGeneration };
  const runtime = {
    api: { listInputs: vi.fn(async () => ({ ok: true, data: [accepted] })) },
    get pendingNewInput() { return pendingNewInput; },
    get selectionGeneration() { return selectionGeneration; },
    get selectedId() { return selectedId; },
    adoptAcceptedOpening: vi.fn(async (entry: InputEntry) => {
      if (entry.id !== openingId) return false;
      selectedId = openingId;
      selectionGeneration++;
      pendingNewInput = null;
      return true;
    })
  } as unknown as Parameters<typeof waitForPendingOpeningSession>[0];

  await expect(waitForPendingOpeningSession(runtime)).resolves.toBe(true);
  expect(selectedId).toBe(openingId);
  expect(runtime.adoptAcceptedOpening).toHaveBeenCalledWith(accepted);
});
