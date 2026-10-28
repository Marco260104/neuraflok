import { expect, it } from 'vitest';
import type { SessionEvent } from '../contracts/session.js';
import { chatSelectionStartedAt, hasRecentTurnActivity, recordChatSelection } from '../frontend/features/chat/chat-turn-state.js';

const selectedAt = 50_000;
const now = selectedAt + 2_000;

function event(kind: SessionEvent['kind'], time: number, turnId = 'turn-1'): SessionEvent {
  return { kind, seq: time, time, turnId } as SessionEvent;
}

it('does not show Stop from a recent turn start restored with an old chat', () => {
  expect(hasRecentTurnActivity(
    [event('turn_start', now - 500)], 'turn-1', selectedAt, now,
  )).toBe(false);
});

it('keeps Stop available for a live tool call while switching chats', () => {
  expect(hasRecentTurnActivity(
    [event('tool_call', selectedAt - 1)], 'turn-1', selectedAt, now,
  )).toBe(true);
});

it('shows Stop when a new question starts a turn after opening the selected chat', () => {
  const question = { ...event('user_message', selectedAt + 1), message: { text: 'A new question', truncated: false } } as SessionEvent;
  expect(hasRecentTurnActivity(
    [question, event('turn_start', selectedAt + 2)], 'turn-1', selectedAt, now,
  )).toBe(true);
});

it('keeps Stop available when a partial answer is actively progressing across navigation', () => {
  const partial = { ...event('assistant_message', selectedAt - 1), final: false, state: 'streaming' } as SessionEvent;
  expect(hasRecentTurnActivity(
    [partial], 'turn-1', selectedAt, now,
  )).toBe(true);
});

it('uses the navigation timestamp for exactly the selected chat and generation', () => {
  recordChatSelection('chat-a', 7, selectedAt);
  expect(chatSelectionStartedAt('chat-a', 7)).toBe(selectedAt);
  expect(chatSelectionStartedAt('chat-b', 7)).toBeNull();
  expect(chatSelectionStartedAt('chat-a', 8)).toBeNull();
});

it('keeps the initial active chat cancellable from its current turn start', () => {
  expect(hasRecentTurnActivity(
    [event('turn_start', now - 500)], 'turn-1', null, now,
  )).toBe(true);
});

it('shows Stop after the selected chat reports fresh, nonterminal work for its active turn', () => {
  expect(hasRecentTurnActivity(
    [event('page_tool', selectedAt + 1)], 'turn-1', selectedAt, now,
  )).toBe(true);
});

it('ignores final answers and activity older than the existing freshness window', () => {
  const final = { ...event('assistant_message', selectedAt + 1), final: true } as SessionEvent;
  expect(hasRecentTurnActivity([final], 'turn-1', selectedAt, now)).toBe(false);
  expect(hasRecentTurnActivity(
    [event('tool_call', now - 10_000)], 'turn-1', selectedAt, now,
  )).toBe(false);
});
