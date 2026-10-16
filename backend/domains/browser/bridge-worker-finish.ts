import type { ChatObservation } from '../sessions/history/recorder.js';
import type { Command } from './command-broker/model.js';

export interface BridgeWorkerFinishRuntime {
  commands: Command[];
  agentInfoForOwnedConversation: typeof import('../automation/agents.js').agentInfoForOwnedConversation;
  readRecentEvents: typeof import('../sessions/history/store.js').readRecentEvents;
  revivalDeliveryProven(command: Command): boolean;
  noteAgentAlive: typeof import('../automation/agents.js').noteAgentAlive;
  readCompletedFinal: typeof import('../sessions/history/store.js').readCompletedFinal;
  turnEndedDurably: typeof import('../sessions/history/store.js').turnEndedDurably;
  reactivateSilentCeilingRunForTerminal: typeof import('../automation/agents.js').reactivateSilentCeilingRunForTerminal;
  stageWorkerConversationFinish: typeof import('../automation/agents.js').stageWorkerConversationFinish;
  persistCriticalSwarmNow: typeof import('../automation/agents.js').persistCriticalSwarmNow;
  recordAgentMessage: typeof import('../sessions/history/recorder.js').recordAgentMessage;
  afterFinish(agentId: string, runId: string): Promise<void>;
  releaseQuiescentRun(runId: string): void;
  logWarn: typeof import('../../infrastructure/settings/logger.js').logWarn;
}

export function createBridgeWorkerFinish(runtime: BridgeWorkerFinishRuntime) {
  async function reconcileDeliveredWorkerTurn(conversationId: string, sessionId: string): Promise<boolean> {
    const worker = runtime.agentInfoForOwnedConversation(conversationId);
    if (worker?.role !== 'worker' || !['waking', 'active'].includes(worker.state) || !worker.lastRevivalCommandId) return false;
    const command = runtime.commands.find(row => row.id === worker.lastRevivalCommandId && row.spec.type === 'revive' &&
      row.spec.conversationId === conversationId && row.spec.runId === worker.runId && row.spec.agent === worker.id);
    if (!command || command.claimedAt === null || !runtime.revivalDeliveryProven(command)) return false;
    const { spec, claimedAt, createdAt, owner } = command;
    const recent = await runtime.readRecentEvents(sessionId, 256, { kinds: ['turn_start'], agent: worker.id });
    const start = [...recent].reverse().find(row => row.kind === 'turn_start' &&
      row.time >= claimedAt && row.time > (worker.sleptAt ?? 0));
    // A wake cannot bind turn evidence after its command or worker incarnation changes during the read.
    const current = runtime.agentInfoForOwnedConversation(conversationId);
    if (!start || !current || !runtime.commands.includes(command) || command.spec !== spec || command.claimedAt !== claimedAt ||
        command.createdAt !== createdAt || command.owner !== owner || current.runId !== worker.runId ||
        current.state !== worker.state || current.sleptAt !== worker.sleptAt ||
        current.lastRevivalCommandId !== worker.lastRevivalCommandId || !runtime.revivalDeliveryProven(command)) return false;
    runtime.noteAgentAlive(conversationId, 'turn', start.time);
    return true;
  }

  async function workerFinalAcrossBatches(
    sessionId: string,
    conversationId: string,
    observations?: readonly ChatObservation[]
  ): Promise<string | null> {
    if (observations && !observations.some(entry => entry.kind === 'turn_end' ||
        (entry.kind === 'assistant_message' && (entry.final === true || entry.state === 'final')))) return null;
    const final = await runtime.readCompletedFinal(sessionId, conversationId);
    return final ? final.text || 'Worker completed its native final answer.' : null;
  }

  async function reconcileWorkerFinish(
    conversationId: string,
    sessionId: string,
    observations?: readonly ChatObservation[]
  ): Promise<boolean> {
    const deliveredTurn = await reconcileDeliveredWorkerTurn(conversationId, sessionId);
    if (!observations && !deliveredTurn) return true;
    let worker = runtime.agentInfoForOwnedConversation(conversationId);
    if (worker?.role !== 'worker') return true;
    let retainedTerminalText: string | null = null;
    if (worker.state === 'sleeping' && worker.silenceParked && !worker.revivable) {
      const completed = await runtime.readCompletedFinal(
        sessionId,
        conversationId,
        worker.silenceRecoveryTurnId ?? undefined
      );
      const observedEndTurn = observations
        ? [...observations].reverse().find(
            (entry) => entry.kind === 'turn_end' && typeof entry.turnId === 'string' && entry.turnId.length > 0
          )?.turnId ?? null
        : null;
      const terminalTurn = worker.silenceRecoveryTurnId ?? observedEndTurn;
      const ended = completed
        ? true
        : Boolean(terminalTurn && await runtime.turnEndedDurably(sessionId, conversationId, terminalTurn));
      if (!ended || !runtime.reactivateSilentCeilingRunForTerminal(conversationId)) return true;
      retainedTerminalText = completed?.text || 'Worker turn ended without a canonical final answer.';
      worker = runtime.agentInfoForOwnedConversation(conversationId);
    }
    if (!worker || (!retainedTerminalText && !['active', 'detached', 'invited'].includes(worker.state))) return true;
    const finalText = retainedTerminalText ?? await workerFinalAcrossBatches(sessionId, conversationId, observations);
    const current = runtime.agentInfoForOwnedConversation(conversationId);
    if (!finalText || !current || current.runId !== worker.runId || current.state !== worker.state ||
        current.sleptAt !== worker.sleptAt || current.lastRevivalCommandId !== worker.lastRevivalCommandId) return true;
    const staged = runtime.stageWorkerConversationFinish(conversationId, finalText);
    if (!staged?.report) return true;
    try {
      if (!(await runtime.persistCriticalSwarmNow())) {
        staged.rollback();
        return false;
      }
    } catch (err) {
      staged.rollback();
      runtime.logWarn(`bridge: final state for worker conversation ${conversationId} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    staged.commit();
    await runtime.recordAgentMessage(staged.report, 'sent', conversationId);
    if (staged.info.runId) {
      await runtime.afterFinish(worker.id, staged.info.runId);
      runtime.releaseQuiescentRun(staged.info.runId);
    }
    return true;
  }

  return { reconcileDeliveredWorkerTurn, reconcileWorkerFinish };
}
