import type { SessionSummary } from '../../../contracts/session.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { runningToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { agentInfoForOwnedConversation, isWorkerConversation, retiredWorkerForConversation, swarmState } from '../automation/agents.js';
import { goalDraftBusy } from '../automation/goal.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { continuationForSession } from '../sessions/continuity/continuation.js';
import { getSession, readCompletedFinal, readRecoveryBoundary, turnHasMcpCall } from '../sessions/history/store.js';
import { buildBrowserTabPolicy } from './bridge-tab-policy.js';
import type { Repair } from './bridge-recovery-types.js';
import { activeUntil } from './session-activity.js';
import type { ActivityGrant } from './session-activity.js';
import type { bridgeRecoveryControlRuntime } from './bridge.js';

type Runtime = typeof bridgeRecoveryControlRuntime;
type Continuation = NonNullable<ReturnType<typeof continuationForSession>>;
type Pickup = { replyId: string; listenUntil: number; queued: boolean };
type PickupWatch = { replyId: string; expiresAt: number };

interface Dependencies {
  runtime: Runtime;
  repairsInFlight: Map<string, Repair>;
  getPickupWatch(conversationId: string): PickupWatch | undefined;
  getPickupWatchCount(): number;
  getCompactionWatchCount(): number;
  owedPickups(now: number): Promise<{ get(conversationId: string): Pickup | undefined }>;
  compactionPhaseOf(entry: Continuation): string;
  silenceHeldByCalls(conversationId: string, grant: ActivityGrant | undefined): 'own' | 'unknown' | null;
  armSilenceSweep(): void;
}

// Owns the shared eligibility and freshness decisions used by browser recovery.
export function createBridgeRecoveryPolicy(dependencies: Dependencies) {
  const { runtime, repairsInFlight } = dependencies;

  function departureAllowsRepair(session: SessionSummary): boolean {
    return session.browserRecoveryDismissedAt === undefined;
  }

  function departureAllowsRepairFor(session: SessionSummary, reason: Repair['reason'], episode: string): boolean {
    return departureAllowsRepair(session) || (reason === 'compaction' && episode.endsWith(':manual'));
  }

  function workerRecoveryAllowed(conversationId: string): boolean {
    const agent = agentInfoForOwnedConversation(conversationId);
    if (agent?.role === 'worker') return ['active', 'detached', 'waking'].includes(agent.state);
    return !isWorkerConversation(conversationId) && !retiredWorkerForConversation(conversationId);
  }

  function retireInactiveWorkerRecovery(): void {
    let retired = false;
    for (const id of new Set([...activeUntil.keys(), ...repairsInFlight.keys()])) {
      if (workerRecoveryAllowed(id)) continue;
      retired = activeUntil.delete(id) || retired;
      retired = repairsInFlight.delete(id) || retired;
      runtime.awaitingReturn.delete(id);
    }
    if (retired) {
      dependencies.armSilenceSweep();
      runtime.changed();
    }
  }

  function repairNeedsClaim(repair: Repair): boolean {
    return ['unattributed', 'assistant-error', 'silence', 'no-tab', 'stalled', 'goal', 'compaction'].includes(repair.reason);
  }

  function compactionRepairCurrent(conversationId: string, repair: Repair): boolean {
    if (repair.reason !== 'compaction') return true;
    const entry = continuationForSession(repair.sessionId);
    return !!entry && entry.from === conversationId && entry.state === 'awaiting-summary' &&
      repair.episode.startsWith(`compaction:${entry.token}:${dependencies.compactionPhaseOf(entry)}:`);
  }

  async function silenceRepairCurrent(conversationId: string, repair: Repair): Promise<boolean> {
    if (repair.reason === 'goal' && repair.state !== 'done') {
      const watch = dependencies.getPickupWatch(conversationId);
      const pickup = (await dependencies.owedPickups(Date.now())).get(conversationId);
      return !!watch && !!pickup && pickup.replyId === watch.replyId &&
        Date.now() >= pickup.listenUntil && Date.now() < watch.expiresAt &&
        (!pickup.queued ? !goalDraftBusy(conversationId) : true) &&
        runningToolCalls(conversationId) === 0 && !continuationForSession(repair.sessionId) &&
        dependencies.getPickupWatch(conversationId) === watch && repairsInFlight.get(conversationId) === repair;
    }
    if (repair.reason !== 'silence' || repair.state === 'done') return true;
    const grant = repair.silenceGrant;
    const current = () => !!grant?.turnId && activeUntil.get(conversationId) === grant &&
      repairsInFlight.get(conversationId) === repair && !runtime.stopRequestedFor(conversationId) &&
      !isChatBlocked(conversationId) && !continuationForSession(repair.sessionId) &&
      !dependencies.silenceHeldByCalls(conversationId, grant);
    if (!current()) return false;
    return await silenceSourceCurrent(conversationId, grant!) && current();
  }

  async function silenceSourceCurrent(conversationId: string, grant: ActivityGrant): Promise<boolean> {
    if (!grant.turnId || !await turnHasMcpCall(grant.sessionId, conversationId, grant.turnId) ||
        await readCompletedFinal(grant.sessionId, conversationId, grant.turnId)) return false;
    const boundary = await readRecoveryBoundary(grant.sessionId, grant.turnId);
    const session = await getSession(grant.sessionId);
    return session?.conversationId === conversationId && session.endedAt === null && session.browserRecoveryDismissedAt === undefined &&
      !isChatBlocked(conversationId) && !runtime.stopRequestedFor(conversationId) &&
      (!session.activeTurnId || session.activeTurnId === grant.turnId) &&
      !!boundary && boundary.kind !== 'user_message' && boundary.turnId === grant.turnId &&
      !(boundary.kind === 'turn_end' && boundary.outcome === 'stopped');
  }

  function noteRecoveryActivity(conversationId: string): void {
    const held = repairsInFlight.get(conversationId);
    if (!held || held.reason === 'unattributed' || held.reason === 'assistant-error') return;
    repairsInFlight.delete(conversationId);
  }

  async function browserTabPolicy(openConversations: Set<string>) {
    return buildBrowserTabPolicy(openConversations, runtime.goalActiveFor);
  }

  function tabRecoveryWanted(conversationId: string): boolean {
    return runtime.goalActiveFor(conversationId) || getConfig().multiAgent.recoverAgentTabs;
  }

  function browserRecoveryMonitoring(): boolean {
    if (repairsInFlight.size > 0 || activeUntil.size > 0 || dependencies.getPickupWatchCount() > 0 || dependencies.getCompactionWatchCount() > 0) return true;
    return swarmState().agents.some(agent =>
      Boolean(agent.conversationId) &&
      (agent.state === 'active' || agent.state === 'waking') &&
      tabRecoveryWanted(agent.conversationId as string)
    );
  }

  return {
    departureAllowsRepair,
    departureAllowsRepairFor,
    workerRecoveryAllowed,
    retireInactiveWorkerRecovery,
    repairNeedsClaim,
    compactionRepairCurrent,
    silenceRepairCurrent,
    silenceSourceCurrent,
    noteRecoveryActivity,
    browserTabPolicy,
    tabRecoveryWanted,
    browserRecoveryMonitoring
  };
}
