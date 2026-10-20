import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { SessionEvent } from '../../../contracts/session.js';
import { t, ui } from '../../shared/i18n.js';

const HANDSHAKE_ACK = /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/;

export type ComposerReadyPhase = 'models' | 'signin' | 'opening' | 'failed' | 'ready';
export type ComposerWarmupState = { phase: 'opening' } | { phase: 'failed'; error: string };

export interface ComposerReadyInput {
  apiExecutor: boolean;
  signedIn: boolean | null | undefined;
  opening?: boolean;
  failed?: boolean;
}

const openingSessions = new Set<string>();
const composerWarmups = new Map<string, ComposerWarmupState>();
let unboundOpening = false;
let ensureWarmup: (() => void) | null = null;
let retryWarmup: (() => void) | null = null;

export function composerWarmupKey(selectedId: string | null, generation: number): string {
  return selectedId ?? `new:${generation}`;
}

export function composerWarmupState(key: string): ComposerWarmupState | null {
  return composerWarmups.get(key) ?? null;
}

export function markComposerWarmupOpening(key: string): void {
  composerWarmups.set(key, { phase: 'opening' });
}

export function markComposerWarmupFailed(key: string, error: string): void {
  composerWarmups.set(key, { phase: 'failed', error });
}

export function clearComposerWarmup(key: string): void {
  composerWarmups.delete(key);
}

export function setComposerWarmupHandlers(handlers: { ensure: () => void; retry: () => void }): void {
  ensureWarmup = handlers.ensure;
  retryWarmup = handlers.retry;
}

export function ensureSelectedChatWarmup(): void {
  ensureWarmup?.();
}

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
  else unboundOpening = false;
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

export function hasHandshakeAck(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.kind === 'assistant_message' && isHandshakeAck(event.message.text));
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
  if (input.apiExecutor) return 'ready';
  if (input.signedIn !== true) return input.signedIn === false ? 'signin' : 'models';
  if (input.failed) return 'failed';
  return input.opening ? 'opening' : 'ready';
}

export function composerSendBlocked(phase: ComposerReadyPhase, stopAction: boolean): boolean {
  return phase === 'opening' || phase === 'failed' || (phase !== 'ready' && !stopAction);
}

export function composerReadyLabel(phase: ComposerReadyPhase): string {
  if (phase === 'models') return t('Loading web models');
  if (phase === 'signin') return t('Sign in required');
  if (phase === 'opening') return t('Preparing chat…');
  if (phase === 'failed') return t('Chat context not verified');
  return t('Ready');
}

export function composerReadyDetail(phase: ComposerReadyPhase, error?: string): string {
  if (phase === 'opening') return t('Reading the project and connecting the model…');
  if (phase === 'failed') {
    const reason = error?.trim().slice(0, 300);
    return reason
      ? `${t('DeepSeek could not confirm this chat context. Retry before sending.')} ${reason}`
      : t('DeepSeek could not confirm this chat context. Retry before sending.');
  }
  if (phase === 'ready') return t('Chat is ready.');
  return '';
}

let readyFlash: number | null = null;
let lastPhase: ComposerReadyPhase | null = null;

export function paintComposerReadyGate(phase: ComposerReadyPhase, error?: string): void {
  const gate = document.getElementById('composerReadyGate');
  const label = document.getElementById('composerReadyLabel');
  const detail = document.getElementById('composerReadyDetail');
  const retry = document.getElementById('composerReadyRetry') as HTMLButtonElement | null;
  const composer = document.getElementById('composer');
  if (!gate || !label) return;
  if (retry && retry.dataset.wired !== 'true') {
    retry.addEventListener('click', () => retryWarmup?.());
    retry.dataset.wired = 'true';
  }
  if (phase === 'opening') {
    if (readyFlash !== null) {
      window.clearTimeout(readyFlash);
      readyFlash = null;
    }
    gate.hidden = false;
    gate.dataset.tone = 'wait';
    composer?.classList.add('is-waiting');
  } else if (phase === 'failed') {
    if (readyFlash !== null) {
      window.clearTimeout(readyFlash);
      readyFlash = null;
    }
    gate.hidden = false;
    gate.dataset.tone = 'error';
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
    : gate.dataset.tone === 'error' && !gate.hidden ? 'failed'
    : phase === 'opening' ? 'opening' : phase;
  ui(label, 'textContent', () => composerReadyLabel(display));
  if (detail) ui(detail, 'textContent', () => composerReadyDetail(display, error));
  if (retry) {
    retry.hidden = display !== 'failed';
    ui(retry, 'textContent', () => t('Retry'));
  }
  const input = document.getElementById('chatInput') as HTMLTextAreaElement | null;
  if (input) input.readOnly = phase === 'models' || phase === 'signin' || phase === 'opening' || phase === 'failed';
  lastPhase = phase;
}

export function resetComposerReadyGateForTests(): void {
  if (readyFlash !== null) window.clearTimeout(readyFlash);
  readyFlash = null;
  lastPhase = null;
  openingSessions.clear();
  unboundOpening = false;
  composerWarmups.clear();
  ensureWarmup = null;
  retryWarmup = null;
}
