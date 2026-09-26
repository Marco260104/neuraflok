import { randomUUID } from 'node:crypto';
import type { SessionEvent, SessionSummary } from '../../../../contracts/session.js';
import type { InputEntry } from './input-schema.js';
import { INPUT_WORK_KINDS, RECOVERY_WORK_KINDS } from './input-policy.js';

type InputRecoveryRuntime = {
  serial<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<InputEntry[]>;
  commit(next: InputEntry[]): Promise<void>;
  append(current: InputEntry[], entry: InputEntry): InputEntry[];
  terminal(entry: InputEntry): boolean;
  ordered(rows: InputEntry[]): InputEntry[];
  manualInput(entry: InputEntry): boolean;
  queuedFollowup(entry: InputEntry): boolean;
  queuedAfterTurn(entry: InputEntry, session: SessionSummary): boolean;
  consumedTurn(entry: InputEntry, turnId: string): boolean;
  eligibleStageEnd(entry: InputEntry): Promise<string | null>;
  recoveryCurrent(entry: InputEntry): Promise<boolean>;
  recoveryInvalidReason(entry: InputEntry): Promise<string | null>;
  getSession(sessionId: string): Promise<SessionSummary | null>;
  isChatBlocked(conversationId: string): boolean;
  inFlightToolCalls(conversationId: string): number;
  readLatestUserMessage(sessionId: string, turnId: string): Promise<Extract<SessionEvent, { kind: 'user_message' }> | undefined>;
  readRecentEvents(sessionId: string, limit: number, options: { kinds: SessionEvent['kind'][] }): Promise<SessionEvent[]>;
  workSequence(event: SessionEvent): number;
  turnHasMcpCall(sessionId: string, conversationId: string, turnId: string): Promise<boolean>;
  recoveryBusyMs(pro: boolean): number;
  recoveryMessage(): string;
  isProModel(model: string, reasoningEffort?: string | null): boolean;
  logInfo(message: string): void;
};

