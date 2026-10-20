import { expect, it } from 'vitest';
import {
  adoptOpeningSession,
  composerReadyPhase,
  composerSendBlocked,
  hasHandshakeAck,
  hasPublicAssistantReply,
  isHandshakeAck,
  openingInputInFlight,
  resetComposerReadyGateForTests,
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

it('blocks sending until the web model is signed in', () => {
  expect(composerReadyPhase({ apiExecutor: false, signedIn: null })).toBe('models');
  expect(composerReadyPhase({ apiExecutor: false, signedIn: false })).toBe('signin');
  expect(composerSendBlocked('models', false)).toBe(true);
  expect(composerSendBlocked('signin', false)).toBe(true);
});

it('unlocks a signed-in web chat without waiting for the handshake', () => {
  expect(composerReadyPhase({ apiExecutor: false, signedIn: true })).toBe('ready');
  expect(composerSendBlocked('ready', false)).toBe(false);
  expect(composerSendBlocked('opening', false)).toBe(false);
  expect(composerSendBlocked('opening', true)).toBe(false);
});

it('leaves API chats ready before the first send', () => {
  expect(composerReadyPhase({ apiExecutor: true, signedIn: null })).toBe('ready');
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
  resetComposerReadyGateForTests();
  adoptOpeningSession('chat-2');
  expect(trackedOpening('chat-2')).toBe(true);
  expect(composerReadyPhase({ apiExecutor: false, signedIn: true })).toBe('ready');
});
