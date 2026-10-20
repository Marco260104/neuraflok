import { expect, it } from 'vitest';
import { isWarmupInput, webChatWarmupNeeded } from '../frontend/features/chat/chat-web-warmup.js';

it('starts hidden web warmup only on a signed-in new chat', () => {
  expect(webChatWarmupNeeded({
    apiExecutor: false, signedIn: true, newChatSelected: true, selectedId: null, pending: false, warmupInFlight: false
  })).toBe(true);
  expect(webChatWarmupNeeded({
    apiExecutor: true, signedIn: true, newChatSelected: true, selectedId: null, pending: false, warmupInFlight: false
  })).toBe(false);
  expect(webChatWarmupNeeded({
    apiExecutor: false, signedIn: false, newChatSelected: true, selectedId: null, pending: false, warmupInFlight: false
  })).toBe(false);
  expect(webChatWarmupNeeded({
    apiExecutor: false, signedIn: true, newChatSelected: false, selectedId: 'chat-1', pending: false, warmupInFlight: false
  })).toBe(false);
  expect(webChatWarmupNeeded({
    apiExecutor: false, signedIn: true, newChatSelected: true, selectedId: null, pending: true, warmupInFlight: false
  })).toBe(false);
  expect(isWarmupInput({ warmup: true })).toBe(true);
  expect(isWarmupInput({})).toBe(false);
});
