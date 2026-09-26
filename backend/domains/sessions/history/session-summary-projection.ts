import type { SessionEvent, SessionSummary } from '../../../../contracts/session.js';
import { eventTokens, normalizedToolOutcome, workSequence } from '../../../../contracts/session.js';
import { applyTurnIdentity } from '../../../../contracts/chronology.js';

export function emptySummary(id: string, title: string, conversationId: string | null): SessionSummary {
  const now = Date.now();
  return {
    id,
    title,
    conversationId,
    chatIds: conversationId ? [conversationId] : [],
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    events: 0,
    timelineTurns: {},
    nativeQuestion: null,
    requestTurns: {},
    userMessages: 0,
    toolCalls: 0,
    lastToolCallAt: null,
    lastToolActivity: null,
    lastAssistantFinalAt: null,
    lastTurnEndAt: null,
    lastFinishReportAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 0,
    contextTokens: 0,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastCommittedResumeHandoffId: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    finishTurn: null,
    agents: [],
    origin: null
  };
}

export function noteFinishWork(summary: SessionSummary, event: SessionEvent): void {
  if (!summary.finishTurn || (event.turnId && event.turnId !== summary.finishTurn.turnId)) return;
  const meaningful = event.kind === 'user_message' || event.kind === 'assistant_message' ||
    (event.kind === 'progress' && event.source !== 'app') ||
    (event.kind === 'tool_call' && !['keep_astra_on_forever', 'session_finish'].includes(event.call.tool));
  if (meaningful) {
    summary.finishTurn = {
      ...summary.finishTurn,
      workSeq: Math.max(summary.finishTurn.workSeq, workSequence(event))
    };
  }
}

export function applyToSummary(summary: SessionSummary, event: SessionEvent): void {
  applyTurnIdentity(summary, event);
  summary.events += 1;
  // Delayed tool attribution must not move a session's recency backwards.
  summary.updatedAt = Math.max(summary.updatedAt, event.time);
  const tokens = eventTokens(event);
  summary.estimatedTokens += tokens;
  // Rebinding may reset context tokens while lifetime tokens remain cumulative.
  summary.contextTokens += tokens;
  if (event.kind === 'user_message') summary.userMessages += 1;
  if (event.kind === 'tool_call') {
    summary.toolCalls += 1;
    const priorToolAt = summary.lastToolCallAt ?? 0;
    summary.lastToolCallAt = Math.max(priorToolAt, event.time);
    // Late attribution must not replace newer tool activity in the summary.
    if (event.time >= priorToolAt) {
      summary.lastToolActivity = {
        kind: event.call.summary.kind,
        title: event.call.summary.title.slice(0, 200)
      };
    }
    if (event.call.endsActivity === true) {
      summary.lastFinishReportAt = Math.max(summary.lastFinishReportAt ?? 0, event.time);
    }
    const outcome = normalizedToolOutcome(event.call);
    if (outcome === 'process_exit_nonzero') summary.processExitNonzero += 1;
    if (outcome === 'tool_rejected') summary.toolRejected += 1;
    if (outcome === 'tool_internal_error') {
      summary.toolInternalErrors += 1;
      summary.errors += 1;
    }
  }
  if (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) {
    summary.lastAssistantFinalAt = Math.max(summary.lastAssistantFinalAt ?? 0, event.time);
  }
  if (event.kind === 'chat_error') summary.errors += 1;
  if (event.kind === 'turn_end') {
    summary.lastTurnOutcome = event.outcome;
    summary.lastTurnEndAt = Math.max(summary.lastTurnEndAt ?? 0, event.time);
  }
  if (event.kind === 'turn_start') {
    summary.activeTurnId = event.turnId ?? `seq-${event.seq}`;
    if (summary.finishTurn?.turnId !== summary.activeTurnId) {
      summary.finishTurn = {
        turnId: summary.activeTurnId,
        conversationId: summary.conversationId,
        startedAt: event.time,
        notified: false,
        released: false,
        decisionRevision: null,
        workSeq: 0,
        decisionSeq: 0,
        decisionInputRevision: null
      };
    }
  }
  if (event.kind === 'progress' && event.source === 'app' && event.turnId && summary.finishTurn?.turnId === event.turnId) {
    const finish = { ...summary.finishTurn };
    summary.finishTurn = finish;
    if (event.progressId === `finish:${event.turnId}` || event.finishControl?.state === 'notified') finish.notified = true;
    const prefix = `finish-goal:${event.turnId}:`;
    const revision = event.finishControl?.state === 'decision' ? event.finishControl.revision
      : event.progressId?.startsWith(prefix) ? event.progressId.slice(prefix.length) : null;
    if (revision && /^[a-f0-9]{64}$/.test(revision) && finish.decisionRevision !== revision) {
      finish.decisionRevision = revision;
      finish.decisionAt = event.time;
      finish.decisionSeq = Number.isSafeInteger(event.finishControl?.workSeq) ? event.finishControl!.workSeq! : event.seq;
      finish.decisionInputRevision = event.finishControl?.inputRevision ?? null;
    } else if (revision === finish.decisionRevision && event.finishControl?.state === 'decision' && Number.isSafeInteger(event.finishControl.workSeq)) {
      finish.decisionSeq = Math.max(finish.decisionSeq, event.finishControl.workSeq!);
    }
    if (event.finishControl) finish.conversationId = event.finishControl.conversationId;
    if (event.finishControl?.state === 'released') finish.released = true;
  }
  noteFinishWork(summary, event);
  if (event.kind === 'turn_end' && (!event.turnId || summary.activeTurnId === event.turnId)) summary.activeTurnId = null;
  if (event.kind === 'handoff') {
    summary.lastHandoffId = event.handoffId;
    summary.lastHandoffAt = event.time;
  }
  if (event.agent && !summary.agents.includes(event.agent)) summary.agents.push(event.agent);
}
