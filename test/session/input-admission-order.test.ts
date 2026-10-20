import { expect, it } from 'vitest';
import type { InputEntry } from '../../backend/domains/sessions/input/input.js';
import { ordered } from '../../backend/domains/sessions/input/input-admission.js';

function queued(id: string, sessionId: string, dueAt: number, warmup = false): InputEntry {
  return { id, sessionId, dueAt, createdAt: dueAt, state: 'queued', warmup } as InputEntry;
}

it('puts chat preparation ahead of older queued messages in the same chat', () => {
  const rows = [
    queued('old-request', 'chat-a', 10),
    queued('other-chat-request', 'chat-b', 20),
    queued('prepare-chat', 'chat-a', 30, true)
  ];

  expect(ordered(rows).map(row => row.id)).toEqual([
    'prepare-chat', 'old-request', 'other-chat-request'
  ]);
});

it('does not reorder a readiness message once provider delivery has started', () => {
  const sentWarmup = { ...queued('prepare-chat', 'chat-a', 30, true), state: 'sent' } as InputEntry;
  const rows = [queued('old-request', 'chat-a', 10), sentWarmup];

  expect(ordered(rows).map(row => row.id)).toEqual(['old-request', 'prepare-chat']);
});
