import { logWarn } from '../../../infrastructure/settings/logger.js';
import { PRIME_ID, agentForOwnedConversation } from '../../automation/agents.js';
import {
  clearChatWorkspace,
  moveChatWorkspace,
  workspaceForChat
} from '../../workspace/workspace.js';
import {
  clearGoalObjective,
  clearGoalSwitch,
  goalObjectiveFor,
  goalSwitchFor,
  moveGoalObjective,
  moveGoalSwitch
} from '../../automation/goal.js';
import type { Continuation } from './continuation-records.js';
import { RESUME_SHADOW_COLLISION } from './continuation-commit.js';
import { resumeBootstrapMatches } from './handoff.js';
import {
  findSessionByConversation,
  getSession,
  readEvents,
  readHandoff
} from '../history/store.js';

export interface ContinuationRecoveryHooks {
  /** Recovery-only repair after the durable session already proves A→B landed. */
  repairPrimeTransfer?: (fromConversationId: string, toConversationId: string) => boolean;
  /** Whether a sub-agent fleet is led from this chat. */
  hasPrimeFleet?: (conversationId: string) => boolean;
}

interface Runtime {
  byToken: ReadonlyMap<string, Continuation>;
  recoveryHooks: () => ContinuationRecoveryHooks;
}

export function createContinuationShadowRepair(runtime: Runtime) {
  /** Repairs prime ownership after the pre-redeem shadow-session race only when durable origin, an uncommitted handoff, and the exact authored bootstrap prove this is the intended replacement chat. */
  async function repairPrimeFromResumeShadow(conversationId: string): Promise<boolean> {
    if (!conversationId) return false;
    // A resume shadow is prime/solo history. Even otherwise convincing old provenance must never move Goal/workspace into a conversation the broker knows belongs to a worker.
    const targetOwner = agentForOwnedConversation(conversationId);
    if (targetOwner && targetOwner !== PRIME_ID) return false;
    let target;
    try {
      target = await findSessionByConversation(conversationId, { requireUnique: true });
    } catch {
      return false;
    }
    const sourceSessionId =
      target?.origin?.kind === 'resume' && typeof target.origin.fromSessionId === 'string'
        ? target.origin.fromSessionId
        : '';
    if (!target || !sourceSessionId || target.id === sourceSessionId) return false;

    const source = await getSession(sourceSessionId).catch(() => null);
    if (!source?.conversationId) return false;
    const fromConversationId = source.conversationId;
    const sourceOwner = agentForOwnedConversation(fromConversationId);
    if (sourceOwner && sourceOwner !== PRIME_ID) return false;
    // PRIME on both sides proves two separately retained/active owner records. Do not merge source projections into an independent descendant run; when recovery already moved this same run, only the target remains owned and the idempotent repair must remain possible.
    if (targetOwner === PRIME_ID && sourceOwner === PRIME_ID) return false;
    // Once this run's prime ownership is already at B and A has no Goal or workspace projection, there is nothing left for this activity poll to repair.
    if (targetOwner === PRIME_ID && !workspaceForChat(fromConversationId) && !goalObjectiveFor(fromConversationId)) {
      return false;
    }
    const failed = [...runtime.byToken.values()].find(
      (entry) =>
        entry.sessionId === sourceSessionId &&
        entry.state === 'aborted' &&
        entry.error === RESUME_SHADOW_COLLISION &&
        entry.from === fromConversationId
    );
    const handoffId = failed?.handoffId ?? source.lastHandoffId;
    if (!handoffId) return false;
    if (!failed) {
      // Terminal rows may be swept before a stranded tab closes, so legacy proof requires the source's newest handoff to remain uncommitted and the target to contain its exact bootstrap text.
      if (handoffId === source.lastCommittedResumeHandoffId) return false;
    }
    const handoff = await readHandoff(source.id, handoffId).catch(() => null);
    if (!handoff) return false;
    const targetUsers = await readEvents(target.id, { kinds: ['user_message'] }).catch(() => []);
    const exactBootstrap = targetUsers.some(
      (event) => event.kind === 'user_message' && !event.message.truncated && resumeBootstrapMatches(event.message.text, handoff.text)
    );
    if (!exactBootstrap) return false;
    const proof = failed ? `collision WAL + exact handoff ${handoffId}` : `exact handoff ${handoffId}`;

    // The proof above crosses filesystem awaits. Another activity poll or agents call can finish the same repair while this one is reading it, so ownership captured before those awaits is no longer authoritative; re-read both sides immediately before synchronous projection mutations.
    const currentTargetOwner = agentForOwnedConversation(conversationId);
    const currentSourceOwner = agentForOwnedConversation(fromConversationId);
    if (currentTargetOwner && currentTargetOwner !== PRIME_ID) return false;
    if (currentSourceOwner && currentSourceOwner !== PRIME_ID) return false;
    if (currentTargetOwner === PRIME_ID && currentSourceOwner === PRIME_ID) return false;
    if (
      currentTargetOwner === PRIME_ID &&
      !workspaceForChat(fromConversationId) &&
      !goalObjectiveFor(fromConversationId)
    ) {
      return false;
    }

    // The durable session rebind never landed in this legacy race, so repair only missing projections on the descendant; newer target state wins while stale source projections are removed.
    let workspaceChanged = false;
    if (workspaceForChat(conversationId)) {
      workspaceChanged = clearChatWorkspace(fromConversationId);
    } else {
      workspaceChanged = moveChatWorkspace(fromConversationId, conversationId);
    }
    let goalChanged = false;
    if (goalObjectiveFor(conversationId)) {
      if (goalObjectiveFor(fromConversationId)) {
        clearGoalObjective(fromConversationId);
        goalChanged = true;
      }
    } else {
      goalChanged = moveGoalObjective(fromConversationId, conversationId);
    }
    // The chat's own Goal/Loop switch travels with its objective so continuing work does not silently fall back to the app-wide setting.
    if (goalSwitchFor(conversationId).own) clearGoalSwitch(fromConversationId);
    else if (moveGoalSwitch(fromConversationId, conversationId)) goalChanged = true;
    // The recovery hook reports success for an already-repaired target, but this boolean tracks mutations from this call and drives the user-visible warning.
    const repaired = currentTargetOwner === PRIME_ID
      ? false
      : (runtime.recoveryHooks().repairPrimeTransfer?.(fromConversationId, conversationId) ?? false);
    if (repaired || workspaceChanged || goalChanged) {
      logWarn(`resume-shadow repair (${proof}) moved missing projections into chat ${conversationId}`);
    }
    return repaired || workspaceChanged || goalChanged;
  }

  return { repairPrimeFromResumeShadow };
}
