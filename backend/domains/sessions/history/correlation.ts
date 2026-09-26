import { readDurable, writeDurableNow, writeDurableSnapshotSoon } from '../../../persistence/durable.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import { indexedSessions, readRecentEvents } from './store.js';
import { attachRequestPlan, reconcileRequestPlans } from '../input/request-plans/service.js';
import { reconcileAgentRequestOwners } from '../../automation/agents.js';

export interface RequestCorrelation {
  requestId: string;
  conversationId: string;
  sessionId: string;
  messageId: string;
  tool: string;
  observedAt: number;
}

type CorrelationResult = 'stored' | 'same' | 'refused';
type RequestListener = (owner: RequestCorrelation) => void;

const STATE_KEY = 'request-correlations';
const STATE_VERSION = 6;
const MAX_OWNERS = 50_000;
const MAX_WAIT_STARTS = 2_000;
const owners = new Map<string, RequestCorrelation>();
const pending = new Map<string, Set<() => void>>();
const waitStarts = new Map<string, number>();
var listeners: Set<RequestListener> | undefined;
let restored = false;
let restoreFlight: Promise<void> | null = null;

interface SavedState {
  version: number;
  complete?: boolean;
  entries: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCorrelation(value: unknown): value is RequestCorrelation {
  if (!isRecord(value)) return false;
  return typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 200 &&
    typeof value.conversationId === 'string' && value.conversationId.length > 0 && value.conversationId.length <= 200 &&
    typeof value.sessionId === 'string' && /^[0-9a-z-]{8,64}$/i.test(value.sessionId) &&
    typeof value.messageId === 'string' && value.messageId.length > 0 && value.messageId.length <= 300 &&
    typeof value.tool === 'string' && value.tool.length <= 100 &&
    typeof value.observedAt === 'number' && Number.isFinite(value.observedAt);
}

function savedOwner(value: unknown): RequestCorrelation | null {
  if (!isRecord(value)) return null;
  const candidate = 'value' in value ? value.value : value;
  return isCorrelation(candidate) ? { ...candidate } : null;
}

function wake(requestId: string): void {
  const callbacks = pending.get(requestId);
  if (!callbacks) return;
  pending.delete(requestId);
  for (const callback of callbacks) callback();
}

function limitOwners(): void {
  while (owners.size > MAX_OWNERS) {
    const oldest = owners.keys().next().value as string | undefined;
    if (!oldest) return;
    owners.delete(oldest);
    wake(oldest);
  }
}

function snapshot(): SavedState {
  return { version: STATE_VERSION, complete: true, entries: [...owners.values()].map(owner => ({ ...owner })) };
}

function persistSoon(): void {
  writeDurableSnapshotSoon(STATE_KEY, snapshot);
}

function mergeOwner(input: RequestCorrelation): CorrelationResult {
  if (!isCorrelation(input)) return 'refused';
  const current = owners.get(input.requestId);
  if (!current) {
    owners.set(input.requestId, { ...input });
    waitStarts.delete(input.requestId);
    limitOwners();
    wake(input.requestId);
    return 'stored';
  }
  if (current.conversationId !== input.conversationId) return 'refused';
  if (input.observedAt > current.observedAt) {
    owners.delete(input.requestId);
    owners.set(input.requestId, { ...current, observedAt: input.observedAt });
  }
  return 'same';
}

function publish(owner: RequestCorrelation): void {
  for (const listener of listeners ?? []) {
    try {
      listener({ ...owner });
    } catch (error) {
      logWarn(`request correlation listener failed for ${owner.requestId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function onRequestCorrelation(listener: RequestListener): () => void {
  (listeners ??= new Set()).add(listener);
  return () => { listeners?.delete(listener); };
}

export function requestCorrelation(requestId: string | null | undefined): RequestCorrelation | null {
  if (!requestId) return null;
  const owner = owners.get(requestId);
  return owner ? { ...owner } : null;
}

export function observeRequestCorrelation(input: RequestCorrelation): CorrelationResult {
  return observeRequestCorrelations([input])[0]!;
}

export function observeRequestCorrelations(inputs: readonly RequestCorrelation[]): CorrelationResult[] {
  const changed = new Set<string>();
  const newlyOwned = new Set<string>();
  const results = inputs.map(input => {
    const previous = owners.get(input.requestId);
    const result = mergeOwner(input);
    if (result === 'stored') {
      changed.add(input.requestId);
      newlyOwned.add(input.requestId);
    } else if (result === 'same' && previous && input.observedAt > previous.observedAt) {
      changed.add(input.requestId);
    }
    return result;
  });
  if (changed.size) persistSoon();
  const touched = new Set<string>();
  for (let index = 0; index < inputs.length; index++) {
    if (results[index] !== 'refused') touched.add(inputs[index]!.requestId);
  }
  for (const requestId of touched) {
    const owner = owners.get(requestId);
    if (!owner) continue;
    if (newlyOwned.has(requestId)) publish(owner);
    void attachRequestPlan({ ...owner }).catch(error => {
      logWarn(`request plan attachment failed for ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (touched.size) void reconcileAgentRequestOwners().catch(error => {
    logWarn(`request worker ownership reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return results;
}

export async function awaitRequestCorrelation(
  requestId: string | null | undefined,
  timeoutMs: number
): Promise<RequestCorrelation | null> {
  if (!requestId) return null;
  const current = requestCorrelation(requestId);
  if (current || timeoutMs <= 0) return current;
  const now = performance.now();
  const startedAt = waitStarts.get(requestId) ?? now;
  if (!waitStarts.has(requestId)) {
    waitStarts.set(requestId, startedAt);
    if (waitStarts.size > MAX_WAIT_STARTS) waitStarts.delete(waitStarts.keys().next().value!);
  }
  const remainingMs = timeoutMs - (now - startedAt);
  if (remainingMs <= 0) return null;
  await new Promise<void>(resolve => {
    const callbacks = pending.get(requestId) ?? new Set<() => void>();
    let timer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timer);
      callbacks.delete(finish);
      if (callbacks.size === 0) pending.delete(requestId);
      resolve();
    };
    callbacks.add(finish);
    pending.set(requestId, callbacks);
    timer = setTimeout(finish, remainingMs);
    timer.unref?.();
  });
  return requestCorrelation(requestId);
}

export async function restoreRequestCorrelations(): Promise<void> {
  if (restored) return;
  if (restoreFlight) return restoreFlight;
  const flight = (async () => {
    await restoreFromDisk();
    await reconcileRequestPlans(requestCorrelation).catch(error => {
      logWarn(`request plan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    restored = true;
  })();
  restoreFlight = flight;
  try {
    await flight;
  } finally {
    if (restoreFlight === flight) restoreFlight = null;
  }
}

async function restoreFromDisk(): Promise<void> {
  const saved = await readDurable<unknown>(STATE_KEY);
  const data = isRecord(saved) ? saved as Partial<SavedState> : null;
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const complete = data?.version === STATE_VERSION && data.complete === true && entries.every(row => savedOwner(row) !== null);
  let loaded = false;
  if (data && typeof data.version === 'number' && data.version >= 3 && data.version <= STATE_VERSION) {
    for (const row of entries.slice(-MAX_OWNERS)) {
      const owner = savedOwner(row);
      if (!owner) continue;
      mergeOwner(owner);
      loaded = true;
    }
  }
  if (complete) return;
  let sessions;
  try {
    sessions = await indexedSessions();
  } catch (error) {
    if (loaded) return;
    throw error;
  }
  for (const session of sessions.slice(0, 100).reverse()) {
    const events = await readRecentEvents(session.id, 1024, { kinds: ['tool_call'], maxBytes: 512 * 1024 });
    for (const event of events) {
      if (event.kind !== 'tool_call') continue;
      const call = event.call;
      if (call.attributionMethod !== 'request_id' || !call.requestId || !call.conversationId) continue;
      mergeOwner({
        requestId: call.requestId,
        conversationId: call.conversationId,
        sessionId: session.id,
        messageId: `stored:${call.callId}`,
        tool: call.tool,
        observedAt: event.time
      });
    }
  }
  await writeDurableNow(STATE_KEY, snapshot());
}

export async function commitRequestCorrelations(): Promise<void> {
  await writeDurableNow(STATE_KEY, snapshot());
}

export function resetCorrelationRegistryForTests(): void {
  owners.clear();
  waitStarts.clear();
  restored = false;
  restoreFlight = null;
  for (const requestId of [...pending.keys()]) wake(requestId);
}
