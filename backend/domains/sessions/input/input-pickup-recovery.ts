import { BROWSER_PICKUP_MAX_ATTEMPTS } from '../../../../contracts/recovery.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import type { InputEntry } from './input-schema.js';
import type { InputActivity } from './input-policy.js';
import { terminal } from './input-admission.js';

const UNCLAIMED_PICKUP_RETRY_MIN_MS = 2 * 60_000;
const UNCLAIMED_PICKUP_RETRY_MAX_AGE_MS = 30 * 60_000;

export interface PickupRecoveryState { attempts: number; nextAt?: number; stoppedAt?: number }

type PickupRecoveryRuntime = {
  load(): Promise<InputEntry[]>;
  serial<T>(work: () => Promise<T>): Promise<T>;
  commit(next: InputEntry[]): Promise<void>;
  eligibleStageEnd(entry: InputEntry): Promise<string | null>;
  getSession(sessionId: string): Promise<SessionSummary | null>;
  activity(session: SessionSummary): InputActivity | undefined;
  recoveryAllowed(sessionId: string, conversationId: string): boolean | undefined;
  isChatBlocked(conversationId: string): boolean;
  conversationWasSuperseded(conversationId: string): Promise<boolean>;
  inFlightToolCalls(conversationId: string): number;
  readRecentEvents: typeof import('../history/store.js').readRecentEvents;
  logInfo(message: string): void;
};

