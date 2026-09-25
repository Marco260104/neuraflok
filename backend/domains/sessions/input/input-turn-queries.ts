import { manualInput, queuedFollowup } from '../../../../contracts/input.js';
import { isAstraModel, isProModel } from '../../../../contracts/model-capabilities.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import type { InputEntry } from './input-schema.js';

type PickupRecovery = ReturnType<typeof import('./input-pickup-recovery.js').createPickupRecoveryService>;

type Runtime = {
  serial<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<InputEntry[]>;
  ordered(rows: InputEntry[]): InputEntry[];
  getSession: typeof import('../history/store.js').getSession;
  readRecentEvents: typeof import('../history/store.js').readRecentEvents;
  eligibleStageEnd(entry: InputEntry): Promise<string | null>;
  browserInputAllowed(entry: InputEntry): Promise<boolean>;
  pickupRecovery: Pick<PickupRecovery, 'rowsForSource' | 'mergedState'>;
};

export interface PendingQueuedPickup {
  inputId: string;
  conversationId: string;
  sessionId: string;
  sourceTurnId: string;
  acceptedAt: number;
  listenUntil: number;
  pro: boolean;
  pickupAttempts: number;
  pickupNextAt?: number;
  pickupStoppedAt?: number;
}

export function createInputTurnQueries(runtime: Runtime) {
  async function hasEligibleToolInput(sessionId: string, finishBoundary = false): Promise<boolean> {
    return runtime.serial(async () => {
      const current = runtime.ordered(await runtime.load());
      if (current.some(row => row.sessionId === sessionId && row.state === 'browser')) return false;
      const head = current.find(row => row.sessionId === sessionId && queuedFollowup(row) && ['queued', 'tool'].includes(row.state));
      for (const row of current) {
        if (row.localExecutor || row.sessionId !== sessionId || row.dueAt > Date.now()) continue;
        if (row.attachments?.length && row.attachmentDelivery !== 'tool' && row.delivery !== 'tool') continue;
        if (row.mode === 'after-turn' || (row.mode === 'finish' && !finishBoundary)) continue;
        if (row.mode === 'finish' && row !== head) continue;
        if (row.state === 'tool') return true;
        if (row.state === 'queued') return row.mode === 'auto' || (finishBoundary && row.mode === 'finish');
      }
      return false;
    });
  }

  function queuedAfterTurn(row: InputEntry, session: SessionSummary): boolean {
    const astra = session.selectedModel?.conversationId === session.conversationId &&
      isAstraModel(session.selectedModel.model, session.selectedModel.reasoningEffort);
    return row.sessionId === session.id && (queuedFollowup(row) || (manualInput(row) && row.offeredAt === undefined)) && row.state === 'queued' && row.dueAt <= Date.now() &&
      (row.mode !== 'finish' || row.afterTurn === true || !astra);
  }

  function consumedTurn(row: InputEntry, turnId: string): boolean {
    return row.completedTurnId === turnId &&
      (row.sendAuthorizedAt !== undefined || row.deliveredAt !== undefined || row.requiresAuthorization === false);
  }

  async function hasQueuedAfterTurnInput(sessionId: string): Promise<boolean> {
    const session = await runtime.getSession(sessionId);
    return !!session && (await runtime.load()).some(row => queuedAfterTurn(row, session));
  }

  // Read the same visible queue head as claims; restored tickets without acceptance time cannot start recovery.
  function pendingQueuedPickups(): Promise<PendingQueuedPickup[]> {
    return runtime.serial(async () => {
      const rows = await runtime.load();
      const result: PendingQueuedPickup[] = [];
      const pending = runtime.ordered(rows).filter(row => row.sessionId && row.purpose !== 'decision' && ['queued', 'browser', 'tool'].includes(row.state));
      for (const sessionId of new Set(pending.map(row => row.sessionId))) {
        const candidates = pending.filter(row => row.sessionId === sessionId);
        const row = candidates.find(row => manualInput(row) && row.silenceBoundary) ?? candidates[0]!;
        if (!row.sessionId) continue;
        if (row.state !== 'queued' || (!queuedFollowup(row) && !manualInput(row)) || row.dueAt > Date.now()) continue;
        const session = await runtime.getSession(row.sessionId);
        if (!session?.conversationId || !queuedAfterTurn(row, session)) continue;
        const probe = row.silenceBoundary ? { ...row, silenceBoundary: { ...row.silenceBoundary, listenUntil: undefined } } : row;
        const sourceTurnId = await runtime.eligibleStageEnd(probe);
        if (!sourceTurnId || rows.some(other => other.sessionId === row.sessionId &&
            (consumedTurn(other, sourceTurnId) || other.state === 'browser' || other.state === 'tool'))) continue;
        const [end] = await runtime.readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
        const completed = end?.kind === 'turn_end' && end.outcome === 'completed';
        const acceptedAt = row.silenceBoundary?.acceptedAt ?? (!row.silenceBoundary && completed ? end.time : undefined);
        if (acceptedAt === undefined) continue;
        const selection = session.selectedModel;
        const sourceOwners = await runtime.pickupRecovery.rowsForSource(rows, row.sessionId, sourceTurnId);
        const pickupRecovery = runtime.pickupRecovery.mergedState(sourceOwners);
        result.push({
          inputId: row.id,
          conversationId: session.conversationId,
          sessionId: row.sessionId,
          sourceTurnId,
          acceptedAt,
          listenUntil: completed && !row.silenceBoundary?.nativeBusy ? 0 : row.silenceBoundary?.listenUntil ?? 0,
          pro: selection?.conversationId === session.conversationId && isProModel(selection.model, selection.reasoningEffort),
          pickupAttempts: pickupRecovery.attempts,
          ...(pickupRecovery.nextAt ? { pickupNextAt: pickupRecovery.nextAt } : {}),
          ...(pickupRecovery.stoppedAt ? { pickupStoppedAt: pickupRecovery.stoppedAt } : {})
        });
      }
      return result;
    });
  }

  // The visible outbox owns Goal precedence, and a consumed completion stays tied to its authored input.
  async function inputBeforeGoal(sessionId: string, sourceTurnId?: string): Promise<'queued' | 'consumed' | null> {
    return runtime.serial(async () => {
      const rows = await runtime.load();
      if (rows.some(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
        ['queued', 'browser', 'tool'].includes(row.state))) return 'queued';
      return sourceTurnId && rows.some(row => row.sessionId === sessionId && consumedTurn(row, sourceTurnId)) ? 'consumed' : null;
    });
  }

  // A native-only queue head needs the held answer to finish before it can send.
  async function finishNeedsBrowserInput(sessionId: string): Promise<boolean> {
    return runtime.serial(async () => {
      const head = runtime.ordered(await runtime.load()).find(row => row.sessionId === sessionId && row.purpose !== 'decision' &&
        ['queued', 'browser', 'tool'].includes(row.state));
      if (!head || head.state !== 'queued' || head.dueAt > Date.now() ||
        !(head.mode === 'after-turn' || (head.attachments?.length && head.attachmentDelivery !== 'tool'))) return false;
      const session = await runtime.getSession(sessionId);
      return !!session && queuedAfterTurn(head, session);
    });
  }

  // This returns metadata only; an exclusive durable claim still gates disclosure of input text.
  async function completedStageBoundary(entry: InputEntry, current: InputEntry[]): Promise<string | null> {
    if (!entry.sessionId || !queuedFollowup(entry)) return null;
    // Preserve the visible queue order so a delayed or finish-only head cannot be overtaken.
    const first = runtime.ordered(current).find(row => row.sessionId === entry.sessionId && queuedFollowup(row) && row.state === 'queued');
    if (first?.id !== entry.id || first.dueAt > Date.now() || !await runtime.browserInputAllowed(first)) return null;
    const turnId = await runtime.eligibleStageEnd(entry);
    if (!turnId) return null;
    // Keep a deferred ticket on its source turn ahead of later rows.
    if (current.some(row => row !== entry && row.sessionId === entry.sessionId && row.state === 'queued' &&
        row.silenceBoundary?.turnId === turnId)) return null;
    if (current.some(row => row.sessionId === entry.sessionId && (consumedTurn(row, turnId) || row.state === 'tool' || row.state === 'browser'))) return null;
    if (current.some(row => row.sessionId === entry.sessionId && !queuedFollowup(row) && row.purpose !== 'decision' &&
        row.dueAt <= Date.now() && ['queued', 'browser', 'tool'].includes(row.state))) return null;
    return turnId;
  }

  return {
    hasEligibleToolInput,
    queuedAfterTurn,
    consumedTurn,
    hasQueuedAfterTurnInput,
    pendingQueuedPickups,
    inputBeforeGoal,
    finishNeedsBrowserInput,
    completedStageBoundary
  };
}