export function createInputRecoveryOperations(runtime: InputRecoveryRuntime) {
  const refusalsTold = new Set<string>();

  function releaseRecoveryClaim(row: InputEntry, error?: string): InputEntry {
    return { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
      ...(error ? { error: error.slice(0, 200) } : {}),
      recovery: { ...row.recovery!, phase: row.recovery!.phase === 'ready' ? 'ready' : 'resumed' } };
  }

  function withoutSilenceClaim(row: InputEntry, preserveBoundary = false): InputEntry {
    if (row.recovery) return { ...row, state: 'cancelled', error: 'Automatic Continue cancelled by new activity.' };
    return { ...row, state: 'queued', owner: null, silenceBoundary: preserveBoundary ? row.silenceBoundary : undefined, completedTurnId: undefined,
      ...(runtime.manualInput(row) ? { transportIntent: 'tool' } : {}),
      companionInputId: undefined, offeredAt: undefined, sendAuthorizedAt: undefined, requiresAuthorization: undefined, deliveryText: undefined, error: undefined };
  }

  function fileRecoveryInput(sessionId: string, conversationId: string, turnId: string, pro: boolean,
    currentOwner: () => boolean, busyUntil = Date.now() + runtime.recoveryBusyMs(pro), episode = `turn:${turnId}`): Promise<boolean> {
    const refused = (why: string): false => {
      const key = `${conversationId}:${turnId}:${why}`;
      if (!refusalsTold.has(key)) {
        refusalsTold.add(key);
        if (refusalsTold.size > 500) refusalsTold.delete(refusalsTold.values().next().value!);
        runtime.logInfo(`input: automatic Continue for ${conversationId} not filed — ${why} (turn ${turnId})`);
      }
      return false;
    };
    return runtime.serial(async () => {
      const current = await runtime.load();
      if (current.some(row => row.sessionId === sessionId && !runtime.terminal(row))) return refused('an earlier message of this session is still awaiting delivery');
      const question = await runtime.readLatestUserMessage(sessionId, turnId);
      const [work] = await runtime.readRecentEvents(sessionId, 1, { kinds: RECOVERY_WORK_KINDS });
      if (!question?.messageId) return refused('the session has no recorded question to continue');
      if (!work) return refused('the session has no recorded work to continue');
      if (!currentOwner()) return false;
      if (current.some(row => row.sessionId === sessionId && row.recovery && row.silenceBoundary?.turnId === turnId &&
          (row.sendAuthorizedAt !== undefined || (!runtime.terminal(row) && (!row.recovery.episode || row.recovery.episode === episode))))
      ) return refused('this turn already has its restart');
      if (current.some(row => row.sessionId === sessionId && row.recovery?.ended && row.silenceBoundary?.turnId === turnId &&
          row.silenceBoundary.workSeq === runtime.workSequence(work))) return refused('pages refused this restart and nothing has changed since');
      const now = Date.now();
      const row: InputEntry = { id: randomUUID(), sessionId, conversationId, owner: null, state: 'queued',
        mode: 'after-turn', dueAt: now, createdAt: now, model: null, reasoningEffort: null,
        text: runtime.recoveryMessage(),
        recovery: { questionId: question.messageId, episode, pro, busyUntil, phase: 'ready' },
        silenceBoundary: { turnId, conversationId, workSeq: runtime.workSequence(work), acceptedAt: now } };
      if (!await runtime.recoveryCurrent(row)) {
        const why = await runtime.recoveryInvalidReason(row);
        return refused(why ?? 'a local tool call is still running');
      }
      if (!currentOwner()) return false;
      await runtime.commit(runtime.append(current, row));
      return true;
    });
  }

  function advanceRecoveryInput(id: string, owner: string, conversationId: string,
    action: 'stop' | 'stopped' | 'reloaded'): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === id && entry.state === 'browser' && entry.owner === owner &&
        entry.conversationId === conversationId && entry.sendAuthorizedAt === undefined);
      if (!row?.recovery || !await runtime.recoveryCurrent(row)) return false;
      const phase = row.recovery.phase;
      if (action === 'stop' && (phase !== 'ready' || !row.silenceBoundary?.nativeBusy ||
          (row.silenceBoundary.listenUntil ?? Infinity) > Date.now())) return false;
      if (action === 'stopped' && phase !== 'stopping') return false;
      if (action === 'reloaded' && phase !== 'reloading') return false;
      const next: InputEntry = action === 'reloaded'
        ? { ...row, state: 'queued', owner: null, offeredAt: undefined, completedTurnId: undefined,
            deliveryText: undefined, recovery: { ...row.recovery, phase: 'resumed', reloadOwner: owner } }
        : { ...row, recovery: { ...row.recovery, phase: action === 'stop' ? 'stopping' : 'resumed' } };
      await runtime.commit(current.map(entry => entry === row ? next : entry));
      return runtime.recoveryCurrent(next);
    });
  }

  function fileSilenceInput(sessionId: string, conversationId: string, turnId: string, currentOwner: () => boolean, listenUntil?: number): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const session = await runtime.getSession(sessionId);
      if (!currentOwner() || !session || session.conversationId !== conversationId || runtime.isChatBlocked(conversationId) ||
          session.origin?.kind === 'worker' || session.origin?.kind === 'helper' || runtime.inFlightToolCalls(conversationId) > 0) return false;
      const [boundary] = await runtime.readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      if (!boundary || boundary.turnId !== turnId || (boundary.kind !== 'turn_start' && boundary.kind !== 'turn_end')) return false;
      if (!await runtime.turnHasMcpCall(sessionId, conversationId, turnId) || !currentOwner()) return false;
      if (current.some(row => row.sessionId === sessionId &&
          (runtime.consumedTurn(row, turnId) || (row.silenceBoundary?.turnId === turnId && row.state === 'browser')))) return true;
      if (current.some(row => row.sessionId === sessionId && (row.state === 'browser' || row.state === 'tool'))) return false;
      const candidates = runtime.ordered(current).filter(row => row.sessionId === sessionId && row.state === 'queued');
      const row = candidates.find(entry => runtime.manualInput(entry) && entry.offeredAt === undefined && entry.dueAt <= Date.now()) ?? candidates.find(runtime.queuedFollowup);
      if (!row || !runtime.queuedAfterTurn(row, session)) return false;
      if (row.recovery) return true;
      const [work] = await runtime.readRecentEvents(sessionId, 1, { kinds: INPUT_WORK_KINDS });
      if (!work || !currentOwner()) return false;
      const previous = current.find(entry => entry.sessionId === sessionId && entry.silenceBoundary?.turnId === turnId)?.silenceBoundary;
      const listening = Math.max(listenUntil ?? 0, previous?.listenUntil ?? 0);
      if (row.silenceBoundary?.turnId === turnId && row.silenceBoundary.workSeq === runtime.workSequence(work) &&
          (row.silenceBoundary.listenUntil ?? 0) === listening) return true;
      await runtime.commit(current.map(entry => entry === row ? { ...entry,
        silenceBoundary: { turnId, conversationId, workSeq: runtime.workSequence(work), acceptedAt: previous ? previous.acceptedAt : Date.now(),
          ...(listening ? { listenUntil: listening } : {}), ...(previous?.nativeBusy ? { nativeBusy: true } : {}) } }
        : entry.sessionId === sessionId && entry.state === 'queued' && entry.silenceBoundary?.turnId === turnId
          ? { ...entry, silenceBoundary: undefined } : entry));
      return true;
    });
  }

  function deferSilenceInput(id: string, conversationId: string, turnId: string): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(entry => entry.id === id && entry.state === 'queued' && entry.offeredAt === undefined);
      const session = row?.sessionId ? await runtime.getSession(row.sessionId) : null;
      if (!row?.sessionId || session?.conversationId !== conversationId || await runtime.eligibleStageEnd(row) !== turnId) return false;
      let boundary = row.silenceBoundary;
      if (!boundary) {
        const [end] = await runtime.readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
        if (!runtime.manualInput(row) || end?.kind !== 'turn_end' || end.turnId !== turnId || end.outcome !== 'failed' || end.reason !== 'thinking_failed') return false;
        const [work] = await runtime.readRecentEvents(row.sessionId, 1, { kinds: INPUT_WORK_KINDS });
        if (!work) return false;
        boundary = { conversationId, turnId, workSeq: runtime.workSequence(work), acceptedAt: Date.now() };
      }
      if (boundary.conversationId !== conversationId || boundary.turnId !== turnId) return false;
      if (row.recovery && boundary.nativeBusy) return false;
      await runtime.commit(current.map(entry => entry === row ? { ...row,
        silenceBoundary: { ...boundary!, listenUntil: row.recovery
          ? row.recovery.busyUntil
          : Date.now() + runtime.recoveryBusyMs(session.selectedModel?.conversationId === conversationId &&
              runtime.isProModel(session.selectedModel.model, session.selectedModel.reasoningEffort)), nativeBusy: true } } : entry));
      return true;
    });
  }

  function revokeSilenceInputs(sessionId: string): Promise<void> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const next = current.map(row => row.sessionId === sessionId && (row.silenceBoundary || row.completedTurnId) &&
        (row.state === 'queued' || (row.state === 'browser' && row.sendAuthorizedAt === undefined)) ? withoutSilenceClaim(row) : row);
      if (next.some((row, index) => row !== current[index])) await runtime.commit(next);
    });
  }

  return { releaseRecoveryClaim, withoutSilenceClaim, fileRecoveryInput, advanceRecoveryInput, fileSilenceInput, deferSilenceInput, revokeSilenceInputs };
}
