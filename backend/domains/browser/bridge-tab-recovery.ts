import type { AgentInfo, SessionSummary } from '../../../contracts/session.js';
import type { WorkerRevival } from '../automation/agents.js';
import type { Command } from './command-broker/model.js';
import type { Repair } from './bridge-recovery-types.js';

export interface BridgeTabRecoveryRuntime {
  bridgeLifecycleEpoch(): number;
  bridgeShutdownRequested(): boolean;
  commands(): readonly Command[];
  revivalDeliveryProven(command: Command): boolean;
  revivalFor(agent: string, runId: string): WorkerRevival | null;
  isConversationLive(conversationId: string): boolean;
  findSession(conversationId: string, requireUnique?: boolean): Promise<SessionSummary | null>;
  agentInfo(conversationId: string): AgentInfo | null;
  liveAgent(conversationId: string): AgentInfo | null;
  hasPendingWorkerRevival(conversationId: string, runId?: string): boolean;
  departureAllowsRepair(session: SessionSummary): boolean;
  tabRecoveryWanted(conversationId: string): boolean;
  goalActiveFor(conversationId: string): boolean;
  hasGoalReply(conversationId: string): boolean;
  hasPendingCompaction(conversationId: string): boolean;
  hasCurrentWork(conversationId: string, now: number): boolean;
  queueBrowserRecovery(
    conversationId: string,
    sessionId: string,
    episode: string,
    reason: Repair['reason'],
    endedTurns: number,
    now: number
  ): boolean;
  noticeRefusal(key: string, message: string): void;
  logInfo(message: string): void;
}

// Owns the eligibility checks for reopening closed tabs and reloading stalled tabs.
export function createBridgeTabRecovery(runtime: BridgeTabRecoveryRuntime) {
  async function askForTheTabToWakeIn(command: Command, lifecycle: number): Promise<void> {
    const spec = command.spec;
    if (spec.type !== 'revive') return;
    const current = (): boolean => {
      if (runtime.bridgeLifecycleEpoch() !== lifecycle || runtime.bridgeShutdownRequested() ||
          !runtime.commands().includes(command) || command.owner !== null || runtime.revivalDeliveryProven(command)) return false;
      const revival = runtime.revivalFor(spec.agent, spec.runId);
      return revival?.conversationId === spec.conversationId && revival.messageIds.length > 0 &&
        !runtime.isConversationLive(spec.conversationId);
    };
    if (!current()) return;
    const session = await runtime.findSession(spec.conversationId, true);
    if (!current() || !session || session.conversationId !== spec.conversationId ||
        !runtime.departureAllowsRepair(session) || !runtime.tabRecoveryWanted(spec.conversationId) ||
        (!session.activeTurnId && session.lastTurnOutcome === 'stopped')) return;
    if (runtime.queueBrowserRecovery(spec.conversationId, session.id, `no-tab:wake:${command.id}`, 'no-tab', 0, Date.now())) {
      runtime.logInfo(`bridge: ${spec.agent} (${spec.conversationId}) has no tab for its pending wake — asking the browser to open it once`);
    }
  }

  async function queueMissingTab(conversationId: string, working: boolean, now = Date.now()): Promise<void> {
    const session = await runtime.findSession(conversationId);
    const agent = runtime.agentInfo(conversationId);
    const slot = runtime.liveAgent(conversationId);
    const name = agent ? `${agent.id} (${conversationId})` : conversationId;
    const declined = (reason: string): void => {
      runtime.noticeRefusal(`no-tab:${conversationId}:${reason}`, `bridge: ${name} closed its last tab — not reopened: ${reason}`);
    };
    if (!session) return;
    if (!runtime.departureAllowsRepair(session)) return declined('the user closed its page');
    if (!session.activeTurnId && session.lastTurnOutcome === 'stopped') return declined('the user stopped its turn');
    if (!runtime.tabRecoveryWanted(conversationId)) return declined('tab recovery is off for this chat');
    const wakePending = slot?.state === 'waking' && runtime.hasPendingWorkerRevival(conversationId, slot.runId);
    if (slot && slot.state !== 'detached' && !wakePending)
      return declined(`its ${slot.role} slot is ${slot.state}, not working`);
    if (!slot && !runtime.goalActiveFor(conversationId) && (session.toolCalls ?? 0) === 0)
      return declined('it has never called a tool');
    if (!working && slot?.role !== 'worker' && !(runtime.goalActiveFor(conversationId) && runtime.hasGoalReply(conversationId)))
      return declined('no turn is running in it');
    const wentAt = slot?.detachedAt ?? session.endedAt ?? now;
    if (runtime.queueBrowserRecovery(conversationId, session.id, `no-tab:${wentAt}`, 'no-tab', 0, now)) {
      runtime.logInfo(`bridge: ${name} has no tab — asking the browser to open the exact chat once`);
    } else {
      declined('a browser action for it is already pending');
    }
  }

  async function queueStalledTabRecovery(conversationId: string, now = Date.now()): Promise<void> {
    const agent = runtime.agentInfo(conversationId);
    const session = await runtime.findSession(conversationId, true);
    const name = agent ? `${agent.id} (${conversationId})` : conversationId;
    const declined = (reason: string): void => {
      runtime.noticeRefusal(`stalled:${conversationId}:${reason}`, `bridge: ${name} is a stalled browser tab — not reloaded: ${reason}`);
    };
    if (!session) return;
    if (!runtime.departureAllowsRepair(session)) return declined('the user closed its page');
    const compacting = runtime.hasPendingCompaction(conversationId);
    if (!compacting && !runtime.tabRecoveryWanted(conversationId)) return declined('tab recovery is off for this chat');
    if (agent && agent.state !== 'detached' && agent.state !== 'active' && agent.state !== 'waking')
      return declined(`its ${agent.role} slot is ${agent.state}, not working`);
    if (!agent && !compacting && !runtime.goalActiveFor(conversationId) && (session.toolCalls ?? 0) === 0)
      return declined('it has never called a tool');
    const working = runtime.hasCurrentWork(conversationId, now);
    if (!working && !compacting && agent?.role !== 'worker' &&
        !(runtime.goalActiveFor(conversationId) && runtime.hasGoalReply(conversationId))) {
      return declined('no turn is running in it');
    }
    if (runtime.queueBrowserRecovery(conversationId, session.id, `stalled:${now}`, 'stalled', 0, now)) {
      runtime.logInfo(`bridge: ${name} is a stalled browser tab — asking the browser to reload the exact chat once`);
    } else {
      declined('a browser action for it is already pending');
    }
  }

  return { askForTheTabToWakeIn, queueMissingTab, queueStalledTabRecovery };
}
