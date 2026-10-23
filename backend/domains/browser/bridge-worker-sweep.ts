import { blockedChatIds, isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { inFlightMcpRequests, runningToolProgress } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { logWarn } from '../../infrastructure/settings/logger.js';
import {
  activeRunIds,
  finishSilentCeilingWorker,
  finishWorkerConversation,
  occupiesSlot,
  persistCriticalSwarmNow,
  releaseQuiescentRun,
  requestWorkerRevivals,
  sleepSilentWorkers,
  sleepWorker,
  stageQueuedWorkerRevivals,
  swarmRunning,
  swarmState,
  swarmTransferActive
} from '../automation/agents.js';
import {
  findSessionByConversation,
  readRecentEvents,
  requestTurnOwnershipCutoff,
  sessionDurableModifiedAt
} from '../sessions/history/store.js';
import { liveConversations, recordAgentMessage } from '../sessions/history/recorder.js';
import { isLocalProviderTurnQueued } from '../sessions/input/local-executor-activity.js';

export const STALE_SWARM_MS = 2 * 60_000;

interface DurableQuiescence {
  quiescent: boolean;
  ended: boolean;
  lastOutcome: string | null;
}

interface Runtime {
  getObservationWritesInFlight(): number;
  inspectSilentChats(now: number): Promise<{ queued: boolean; spent: string[] }>;
  fileSilenceTickets(spent: readonly string[], now: number): Promise<void>;
  inspectOwedPickups(now: number): Promise<boolean>;
  inspectOwedCompactions(now: number): Promise<boolean>;
  finishSilentChats(conversationIds: readonly string[]): void;
}

export function createBridgeWorkerSweep(runtime: Runtime) {
  async function wakeQueuedStoppedWorkers(ids: readonly string[], runId: string): Promise<void> {
    const staged = stageQueuedWorkerRevivals(ids, runId);
    if (staged.waking.length === 0) return;
    try {
      if (!(await persistCriticalSwarmNow())) {
        staged.rollback();
        logWarn('multi-agent: queued work could not reserve a durable revival after its worker stopped');
        return;
      }
      staged.commit();
      requestWorkerRevivals(staged.waking, runId);
    } catch (err) {
      staged.rollback();
      logWarn(`multi-agent: queued work could not reserve a durable revival after its worker stopped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function durableQuiescence(conversationId: string, now: number): Promise<DurableQuiescence> {
    const live = liveConversations().find(entry => entry.conversationId === conversationId);
    if (live?.generating) return { quiescent: false, ended: false, lastOutcome: null };
    const summary = await findSessionByConversation(conversationId, { requireUnique: true });
    if (!summary) return { quiescent: false, ended: false, lastOutcome: null };
    const modifiedAt = await sessionDurableModifiedAt(summary.id);
    const lastDurableWrite = Math.max(summary.updatedAt, summary.endedAt ?? 0, modifiedAt ?? 0);
    if (lastDurableWrite <= 0 || now - lastDurableWrite < STALE_SWARM_MS) {
      return { quiescent: false, ended: summary.endedAt !== null, lastOutcome: summary.lastTurnOutcome };
    }

    let lastOutcome: string | null = summary.lastTurnOutcome;
    if (summary.activeTurnId) return { quiescent: false, ended: summary.endedAt !== null, lastOutcome };
    if (summary.activeTurnId === undefined) {
      const openTurns = new Set<string>();
      for (const event of await readRecentEvents(summary.id, 4096, { kinds: ['turn_start', 'turn_end'] })) {
        if (event.kind === 'turn_start' && event.turnId) openTurns.add(event.turnId);
        else if (event.kind === 'turn_end') {
          if (event.turnId) openTurns.delete(event.turnId);
          lastOutcome = event.outcome;
        }
      }
      if (openTurns.size > 0) return { quiescent: false, ended: summary.endedAt !== null, lastOutcome };
    }
    if (summary.endedAt !== null) return { quiescent: true, ended: true, lastOutcome };

    const recentWork = await readRecentEvents(summary.id, 256, {
      kinds: ['turn_start', 'turn_end', 'user_message', 'assistant_message', 'tool_call', 'page_tool']
    });
    const latest = recentWork.at(-1);
    if (!latest || latest.kind !== 'turn_end') return { quiescent: false, ended: false, lastOutcome };
    lastOutcome = latest.outcome;
    return { quiescent: true, ended: false, lastOutcome };
  }

  async function sweepStaleSwarm(now = Date.now()): Promise<boolean> {
    let brokerChanged = false;
    if (runtime.getObservationWritesInFlight() === 0) {
      for (const conversationId of blockedChatIds()) {
        const finished = finishSilentCeilingWorker(conversationId, 'The user blocked its chat, so its tools are refused and its unresolved turn was abandoned.');
        if (!finished) continue;
        if (finished.report) await recordAgentMessage(finished.report, 'sent', finished.info.conversationId);
        brokerChanged = true;
      }
      for (const runId of activeRunIds()) {
        if (swarmTransferActive(runId)) continue;
        brokerChanged = await sweepOwnedSwarm(runId, now) || brokerChanged;
      }
    }
    const silent = await runtime.inspectSilentChats(now);
    await runtime.fileSilenceTickets(silent.spent, now);
    const goalsQueued = await runtime.inspectOwedPickups(now);
    const compactionsQueued = await runtime.inspectOwedCompactions(now);
    const silenceChanged = silent.queued || silent.spent.length > 0 || goalsQueued || compactionsQueued;
    runtime.finishSilentChats(silent.spent);
    return silenceChanged || brokerChanged;
  }

  async function sweepOwnedSwarm(runId: string, now: number): Promise<boolean> {
    let state = swarmState(runId);
    if (!state.running) return false;
    const stoppedWorkers: string[] = [];
    for (const agent of state.agents) {
      if (agent.role !== 'worker' || !occupiesSlot(agent.state) || !agent.conversationId) continue;
      if (!isChatBlocked(agent.conversationId)) continue;
      const slept = sleepWorker(agent.id, 'The user blocked its chat, so its tools are refused, no browser recovery was attempted and its open turn was abandoned.', runId);
      if (!slept) continue;
      if (slept.report) await recordAgentMessage(slept.report, 'sent', slept.info.conversationId);
      stoppedWorkers.push(agent.id);
      runtime.finishSilentChats([agent.conversationId]);
    }

    const unresolvedTurns = new Map<string, { turnId: string | null; requestOriginMax: number | null }>();
    await Promise.all(state.agents
      .filter(agent => agent.role === 'worker' && agent.conversationId && (agent.state === 'active' || agent.state === 'detached'))
      .map(async agent => {
        const session = await findSessionByConversation(agent.conversationId!, { requireUnique: true });
        if (session) {
          unresolvedTurns.set(agent.conversationId!, {
            turnId: session.activeTurnId ?? null,
            requestOriginMax: await requestTurnOwnershipCutoff(session.id, agent.conversationId!)
          });
        }
      }));
    for (const slept of sleepSilentWorkers(
      now,
      runId,
      id => runningToolProgress(id) !== null || isLocalProviderTurnQueued(id),
      id => unresolvedTurns.get(id)?.turnId,
      id => unresolvedTurns.get(id)?.requestOriginMax
    )) {
      if (slept.report) await recordAgentMessage(slept.report, 'sent', slept.info.conversationId);
      stoppedWorkers.push(slept.info.id);
    }
    if (stoppedWorkers.length > 0) state = swarmState(runId);

    for (const worker of state.agents.filter(agent => agent.role === 'worker' && (agent.state === 'active' || agent.state === 'detached'))) {
      if (!worker.conversationId) continue;
      const proof = await durableQuiescence(worker.conversationId, now);
      if (!swarmRunning(runId) || swarmTransferActive(runId) || inFlightMcpRequests() > 0 || runtime.getObservationWritesInFlight() > 0) return false;
      if (!proof.quiescent) continue;
      if (proof.lastOutcome === 'completed') {
        const finished = finishWorkerConversation(worker.conversationId, 'Worker turn completed and remained durably inactive for the orphan grace period.');
        if (finished?.report) {
          await recordAgentMessage(finished.report, 'sent', finished.info.conversationId);
          stoppedWorkers.push(worker.id);
        }
      } else {
        const slept = sleepWorker(worker.id,
          proof.ended
            ? 'Its browser chat was closed and its work has been durably quiet since.'
            : `Its last browser turn ended ${proof.lastOutcome ?? 'without a completed outcome'} and it has been durably quiet since.`, runId);
        if (slept?.report) {
          await recordAgentMessage(slept.report, 'sent', slept.info.conversationId);
          stoppedWorkers.push(worker.id);
        }
      }
    }

    await wakeQueuedStoppedWorkers(stoppedWorkers, runId);
    if (!swarmRunning(runId) || swarmTransferActive(runId) || inFlightMcpRequests() > 0 || runtime.getObservationWritesInFlight() > 0) return false;
    return releaseQuiescentRun({}, runId) || stoppedWorkers.length > 0;
  }

  return { sweepStaleSwarm, wakeQueuedStoppedWorkers };
}
