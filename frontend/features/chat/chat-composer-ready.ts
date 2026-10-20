import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { SessionEvent } from '../../../contracts/session.js';
import { t, ui } from '../../shared/i18n.js';

const HANDSHAKE_ACK = /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/;

export type ComposerReadyPhase = 'models' | 'signin' | 'opening' | 'ready';

export interface ComposerReadyInput {
  apiExecutor: boolean;
  signedIn: boolean | null | undefined;
  pendingNewInput: boolean;
  openingInFlight: boolean;
  trackedOpening: boolean;
  hasAssistantReply: boolean;
}

const openingSessions = new Set<string>();
let unboundOpening = false;

export function markUnboundOpening(): void {
  unboundOpening = true;
}

export function adoptOpeningSession(sessionId: string): void {
  unboundOpening = false;
  openingSessions.add(sessionId);
}

export function noteOpeningSession(sessionId: string): void {
  openingSessions.add(sessionId);
}

export function releaseOpeningSession(sessionId: string | null): void {
  if (sessionId) openingSessions.delete(sessionId);
}

export function trackedOpening(sessionId: string | null): boolean {
  return (unboundOpening && sessionId === null) || (!!sessionId && openingSessions.has(sessionId));
}

export function isHandshakeAck(text: string | null | undefined): boolean {
  return HANDSHAKE_ACK.test(String(text || '').trim());
}

export function hasPublicAssistantReply(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.kind === 'assistant_message' && !isHandshakeAck(event.message.text));
}

export function openingInputInFlight(
  selectedId: string | null,
  conversationId: string | null,
  pendingNewInput: boolean,
  rows: readonly Pick<InputEntry, 'sessionId' | 'deliveredSessionId' | 'state' | 'opening' | 'purpose'>[]
): boolean {
  return rows.some(row => {
    if (row.purpose === 'decision') return false;
    if (!['queued', 'browser', 'sent'].includes(row.state)) return false;
    const owner = row.sessionId ?? row.deliveredSessionId ?? null;
    if (pendingNewInput && (owner === null || owner === selectedId)) return true;
    if (selectedId === null || owner !== selectedId) return false;
    return row.opening === true || !conversationId;
  });
}

export function composerReadyPhase(input: ComposerReadyInput): ComposerReadyPhase {
  if (!input.apiExecutor && input.signedIn !== true) {
    return input.signedIn === false ? 'signin' : 'models';
  }
  if (input.pendingNewInput || input.trackedOpening || (input.openingInFlight && !input.hasAssistantReply)) {
    return input.hasAssistantReply ? 'ready' : 'opening';
  }
  return 'ready';
}

export function composerSendBlocked(phase: ComposerReadyPhase, stopAction: boolean): boolean {
  return phase !== 'ready' && !stopAction;
}

export function composerReadyLabel(phase: ComposerReadyPhase): string {
  if (phase === 'models') return t('Loading web models');
  if (phase === 'signin') return t('Sign in required');
  if (phase === 'opening') return t('Preparing chat…');
  return t('Ready');
}

export function composerReadyDetail(phase: ComposerReadyPhase): string {
  if (phase === 'opening') return t('Reading the project and connecting the model…');
  if (phase === 'ready') return t('Chat is ready.');
  return '';
}

let readyFlash: number | null = null;
let lastPhase: ComposerReadyPhase | null = null;

export function paintComposerReadyGate(phase: ComposerReadyPhase): void {
  const gate = document.getElementById('composerReadyGate');
  const label = document.getElementById('composerReadyLabel');
  const detail = document.getElementById('composerReadyDetail');
  const composer = document.getElementById('composer');
  if (!gate || !label) return;
  if (phase === 'opening') {
    if (readyFlash !== null) {
      window.clearTimeout(readyFlash);
      readyFlash = null;
    }
    gate.hidden = false;
    gate.dataset.tone = 'wait';
    composer?.classList.add('is-waiting');
  } else if (phase === 'ready' && lastPhase === 'opening') {
    gate.hidden = false;
    gate.dataset.tone = 'ready';
    composer?.classList.remove('is-waiting');
    if (readyFlash !== null) window.clearTimeout(readyFlash);
    readyFlash = window.setTimeout(() => {
      readyFlash = null;
      gate.hidden = true;
    }, 900);
  } else if (readyFlash === null) {
    gate.hidden = true;
    composer?.classList.remove('is-waiting');
  }
  const display: ComposerReadyPhase = gate.dataset.tone === 'ready' && !gate.hidden ? 'ready'
    : phase === 'opening' ? 'opening' : phase;
  ui(label, 'textContent', () => composerReadyLabel(display));
  if (detail) ui(detail, 'textContent', () => composerReadyDetail(display));
  const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
  if (input) input.readOnly = phase === 'models' || phase === 'signin';
  lastPhase = phase;
}

export function resetComposerReadyGateForTests(): void {
  if (readyFlash !== null) window.clearTimeout(readyFlash);
  readyFlash = null;
  lastPhase = null;
  openingSessions.clear();
  unboundOpening = false;
}
