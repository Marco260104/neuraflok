import { expect, it } from 'vitest';
import {
  adoptOpeningSession,
  composerWarmupKey,
  composerWarmupState,
  markComposerWarmupFailed,
  markComposerWarmupOpening,
  hasHandshakeAck,
  hasPublicAssistantReply,
  isHandshakeAck,
  openingInputInFlight,
  resetComposerWarmupForTests,
  trackedOpening
} from '../frontend/features/chat/chat-composer-ready.js';
import type { SessionEvent } from '../contracts/session.js';

it('treats handshake acknowledgements as setup, not as a public reply', () => {
  expect(isHandshakeAck('NEURAFLOK_READY')).toBe(true);
  expect(isHandshakeAck('NEURAL_JAM_READY')).toBe(true);
  expect(isHandshakeAck('The files are listed.')).toBe(false);
  const ack = { kind: 'assistant_message', message: { text: 'NEURAFLOK_READY' } } as SessionEvent;
  const reply = { kind: 'assistant_message', message: { text: 'Listed the project files.' } } as SessionEvent;
  expect(hasPublicAssistantReply([ack])).toBe(false);
  expect(hasPublicAssistantReply([ack, reply])).toBe(true);
});

it('tracks project preparation separately from the composer input', () => {
  resetComposerWarmupForTests();
  const key = composerWarmupKey('chat-1', 3);
  markComposerWarmupOpening(key, 3);
  expect(composerWarmupState(key)).toEqual({ phase: 'opening', generation: 3 });
  markComposerWarmupFailed(key, 'provider timed out', 3);
  const failed = composerWarmupState(key);
  expect(failed).toMatchObject({ phase: 'failed', error: 'provider timed out', generation: 3 });
  expect(failed?.phase === 'failed' ? failed.failedAt : undefined).toEqual(expect.any(Number));
  resetComposerWarmupForTests();
});

it('detects handshake acknowledgements without treating them as a public reply', () => {
  const ack = { kind: 'assistant_message', message: { text: 'NEURAFLOK_READY' } } as SessionEvent;
  const reply = { kind: 'assistant_message', message: { text: 'Listed the project files.' } } as SessionEvent;
  expect(hasHandshakeAck([ack])).toBe(true);
  expect(hasHandshakeAck([reply])).toBe(false);
});

it('treats an opening outbox row as in-flight until the session has a public reply', () => {
  expect(openingInputInFlight(null, null, true, [{
    sessionId: null, deliveredSessionId: null, state: 'queued', opening: true, purpose: undefined
  }])).toBe(true);
  expect(openingInputInFlight('chat-1', null, false, [{
    sessionId: 'chat-1', deliveredSessionId: 'chat-1', state: 'browser', opening: true, purpose: undefined
  }])).toBe(true);
  expect(openingInputInFlight('chat-1', 'ds-11111111-1111-4111-8111-111111111111', false, [{
    sessionId: 'chat-1', deliveredSessionId: 'chat-1', state: 'queued', purpose: undefined
  }])).toBe(false);
});

it('keeps tracking an adopted opening without locking the composer', () => {
  resetComposerWarmupForTests();
  adoptOpeningSession('chat-2');
  expect(trackedOpening('chat-2')).toBe(true);
});
