import { manualInput } from '../../../../contracts/input.js';
import type { InputActivity } from './input-policy.js';
import type { InputEntry } from './input-schema.js';
import type * as SessionHistory from '../history/store.js';
import { companionOf, terminal } from './input-admission.js';

export const UNCONFIRMED_SEND = 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.';

const UNCERTAIN_SEND_MS = 15 * 60_000;
const ABANDONED_SEND_MS = 6 * 60 * 60_000;

type Runtime = {
  getSession: typeof SessionHistory.getSession;
  readRecentEvents: typeof SessionHistory.readRecentEvents;
  recoveryInvalidReason: (row: InputEntry) => Promise<string | null>;
  finishInputCurrent: (row: InputEntry) => Promise<boolean>;
  activity: (session: NonNullable<Awaited<ReturnType<typeof SessionHistory.getSession>>>) => InputActivity | null | undefined;
  settleToolInputFromFinal: (row: InputEntry) => Promise<InputEntry>;
  releaseRecoveryClaim: (row: InputEntry) => InputEntry;
  commit: (next: InputEntry[]) => Promise<void>;
  logInfo: (message: string) => void;
  currentEntries: () => InputEntry[];
};

export function createInputQueueExpiration(runtime: Runtime) {
  async function expireQueued(current: InputEntry[]): Promise<InputEntry[]> {
    const next = await Promise.all(current.map(async (row): Promise<InputEntry> => {
      if (companionOf(current, row)) return row;
      if (row.recovery && row.state === 'browser' && row.sendAuthorizedAt !== undefined &&
          row.sessionId && row.conversationId && row.silenceBoundary?.conversationId === row.conversationId &&
          !row.companionInputId) {
        const session = await runtime.getSession(row.sessionId);
        // A committed handoff ends this generated Continue's wait in its old chat. Keep the original claim and authorization for an exact late receipt; this neither proves non-delivery nor authorizes a replay. Authored queue rows still follow the session, and time alone never releases an uncertain send.
        if (session?.conversationId && session.conversationId !== row.conversationId &&
            session.chatIds.includes(row.conversationId)) return { ...row, state: 'cancelled' };
      }
      if (row.recovery && !terminal(row) && row.sendAuthorizedAt === undefined) {
        const reason = await runtime.recoveryInvalidReason(row);
        if (reason) return { ...row, state: 'cancelled', error: `Automatic Continue cancelled: ${reason}.` };
      }
      if (row.finishOwner && !terminal(row) && !(await runtime.finishInputCurrent(row)))
        return { ...row, state: 'cancelled', error: 'Automatic follow-up cancelled because its active turn or setting changed.' };
      if (row.purpose === 'decision') return row;
      if (row.state === 'queued' && row.delivery === 'tool' && row.toolTurnId) {
        const session = row.sessionId ? await runtime.getSession(row.sessionId) : null;
        const activity = session ? runtime.activity(session) : null;
        const observedTurn = session?.activeTurnId ?? (activity?.exact ? activity.turnId : null);
        const [boundary] = row.sessionId ? await runtime.readRecentEvents(row.sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
        const targetEnded = !observedTurn && boundary?.kind === 'turn_end' && boundary.turnId === row.toolTurnId;
        const newerTurn = !!observedTurn && observedTurn !== row.toolTurnId;
        const newerBoundary = !observedTurn && !!boundary?.turnId && boundary.turnId !== row.toolTurnId;
        const ownerChanged = !session || session.conversationId !== row.conversationId;
        if (targetEnded || newerTurn || newerBoundary || ownerChanged) return { ...row, state: 'failed',
          error: 'Not injected: the selected turn ended before an eligible tool call.' };
      }
      if (row.state === 'tool') return runtime.settleToolInputFromFinal(row);
      // Only an ordinary browser attempt has an unclaimed startup deadline. Tool intent survives a later terminal observation/restart; legacy bound-chat rows are ambiguous and cannot safely be reclassified from today's activity. A message the app itself holds ("Message queued. Finish Setup to send: …", or after a failed browser start) was never offered to a browser. It stays queued with its reason and Retry; failing it here lost it and blamed the browser instead.
      if (row.state === 'queued' && row.mode === 'auto' && !row.opening && !row.finishOwner && !row.silenceBoundary &&
          (row.transportIntent === 'browser' || (!row.transportIntent && !row.sessionId)) &&
          !row.error?.startsWith('Message queued. ') &&
          Date.now() - Math.max(row.createdAt, row.dueAt) >= 60_000)
        return { ...row, state: 'failed', pickupFailedAt: Date.now(), error: 'Not sent: the browser did not pick up this message within 60 seconds.' };
      // Preparation can expire before Send. Once authorized, this exact claim owns the uncertain outcome until receipt or explicit cancellation, regardless of how long the provider takes to assign its durable conversation identity.
      const companion = current.find(other => other.id === row.companionInputId);
      if (row.state === 'browser' && row.sendAuthorizedAt === undefined && row.requiresAuthorization === true &&
          Date.now() - (row.offeredAt ?? row.createdAt) >= (row.attachments?.length || companion?.attachments?.length ? 720_000 : row.images?.length || companion?.images?.length ? 120_000 : 60_000)) {
        // A never-authorized Continue still owes delivery. Retain its ticket and pickup budget, but never replay a possibly consumed Stop after losing a page.
        if (row.recovery) return runtime.releaseRecoveryClaim(row);
        return { ...row, state: 'cancelled', error: row.requiresAuthorization && row.sendAuthorizedAt === undefined
          ? 'Not sent: browser preparation timed out. This attempt was cancelled.'
          : UNCONFIRMED_SEND };
      }
      // An authorized claim that never reports its outcome is already unsendable: a browser row past authorization is not preparable, so no path re-offers or replays it. Left in place it still owns its whole session, so every later message waits behind an outcome nobody will ever publish. Retire it visibly after a bounded wait. Automatic Continue, an opening's first send and a combined delivery keep their existing custody.
      if (row.state === 'browser' && row.sendAuthorizedAt !== undefined && !row.recovery && !row.opening &&
          !row.companionInputId && manualInput(row) && Date.now() - row.sendAuthorizedAt >= UNCERTAIN_SEND_MS)
        return { ...row, state: 'cancelled', error: UNCONFIRMED_SEND };
      if (row.state === 'browser' && row.sendAuthorizedAt !== undefined && Date.now() - row.sendAuthorizedAt >= ABANDONED_SEND_MS)
        return { ...row, state: 'cancelled', error: UNCONFIRMED_SEND };
      return row;
    }));
    for (let i = 0; i < next.length; i++) {
      const root = companionOf(next, next[i]!);
      if (root && root.state !== next[i]!.state) next[i] = { ...next[i]!, state: root.state, error: root.error };
    }
    if (next.some((row, index) => row !== current[index])) {
      await runtime.commit(next);
      for (const [index, row] of next.entries()) if (row.recovery && row.state === 'cancelled' &&
        current[index]?.state !== 'cancelled')
        runtime.logInfo(`input ${row.id}: ${row.error ?? 'Automatic Continue wait retired after its session left the chat.'} conversation=${row.conversationId} turn=${row.silenceBoundary?.turnId}`);
    }
    return runtime.currentEntries();
  }

  return { expireQueued };
}
