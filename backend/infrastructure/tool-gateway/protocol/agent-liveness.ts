import {
  currentRunId,
  noteAgentAlive,
  persistCriticalSwarmNow,
  reactivateDormantRunForConversation,
  reactivateSilentCeilingRunForTerminal,
  recoverSilentCeilingWorker,
  requestWorkerRevivals,
  silentCeilingRecoveryAuthority,
  sleepSilentWorkers,
  stageQueuedWorkerRevivals
} from '../../../domains/automation/agents.js';
import { recordAgentMessage } from '../../../domains/sessions/history/recorder.js';
import {
  findSessionByConversation,
  requestBelongsToActiveTurn,
  requestTurnOwnershipCutoff
} from '../../../domains/sessions/history/store.js';
import { logWarn } from '../../settings/logger.js';
import { runningToolProgress, type CallContext } from './call-context.js';
import { isLocalProviderTurnQueued } from '../../../domains/sessions/input/local-executor-activity.js';

type AgentLivenessInput = {
  context: CallContext;
  isFinish: boolean;
  supersededConversation: boolean;
  accessRefused: boolean;
  requestId: string | null;
};

export async function maintainAgentLiveness(input: AgentLivenessInput): Promise<boolean> {
  const { context, isFinish, supersededConversation, accessRefused, requestId } = input;
  let silentFinishAuthorized = false;
  if (!supersededConversation && !accessRefused) {
    const conversationId = context.caller.conversationId;
    const recoveryAuthority = silentCeilingRecoveryAuthority(conversationId);
    let recovered = false;
    if (conversationId && recoveryAuthority && requestId) {
      const session = await findSessionByConversation(conversationId, { requireUnique: true });
      if (
        session &&
        await requestBelongsToActiveTurn(
          session.id,
          conversationId,
          requestId,
          recoveryAuthority.turnId,
          recoveryAuthority.requestOriginMax
        )
      ) {
        if (isFinish) {
          silentFinishAuthorized = reactivateSilentCeilingRunForTerminal(conversationId);
          recovered = silentFinishAuthorized;
        } else {
          recovered = Boolean(recoverSilentCeilingWorker(conversationId, recoveryAuthority.turnId, true));
        }
      }
    }
    if (!recovered && !isFinish) reactivateDormantRunForConversation(conversationId);
  }

  const alive = supersededConversation || accessRefused ? null : noteAgentAlive(context.caller.conversationId);
  const callerSession = !supersededConversation && !accessRefused && context.caller.conversationId
    ? await findSessionByConversation(context.caller.conversationId, { requireUnique: true }).catch(() => null)
    : null;
  const callerRequestOriginMax = callerSession && context.caller.conversationId
    ? await requestTurnOwnershipCutoff(callerSession.id, context.caller.conversationId).catch(() => null)
    : null;
  const quietWorkers = supersededConversation || accessRefused ? [] : sleepSilentWorkers(
    Date.now(),
    undefined,
    id => runningToolProgress(id) !== null || isLocalProviderTurnQueued(id),
    id => callerSession?.conversationId === id ? callerSession.activeTurnId ?? null : undefined,
    id => callerSession?.conversationId === id ? callerRequestOriginMax : undefined
  );
  for (const quiet of quietWorkers) {
    if (quiet.report) await recordAgentMessage(quiet.report, 'sent', quiet.info.conversationId);
  }
  if (alive?.report) await recordAgentMessage(alive.report, 'sent', context.caller.conversationId);

  const quietByRun = new Map<string, string[]>();
  for (const entry of quietWorkers) {
    const runId = entry.info.runId ?? (entry.info.conversationId ? currentRunId(entry.info.conversationId) : null);
    if (!runId) continue;
    quietByRun.set(runId, [...(quietByRun.get(runId) ?? []), entry.info.id]);
  }
  for (const [runId, ids] of quietByRun) {
    const deferredWake = stageQueuedWorkerRevivals(ids, runId);
    if (deferredWake.waking.length > 0) {
      try {
        if (await persistCriticalSwarmNow()) {
          deferredWake.commit();
          requestWorkerRevivals(deferredWake.waking, runId);
        } else {
          deferredWake.rollback();
          logWarn('multi-agent: could not durably reserve queued work for a worker that just fell asleep');
        }
      } catch (err) {
        deferredWake.rollback();
        logWarn(
          `multi-agent: could not durably reserve queued work for a worker that just fell asleep — ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  return silentFinishAuthorized;
}
