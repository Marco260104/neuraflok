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
  expect(composerReadyPhase({
    apiExecutor: false, signedIn: null, newChatSelected: false, pendingNewInput: false, openingInFlight: false, trackedOpening: false, hasHandshakeAck: false
  })).toBe('models');
  expect(composerReadyPhase({
    apiExecutor: false, signedIn: false, newChatSelected: false, pendingNewInput: false, openingInFlight: false, trackedOpening: false, hasHandshakeAck: false
  })).toBe('signin');
  expect(composerSendBlocked('models', false)).toBe(true);
  expect(composerSendBlocked('signin', false)).toBe(true);
});

it('blocks sending on a new chat until the handshake acknowledgement arrives', () => {
  expect(composerReadyPhase({
    apiExecutor: false, signedIn: true, newChatSelected: true, pendingNewInput: true, openingInFlight: false, trackedOpening: true, hasHandshakeAck: false
  })).toBe('opening');
  expect(composerReadyPhase({
    apiExecutor: false, signedIn: true, newChatSelected: false, pendingNewInput: false, openingInFlight: false, trackedOpening: true, hasHandshakeAck: false
  })).toBe('opening');
  expect(composerReadyPhase({
    apiExecutor: false, signedIn: true, newChatSelected: false, pendingNewInput: false, openingInFlight: false, trackedOpening: true, hasHandshakeAck: true
  })).toBe('ready');
  expect(composerSendBlocked('opening', false)).toBe(true);
  expect(composerSendBlocked('opening', true)).toBe(false);
  expect(composerSendBlocked('ready', false)).toBe(false);
});

it('leaves API chats ready before the first send', () => {
  expect(composerReadyPhase({
    apiExecutor: true, signedIn: null, newChatSelected: true, pendingNewInput: false, openingInFlight: false, trackedOpening: false, hasHandshakeAck: false
  })).toBe('ready');
});

it('treats handshake acknowledgements as the ready signal for a new web chat', () => {
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

it('keeps a new session locked after the outbox row is adopted', () => {
  resetComposerReadyGateForTests();
  adoptOpeningSession('chat-2');
  expect(trackedOpening('chat-2')).toBe(true);
  expect(composerReadyPhase({
    apiExecutor: false, signedIn: true, newChatSelected: false, pendingNewInput: false, openingInFlight: false, trackedOpening: true, hasHandshakeAck: false
  })).toBe('opening');
});
