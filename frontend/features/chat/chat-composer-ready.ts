import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { SessionEvent } from '../../../contracts/session.js';

const HANDSHAKE_ACK = /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/;

export type ComposerWarmupState =
  | { phase: 'opening'; generation?: number; priorTurnWorking?: boolean }
  | { phase: 'failed'; error: string; failedAt?: number; generation?: number; priorTurnWorking?: boolean };

export function visibleWarmupPhase(
  phase: 'opening' | 'failed' | null,
  hasPendingMessage: boolean
): 'opening' | 'failed' | null {
  return hasPendingMessage ? phase : null;
}

/** Keep a stale provider Stop from cancelling internal chat preparation or its retry. */
export function blocksStopForWarmup(
  warmup: ComposerWarmupState | null,
  events: readonly SessionEvent[] = [],
  turnId: string | null = null,
  generation?: number
): boolean {
  if (warmup?.phase === 'opening') return true;
  if (warmup?.phase !== 'failed') return false;
  if (generation !== undefined && warmup.generation !== undefined && warmup.generation !== generation) return false;
  if (warmup.failedAt === undefined || !turnId) return true;
  // A real provider event after preparation failed proves the user's turn is
  // live. Internal warmup events remain hidden and cannot expose Stop.
  return !events.some(event => event.turnId === turnId && event.time >= warmup.failedAt! &&
    event.internalWarmup !== true && (
      ['tool_call', 'page_tool', 'progress'].includes(event.kind) ||
      (event.kind === 'assistant_message' && event.final !== true && event.state !== 'final')
    ));
}

export function shouldSuppressWarmupActivity(
  warmup: { phase: 'opening' | 'failed'; priorTurnWorking?: boolean } | null,
  hasPendingMessage: boolean
): boolean {
  return (warmup?.phase === 'opening' || warmup?.phase === 'failed') &&
    !hasPendingMessage;
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

export function markComposerWarmupOpening(key: string, generation?: number, priorTurnWorking?: boolean): void {
  const existing = composerWarmups.get(key);
  const previousActivity = existing?.priorTurnWorking;
  composerWarmups.set(key, {
    phase: 'opening',
    ...(generation === undefined ? existing?.generation === undefined ? {} : { generation: existing.generation } : { generation }),
    ...(priorTurnWorking === undefined
      ? previousActivity === undefined ? {} : { priorTurnWorking: previousActivity }
      : { priorTurnWorking })
  });
}

export function markComposerWarmupFailed(key: string, error: string, generation?: number, failedAt = Date.now()): void {
  const existing = composerWarmups.get(key);
  composerWarmups.set(key, {
    phase: 'failed', error, failedAt,
    ...(generation === undefined ? existing?.generation === undefined ? {} : { generation: existing.generation } : { generation }),
    ...(existing?.priorTurnWorking === undefined ? {} : { priorTurnWorking: existing.priorTurnWorking })
  });
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

export function retrySelectedChatWarmup(): void {
  retryWarmup?.();
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

export function resetComposerWarmupForTests(): void {
  openingSessions.clear();
  unboundOpening = false;
  composerWarmups.clear();
  ensureWarmup = null;
  retryWarmup = null;
}
