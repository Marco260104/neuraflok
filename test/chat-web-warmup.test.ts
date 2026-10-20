import { expect, it } from 'vitest';
import { isWarmupInput, webChatWarmupNeeded } from '../frontend/features/chat/chat-web-warmup.js';

it('does not auto-start hidden web warmup', () => {
  expect(webChatWarmupNeeded({
    apiExecutor: false, signedIn: true, newChatSelected: true, selectedId: null, pending: false, warmupInFlight: false
  })).toBe(false);
  expect(isWarmupInput({ warmup: true })).toBe(true);
  expect(isWarmupInput({})).toBe(false);
});