export function createPickupRecoveryService(runtime: PickupRecoveryRuntime) {
  async function rowsForSource(current: InputEntry[], sessionId: string, sourceTurnId: string): Promise<InputEntry[]> {
    const matching: InputEntry[] = [];
    for (const entry of current) {
      if (entry.sessionId !== sessionId || entry.purpose === 'decision' || entry.opening) continue;
      if (await runtime.eligibleStageEnd(entry) === sourceTurnId) matching.push(entry);
    }
    return matching;
  }

  function mergedState(rows: InputEntry[], inherited?: PickupRecoveryState): PickupRecoveryState {
    const attempts = Math.min(BROWSER_PICKUP_MAX_ATTEMPTS,
      Math.max(inherited?.attempts ?? 0, ...rows.map(row => row.pickupRecovery?.attempts ?? 0)));
    const stoppedAt = inherited?.stoppedAt ?? rows.find(row => row.pickupRecovery?.stoppedAt)?.pickupRecovery?.stoppedAt;
    if (stoppedAt || attempts >= BROWSER_PICKUP_MAX_ATTEMPTS) return {
      attempts, stoppedAt: stoppedAt ?? rows.find(row => row.pickupRecovery?.stoppedAt)?.pickupRecovery?.stoppedAt ?? Date.now()
    };
    const nextAt = inherited?.attempts === attempts ? inherited.nextAt : undefined;
    const rowNextAt = rows.find(row => row.pickupRecovery?.attempts === attempts)?.pickupRecovery?.nextAt;
    const selectedNextAt = nextAt ?? rowNextAt;
    return { attempts, ...(selectedNextAt ? { nextAt: selectedNextAt } : {}) };
  }

  function sameState(a: PickupRecoveryState | undefined, b: PickupRecoveryState): boolean {
    return a?.attempts === b.attempts && a?.nextAt === b.nextAt && a?.stoppedAt === b.stoppedAt;
  }

  function syncQueuedPickupRecoveryNow(inputId: string, sourceTurnId: string, state: PickupRecoveryState): Promise<PickupRecoveryState | null> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === inputId && entry.state === 'queued');
      if (!row?.sessionId || row.purpose === 'decision' || await runtime.eligibleStageEnd(row) !== sourceTurnId) return null;
      const matches = await rowsForSource(current, row.sessionId, sourceTurnId);
      const merged = mergedState(matches, state);
      const next = current.map(entry => matches.includes(entry) && !sameState(entry.pickupRecovery, merged)
        ? { ...entry, pickupRecovery: merged } : entry);
      if (next.some((entry, index) => entry !== current[index])) await runtime.commit(next);
      return merged;
    });
  }

  function recordQueuedPickupAttemptNow(inputId: string, sourceTurnId: string, at: number, nextAt?: number, inherited?: PickupRecoveryState): Promise<PickupRecoveryState | null> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === inputId);
      if (!row || !row.sessionId || row.purpose === 'decision' || row.state !== 'queued' ||
          await runtime.eligibleStageEnd(row) !== sourceTurnId) return null;
      const session = await runtime.getSession(row.sessionId);
      if (!session || session.conversationId !== row.conversationId || session.browserRecoveryDismissedAt !== undefined) return null;
      const matches = await rowsForSource(current, row.sessionId, sourceTurnId);
      const prior = mergedState(matches, inherited);
      if (prior.stoppedAt || prior.attempts >= BROWSER_PICKUP_MAX_ATTEMPTS) {
        const next = current.map(entry => matches.includes(entry) && !sameState(entry.pickupRecovery, prior)
          ? { ...entry, pickupRecovery: prior } : entry);
        if (next.some((entry, index) => entry !== current[index])) await runtime.commit(next);
        return null;
      }
      const attempts = prior.attempts + 1;
      const pickupRecovery = attempts >= BROWSER_PICKUP_MAX_ATTEMPTS ? { attempts, stoppedAt: at }
        : { attempts, ...(nextAt !== undefined ? { nextAt } : {}) };
      await runtime.commit(current.map(entry => matches.includes(entry) ? { ...entry, pickupRecovery } : entry));
      return { attempts, ...('nextAt' in pickupRecovery && pickupRecovery.nextAt ? { nextAt: pickupRecovery.nextAt } : {}),
        ...('stoppedAt' in pickupRecovery && pickupRecovery.stoppedAt ? { stoppedAt: pickupRecovery.stoppedAt } : {}) };
    });
  }

  function retryUnclaimedInput(id: string): Promise<InputEntry | null> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === id);
      const now = Date.now();
      if (!row || row.state !== 'failed' || row.error !== 'Not sent: the browser did not pick up this message within 60 seconds.' ||
          !Number.isFinite(row.pickupFailedAt) || (row.pickupRetryCount !== undefined && row.pickupRetryCount !== 0) ||
          now - row.pickupFailedAt! < UNCLAIMED_PICKUP_RETRY_MIN_MS || now - row.pickupFailedAt! > UNCLAIMED_PICKUP_RETRY_MAX_AGE_MS ||
          now < row.createdAt || now - row.createdAt > UNCLAIMED_PICKUP_RETRY_MAX_AGE_MS || row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined ||
          row.mode !== 'auto' || row.transportIntent !== 'browser' || row.purpose === 'decision' || row.opening || row.requiresAuthorization ||
          row.cancelledByUser || row.recovery || row.silenceBoundary || row.finishOwner || row.directTurn || row.queuedTurn ||
          row.companionInputId || row.attachments?.length || row.images?.length || row.toolImages?.length || row.delivery ||
          row.attachmentDelivery || row.toolTurnId || row.automation || row.objective || row.stages?.length || row.loopAfterTurn ||
          !row.sessionId || !row.conversationId) return null;
      const session = await runtime.getSession(row.sessionId);
      const activity = session ? runtime.activity(session) ?? { possible: !!session.activeTurnId, exact: !!session.activeTurnId } : null;
      if (!session || session.conversationId !== row.conversationId || activity?.possible || activity?.exact ||
          runtime.recoveryAllowed(row.sessionId, row.conversationId) !== true ||
          session.browserRecoveryDismissedAt !== undefined || runtime.isChatBlocked(row.conversationId) ||
          await runtime.conversationWasSuperseded(row.conversationId) || runtime.inFlightToolCalls(row.conversationId) > 0) return null;
      const [boundary] = await runtime.readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      if (boundary?.kind !== 'turn_end' || boundary.time > row.createdAt || boundary.outcome === 'stopped') return null;
      const [newerMessage] = await runtime.readRecentEvents(row.sessionId, 1, { kinds: ['user_message'] });
      if (newerMessage && newerMessage.time > row.createdAt) return null;
      if (current.some(other => other.id !== row.id && other.sessionId === row.sessionId &&
          (!terminal(other) || other.createdAt > row.createdAt))) return null;
      const next: InputEntry = { ...row, state: 'queued', owner: null, dueAt: now, offeredAt: undefined,
        completedTurnId: undefined, error: undefined, pickupFailedAt: undefined, pickupRetryCount: 1 };
      await runtime.commit(current.map(entry => entry.id === row.id ? next : entry));
      runtime.logInfo(`input ${row.id}: requeued the same browser message after one proven pre-Send pickup timeout`);
      return next;
    });
  }

  return { rowsForSource, mergedState, syncQueuedPickupRecoveryNow, recordQueuedPickupAttemptNow, retryUnclaimedInput };
}
