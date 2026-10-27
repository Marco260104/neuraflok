import { expect, it } from 'vitest';
import { optimisticComposerSend, queuedFollowup } from '../contracts/input.js';
import { composerTurnNowLabel } from '../frontend/features/chat/chat-turn-now.js';

it('treats a rewritten auto send as a user bubble, not a follow-up task card', () => {
  const rewritten = {
    mode: 'after-turn',
    requestedMode: 'auto',
    sessionId: 'chat-old',
    afterTurn: true
  };
  expect(optimisticComposerSend(rewritten)).toBe(true);
  expect(queuedFollowup(rewritten)).toBe(true);
});

it('keeps an explicit after-turn task in the follow-up queue', () => {
  const task = { mode: 'after-turn', sessionId: 'chat-old', afterTurn: true };
  expect(optimisticComposerSend(task)).toBe(false);
  expect(queuedFollowup(task)).toBe(true);
});

it('shows Reading project while setup is queued, then Thinking after the offer', () => {
  expect(composerTurnNowLabel({ preparing: true, working: false, pending: true, hasProject: true })).toBe('Reading project…');
  expect(composerTurnNowLabel({ preparing: false, working: false, pending: true, hasProject: true })).toBe('Thinking…');
  expect(composerTurnNowLabel({ preparing: true, working: true, pending: true, hasProject: true })).toBe('Reading project…');
  expect(composerTurnNowLabel({ preparing: true, working: false, pending: true, hasProject: false })).toBe('Thinking…');
  expect(composerTurnNowLabel({ preparing: false, working: false, pending: false })).toBeNull();
});
