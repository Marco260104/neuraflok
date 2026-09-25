import type { ActivityGrant } from './session-activity.js';
import type { Repair } from './bridge-recovery-types.js';
import type { StopNoticeText } from '../../../contracts/stop-notice.js';

type SilenceState = {
  sessionId: string;
  outcome: 'failed' | 'stalled';
};

export interface BridgeSilenceMonitorRuntime {
  activeUntil: Map<string, ActivityGrant>;
  awaitingReturn: Set<string>;
  BROWSER_RECOVERY_COOLDOWN_MS: number;
  failedTurnQuiet: Map<string, SilenceState>;
  GOAL_QUIET_MS: number;
  PRO_ACTIVITY_MS: number;
  repairsInFlight: Map<string, Repair>;
  TURN_SCOPED_REPAIRS: ReadonlySet<Repair['reason']>;
  UNKNOWN_CALL_HOLD_MS: number;
  activityDeadline(grant: ActivityGrant): number;
  armSilenceSweep(now: number): void;
  changed(): void;
  extendedSilenceWindowFor(conversationId: string, sessionId: string): Promise<boolean>;
  forgetActivity(conversationId: string): void;
  hasQueuedAfterTurnInput(sessionId: string): Promise<boolean>;
  isChatBlocked(conversationId: string): boolean;
  logInfo(message: string): void;
  logWarn(message: string): void;
  loopAfterTurnFor(conversationId: string): boolean;
  noteSilence(conversationId: string, grant: ActivityGrant, detail: string): void;
  noticeChatStopped(title: StopNoticeText, body: StopNoticeText, sessionId: string): void;
  lastBrowserRecoveryAt: Map<string, number>;
  pendingContinuations(): readonly { from: string }[];
  queueBrowserRecovery(
    conversationId: string,
    sessionId: string,
    episode: string,
    reason: Repair['reason'],
    endedTurns: number,
    now: number
  ): boolean;
  recordNote(sessionId: string, text: string): Promise<void>;
  recoveryInputAllowed(sessionId: string, conversationId: string): boolean;
  runningToolCalls(conversationId: string): number;
  silenceHeldByCalls(
    conversationId: string,
    grant: ActivityGrant | undefined,
    now: number,
    measure: boolean
  ): 'own' | 'unknown' | null;
  silenceSourceCurrent(conversationId: string, grant: ActivityGrant): Promise<boolean>;
  silenceWindowMs(grant: ActivityGrant): number;
  tabRecoveryWanted(conversationId: string): boolean;
  turnHasMcpCall(sessionId: string, conversationId: string, turnId: string): Promise<boolean>;
}

