import type * as SessionHistory from '../history/store.js';
import type { InputEntry } from './input-schema.js';
import type { InputActivity } from './input-policy.js';

type TurnQueries = Pick<ReturnType<typeof import('./input-turn-queries.js').createInputTurnQueries>, 'queuedAfterTurn' | 'consumedTurn'>;

type Runtime = {
  serial: <T>(work: () => Promise<T>) => Promise<T>;
  load: () => Promise<InputEntry[]>;
  commit: (next: InputEntry[]) => Promise<void>;
  ordered: (rows: InputEntry[]) => InputEntry[];
  target: (entry: InputEntry) => Promise<string | null>;
  sameDelivery: (root: InputEntry, row: InputEntry) => boolean;
  getSession: typeof SessionHistory.getSession;
  readRecentEvents: typeof SessionHistory.readRecentEvents;
  sessionInputPolicy: (sessionId: string, observedActivity?: InputActivity) => ReturnType<typeof import('./input-policy.js').readSessionInputPolicy>;
  readBrowserInputAllowed: typeof import('./input-policy.js').readBrowserInputAllowed;
  readEligibleStageEnd: typeof import('./input-policy.js').readEligibleStageEnd;
  readRecoveryInvalidReason: typeof import('./input-policy.js').readRecoveryInvalidReason;
  recoveryAllowed: (sessionId: string, conversationId: string) => boolean | undefined;
  callsHoldRecovery: (conversationId: string) => boolean;
  consumeGoalReplyForInputNow: typeof import('../../automation/goal.js').consumeGoalReplyForInputNow;
  turnQueries: () => TurnQueries;
};

export function createInputDeliveryAuthorization(runtime: Runtime) {
  function recoveryInvalidReason(row: InputEntry): Promise<string | null> {
    return runtime.readRecoveryInvalidReason(row, runtime.recoveryAllowed);
  }

  async function recoveryCurrent(row: InputEntry): Promise<boolean> {
    const conversationId = row.silenceBoundary?.conversationId;
    const held = (id: string) => runtime.callsHoldRecovery(id);
    return !!conversationId && !held(conversationId) &&
      await recoveryInvalidReason(row) === null && !held(conversationId);
  }

  function browserInputAllowed(entry: InputEntry): Promise<boolean> {
    return runtime.readBrowserInputAllowed(entry, { sessionPolicy: runtime.sessionInputPolicy, recoveryCurrent });
  }

  function eligibleStageEnd(entry: InputEntry): Promise<string | null> {
    return runtime.readEligibleStageEnd(entry, { sessionPolicy: runtime.sessionInputPolicy, recoveryCurrent });
  }

  function authorizeBrowserInput(id: string, owner: string, conversationId: string | null): Promise<boolean> {
    return runtime.serial(async () => {
      const current = await runtime.load();
      const row = current.find(row => row.id === id && row.owner === owner && row.state === 'browser' && row.conversationId === conversationId);
      if (!row || row.sendAuthorizedAt !== undefined || current.some(root => root.companionInputId === row.id)) return false;
      if (!(await browserInputAllowed(row)) || await runtime.target(row) !== conversationId) return false;
      if (row.companionInputId) {
        const companion = current.find(other => other.id === row.companionInputId && other.state === 'browser' && other.owner === owner && other.sessionId === row.sessionId);
        const session = row.sessionId ? await runtime.getSession(row.sessionId) : null;
        if (!companion || !session || !runtime.turnQueries().queuedAfterTurn({ ...companion, state: 'queued' }, session)) return false;
      }
      await runtime.commit(current.map(entry => runtime.sameDelivery(row, entry) ? { ...entry, sendAuthorizedAt: Date.now() } : entry));
      // Recorder work can arrive during a durable claim write, so never publish stale Send permission.
      if (row.recovery && !await recoveryCurrent(row)) return false;
      if (!row.recovery && row.completedTurnId && row.sessionId && conversationId)
        await runtime.consumeGoalReplyForInputNow(conversationId, row.sessionId, row.completedTurnId);
      return !row.recovery || await recoveryCurrent(row);
    });
  }

  function nextAfterTurnLocalInput(sessionId: string, conversationId: string, turnId?: string): Promise<InputEntry | null> {
    return runtime.serial(async () => {
      const session = await runtime.getSession(sessionId);
      if (!turnId || !session || session.activeTurnId || session.conversationId !== conversationId) return null;
      const [end] = await runtime.readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
      if (end?.kind !== 'turn_end' || end.outcome !== 'completed' || end.turnId !== turnId) return null;
      const current = runtime.ordered(await runtime.load());
      if (current.some(row => row.sessionId === sessionId && runtime.turnQueries().consumedTurn(row, turnId))) return null;
      const head = current.find(row =>
        row.sessionId === sessionId &&
        row.state === 'queued' &&
        row.purpose !== 'decision' &&
        !row.finishOwner &&
        (!row.stages || row.stages.length === 0)
      );
      if (!head || head.dueAt > Date.now() || head.mode !== 'after-turn' || await eligibleStageEnd(head) !== turnId) return null;
      const offered = { ...head, completedTurnId: turnId };
      await runtime.commit(current.map(row => row.id === head.id ? offered : row));
      return { ...offered };
    });
  }

  return { authorizeBrowserInput, browserInputAllowed, eligibleStageEnd, nextAfterTurnLocalInput, recoveryCurrent, recoveryInvalidReason };
}
