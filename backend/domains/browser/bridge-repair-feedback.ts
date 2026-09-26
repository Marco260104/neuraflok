import type { Repair } from './bridge-recovery-types.js';
import { activeUntil } from './session-activity.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { liveConversations, recordProgress } from '../sessions/history/recorder.js';
import { findSessionByConversation } from '../sessions/history/store.js';

interface Runtime {
  repairsInFlight: Map<string, Repair>;
  turnRepairSpent: Map<string, { sessionId: string; turnKey: string; token: string; at: number }>;
}

export function createBridgeRepairFeedback(runtime: Runtime) {
  const REPAIR_HOLD_REASONS: Record<string, string> = {
    'page-changed': 'the page is on another chat or was reloaded',
    'stop-requested': 'a Stop is in progress',
    'tool-running': 'a local tool call for this chat is still running',
    sending: 'a sent message is still waiting for the provider to confirm it',
    'page-busy': 'the page is busy with another action',
    compaction: 'a Compact & resume is in progress',
    draft: 'text or attachments are in the provider message box',
    changed: 'the chat changed while the repair was being checked'
  };
  const REPAIR_FAIL_REASONS: Record<string, string> = {
    changed: 'the page changed before the action',
    error: 'Chrome refused the action'
  };
  const REPAIR_CHANGE_DETAILS: Record<string, string> = {
    navigating: 'the tab was navigating',
    'other-chat': 'the tab showed another chat',
    'new-document': 'the page was reloaded or replaced',
    'woke-up': 'the suspended tab woke up',
    'first-unanswered': 'the page did not answer the first check',
    'changed-turn': 'a new answer started',
    'changed-question': 'a new message was sent',
    'changed-unknown': 'the answer changed',
    unknown: 'the page gave no reason'
  };
  const REPAIR_PROGRESS_SOURCES: Record<string, string> = {
    adopted: 'the page took over a running answer',
    sent: 'a message was sent',
    'page-call': 'the page showed a new tool call',
    'page-step': 'the page showed a new step',
    'page-text': 'the answer text grew',
    'tool-resumed': 'a tool call resumed the answer',
    'app-tool_call': 'the app recorded a tool call',
    'app-page_tool': 'the app recorded a provider page step',
    'app-progress': 'the app recorded a status note',
    'app-assistant_message': 'the app recorded answer text'
  };
  const repairHoldsLogged = new Set<string>();

  function noteRepairHeld(token: string, why: string | null): void {
    const reason = why && Object.hasOwn(REPAIR_HOLD_REASONS, why) ? why : 'unknown';
    const held = [...runtime.repairsInFlight].find(([, repair]) => repair.token === token);
    if (!held) return;
    const key = `${token}:${reason}`;
    if (repairHoldsLogged.has(key)) return;
    repairHoldsLogged.add(key);
    if (repairHoldsLogged.size > 500) {
      for (const old of [...repairHoldsLogged].slice(0, 100)) repairHoldsLogged.delete(old);
    }
    const [conversationId, repair] = held;
    logInfo(`bridge: the page held the ${repair.reason} repair for ${conversationId}: ${REPAIR_HOLD_REASONS[reason] ?? 'it gave no reason'}`);
  }

  function repairChangeDetail(detail: string | null): string | null {
    if (!detail) return null;
    if (Object.hasOwn(REPAIR_CHANGE_DETAILS, detail)) return REPAIR_CHANGE_DETAILS[detail]!;
    if (Object.hasOwn(REPAIR_HOLD_REASONS, detail)) return REPAIR_HOLD_REASONS[detail]!;
    const progress = /^changed-progress(?::(.+))?$/.exec(detail);
    if (!progress) return null;
    const source = progress[1] && Object.hasOwn(REPAIR_PROGRESS_SOURCES, progress[1]) ? REPAIR_PROGRESS_SOURCES[progress[1]] : null;
    return `the answer made progress${source ? ` (${source})` : ''}`;
  }

  async function failRepairAttempt(
    token: string,
    action: 'reloaded' | 'reopened' | 'resumed' | 'preserved' | 'present' | null,
    why: string | null = null,
    changeDetail: string | null = null
  ): Promise<void> {
    for (const [conversationId, repair] of runtime.repairsInFlight) {
      if (repair.state !== 'handed' || repair.token !== token) continue;
      const streaming = why === 'streaming';
      if (streaming) {
        if (!repair.awaitingStream) logInfo(`bridge: the provider is answering again in ${conversationId}; the ${repair.reason} repair waits until it finishes`);
      } else {
        const exact = why === 'changed' ? repairChangeDetail(changeDetail) : null;
        const detail = why && Object.hasOwn(REPAIR_FAIL_REASONS, why) ? `: ${REPAIR_FAIL_REASONS[why]}${exact ? ` — ${exact}` : ''}` : '';
        logWarn(`bridge: the browser reported failed ${repair.reason} recovery for ${conversationId} (${action ?? 'action unspecified'}${detail})`);
      }
      repair.awaitingStream = streaming;
      await updateRepairProgress(
        conversationId,
        repair,
        streaming
          ? repair.attribution ? 'Not reloaded: the provider is answering.' : 'The provider is answering again; recovery waits until it finishes.'
          : `${action === 'reopened' ? 'Reopen' : action === 'resumed' ? 'Resume' : 'Reload'} failed while ${repairPurpose(repair).during}${repair.attribution ? '.' : '; will retry.'}`
      );
      if (runtime.repairsInFlight.get(conversationId) !== repair) return;
      if (repair.reason === 'assistant-error' && runtime.turnRepairSpent.get(conversationId)?.token === token) {
        runtime.turnRepairSpent.delete(conversationId);
      }
      if (repair.reason === 'unattributed') repair.state = 'done';
      else {
        repair.state = 'queued';
        repair.claimed = false;
        runtime.repairsInFlight.delete(conversationId);
        runtime.repairsInFlight.set(conversationId, repair);
      }
      return;
    }
  }

  function repairPurpose(repair: Repair): { to: string; during: string } {
    if (repair.reason === 'compaction' && repair.episode.endsWith(':manual') && repair.episode.includes(':asking:')) {
      return { to: 'send the handoff request for Compact & resume', during: 'sending the handoff request for Compact & resume' };
    }
    return { to: `recover ${repairReason(repair)}`, during: `recovering ${repairReason(repair)}` };
  }

  function repairReason(repair: Repair): string {
    if (repair.reason === 'compaction') {
      return repair.episode.includes(':asking:') ? 'a handoff request that has not been sent' : 'the pending handoff response';
    }
    return {
      unattributed: 'missing connector attribution',
      'assistant-error': 'an interrupted response',
      'no-tab': 'a missing browser tab',
      stalled: 'a suspended browser tab',
      silence: 'an unresponsive open turn',
      goal: 'an undelivered follow-up'
    }[repair.reason];
  }

  async function updateRepairProgress(conversationId: string, repair: Repair, text: string): Promise<void> {
    if (repair.progress?.text === text) return;
    const sessionId = repair.progress?.sessionId ??
      (await findSessionByConversation(conversationId, { requireUnique: true }).catch(() => null))?.id;
    if (!sessionId) return;
    const anchor = repair.progress ? { seq: repair.progress.seq, time: repair.progress.time } : undefined;
    const turnId = repair.progress?.turnId ??
      repair.assistantSource?.turnId ??
      liveConversations().find(entry => entry.conversationId === conversationId)?.activeTurnId ??
      (repair.reason === 'silence' && activeUntil.get(conversationId)?.sessionId === sessionId ? activeUntil.get(conversationId)?.turnId : null) ??
      null;
    const recorded = await recordProgress(sessionId, repair.progressId, text, anchor, turnId);
    if (recorded) repair.progress = { sessionId, ...recorded, text, turnId };
  }

  return {
    noteRepairHeld,
    repairChangeDetail,
    failRepairAttempt,
    repairPurpose,
    repairReason,
    updateRepairProgress,
    state: { REPAIR_HOLD_REASONS, repairHoldsLogged, REPAIR_FAIL_REASONS, REPAIR_CHANGE_DETAILS, REPAIR_PROGRESS_SOURCES }
  };
}