export function createBridgeSilenceMonitor(runtime: BridgeSilenceMonitorRuntime) {
  async function inspectSilentChats(now: number): Promise<{ queued: boolean; spent: string[] }> {
    let queued = false;
    let deferred = false;
    const spent: string[] = [];
    const compacting = new Set(runtime.pendingContinuations().map(entry => entry.from));
    for (const [conversationId, grant] of runtime.activeUntil) {
      if (grant.until > now) continue;
      if (compacting.has(conversationId)) {
        runtime.noteSilence(conversationId, grant, 'a Compact & Resume handoff owns this chat\'s recovery');
        continue;
      }
      if (!grant.turnId || !await runtime.turnHasMcpCall(grant.sessionId, conversationId, grant.turnId)) {
        if (runtime.activeUntil.get(conversationId) === grant) {
          runtime.noteSilence(conversationId, grant, grant.turnId
            ? `not available: turn ${grant.turnId} has no tool call recorded for this chat (provider page tool calls may not be attributed)`
            : 'not available: the silent work has no turn');
          spent.push(conversationId);
        }
        continue;
      }
      const pro = await runtime.extendedSilenceWindowFor(conversationId, grant.sessionId);
      const afterTurn = runtime.recoveryInputAllowed(grant.sessionId, conversationId) || runtime.loopAfterTurnFor(conversationId) ||
        await runtime.hasQueuedAfterTurnInput(grant.sessionId);
      if (runtime.activeUntil.get(conversationId) !== grant) continue;
      const heldBy = runtime.silenceHeldByCalls(conversationId, grant, now, true);
      if (heldBy === 'own' || (afterTurn && heldBy === 'unknown')) {
        runtime.noteSilence(conversationId, grant, heldBy === 'own'
          ? 'waiting: a tool call of this chat is still running'
          : 'waiting: a tool call whose chat is not known yet is running, and it might be this chat\'s');
        grant.until = now + runtime.GOAL_QUIET_MS;
        deferred = true;
        continue;
      }
      if (afterTurn && runtime.runningToolCalls(conversationId) > 0) {
        runtime.noteSilence(conversationId, grant,
          `going ahead: tool calls whose chat is not known have held it for ${runtime.UNKNOWN_CALL_HOLD_MS / 60_000} minutes while it stayed silent`);
      }
      if (runtime.isChatBlocked(conversationId)) {
        runtime.noteSilence(conversationId, grant, 'not available: this chat is blocked');
        spent.push(conversationId);
        continue;
      }
      if ((afterTurn || runtime.tabRecoveryWanted(conversationId) || grant.thinkingFailed) &&
          now < grant.evidenceAt + runtime.silenceWindowMs(grant)) {
        grant.until = grant.evidenceAt + runtime.silenceWindowMs(grant);
        deferred = true;
        continue;
      }
      if (!grant.thinkingFailed && !runtime.tabRecoveryWanted(conversationId) && !afterTurn) {
        if (now < runtime.activityDeadline(grant)) {
          deferred = true;
          continue;
        }
        runtime.noteSilence(conversationId, grant,
          'not available: automatic recovery is off for this chat and no Goal, Loop or queued message waits on it');
        spent.push(conversationId);
        continue;
      }
      const held = runtime.repairsInFlight.get(conversationId);
      if (held?.state === 'done' && !runtime.TURN_SCOPED_REPAIRS.has(held.reason)) {
        if (!grant.thinkingFailed && pro && now < grant.evidenceAt + runtime.PRO_ACTIVITY_MS) {
          grant.until = grant.evidenceAt + runtime.PRO_ACTIVITY_MS;
          deferred = true;
          continue;
        }
        runtime.noteSilence(conversationId, grant, `spent: its ${held.reason} reload already happened`);
        spent.push(conversationId);
        continue;
      }
      if (held && !runtime.TURN_SCOPED_REPAIRS.has(held.reason)) continue;
      const lastReload = runtime.lastBrowserRecoveryAt.get(conversationId) ?? 0;
      if (runtime.awaitingReturn.has(conversationId) && now - lastReload < runtime.BROWSER_RECOVERY_COOLDOWN_MS) {
        runtime.noteSilence(conversationId, grant, 'waiting: the page has not come back from the last reload yet');
        grant.until = lastReload + runtime.BROWSER_RECOVERY_COOLDOWN_MS;
        deferred = true;
        continue;
      }
      if (!await runtime.silenceSourceCurrent(conversationId, grant)) {
        if (runtime.activeUntil.get(conversationId) === grant) {
          if (!grant.thinkingFailed && now < runtime.activityDeadline(grant)) deferred = true;
          else {
            runtime.noteSilence(conversationId, grant,
              'spent: the silent work is no longer this chat\'s current turn (a newer question, a close or a Stop)');
            spent.push(conversationId);
          }
        }
        continue;
      }
      if (runtime.activeUntil.get(conversationId) !== grant) continue;
      if (runtime.queueBrowserRecovery(conversationId, grant.sessionId, `silence:${grant.until}`, 'silence', 0, now)) {
        queued = true;
        runtime.logInfo(`bridge: active chat silent for ${runtime.silenceWindowMs(grant) / 60_000} minutes — asking the browser to reload ${conversationId} once`);
      }
    }
    if (deferred) runtime.armSilenceSweep(now);
    return { queued, spent };
  }

  function finishSilentChats(conversationIds: readonly string[]): void {
    for (const conversationId of conversationIds) {
      const quiet = runtime.failedTurnQuiet.get(conversationId);
      if (quiet) {
        const { sessionId, outcome } = quiet;
        runtime.failedTurnQuiet.delete(conversationId);
        void runtime.recordNote(
          sessionId,
          outcome === 'stalled'
            ? 'This chat stopped: its last turn ran for ten minutes without producing anything and nothing ' +
              'followed it. Send a message here to start a fresh turn, or continue in a new chat.'
            : 'This chat stopped: its last turn ended in a transport failure and nothing followed it. ' +
              'Send a message here to start a fresh turn, or continue in a new chat.'
        ).catch(() => undefined);
        runtime.noticeChatStopped(
          'A chat stopped',
          outcome === 'stalled'
            ? 'Its last turn produced nothing and nothing followed. Send a message there to start a fresh turn.'
            : 'Its last turn failed and nothing followed. Send a message there to start a fresh turn.',
          sessionId
        );
        runtime.logWarn(`bridge: ${conversationId} stopped after a ${outcome} turn with nothing following it`);
      }
      runtime.forgetActivity(conversationId);
      const repair = runtime.repairsInFlight.get(conversationId);
      if (repair?.reason !== 'goal' && repair?.reason !== 'unattributed' &&
          (repair?.reason !== 'silence' || repair.state !== 'done' || !repair.progress?.turnId)) {
        runtime.repairsInFlight.delete(conversationId);
      }
    }
    if (conversationIds.length) runtime.changed();
  }

  return { inspectSilentChats, finishSilentChats };
}
