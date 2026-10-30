import type {
  ControlApiAgents,
  ControlApiEvent,
  ControlApiInput,
  ControlApiLive,
  ControlApiLog,
  ControlApiSession,
  ControlApiText
} from '../../../contracts/control-api.js';
import { positionOf } from '../../../contracts/chronology.js';
import { normalizedToolOutcome, toolCallSummary } from '../../../contracts/session.js';
import type { SessionEvent, SessionSummary, StoredText, SwarmState } from '../../../contracts/session.js';
import type { LogEntry } from '../../../contracts/types.js';
import { userPromptText } from '../../../contracts/messaging/provider-message-envelope.js';
import type { SessionControlsView } from '../../domains/browser/bridge.js';
import { redactSecretText } from '../settings/redaction.js';
import { deliveryProof } from '../../domains/sessions/input/input.js';
import type { InputEntry } from '../../domains/sessions/input/input.js';

/** Caps on free text, so a page's size is bounded by its row limit. */
const TEXT_CAP = 4_000;
const TOOL_TEXT_CAP = 2_000;
const TITLE_CAP = 200;
const TASK_CAP = 1_000;
const SUMMARY_CAP = 300;
const CHANGES_CAP = 20;
const CHANGE_PATH_CAP = 200;
/** A chat holds a handful of waits at once; the cap only bounds what a bad owner could hand over. */
const MAX_RECOVERY = 10;

function clip(text: string, cap: number): { text: string; clipped: boolean } {
  if (text.length <= cap) return { text, clipped: false };
  let end = cap;
  // Never end on half of a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), clipped: true };
}

/** Redact first, then cut: a cut through a key must not leave a recognisable prefix behind. */
function line(value: string, cap: number): string {
  return clip(redactSecretText(value), cap).text;
}

function stored(value: StoredText, cap = TEXT_CAP): ControlApiText {
  const { text, clipped } = clip(redactSecretText(value.text), cap);
  return { text, chars: value.chars, truncated: value.truncated || clipped };
}

function plain(value: string, cap = TEXT_CAP): ControlApiText {
  const { text, clipped } = clip(redactSecretText(value), cap);
  return { text, chars: value.length, truncated: clipped };
}

export function projectSession(summary: SessionSummary): ControlApiSession {
  return {
    id: summary.id,
    title: line(summary.title, TITLE_CAP),
    conversationId: summary.conversationId,
    projectId: summary.projectId ?? null,
    startedAt: summary.startedAt,
    updatedAt: summary.updatedAt,
    endedAt: summary.endedAt,
    events: summary.events,
    userMessages: summary.userMessages,
    toolCalls: summary.toolCalls,
    lastToolCallAt: summary.lastToolCallAt,
    lastAssistantFinalAt: summary.lastAssistantFinalAt ?? null,
    lastTurnEndAt: summary.lastTurnEndAt ?? null,
    activityExpiresAt: summary.activityExpiresAt ?? null,
    errors: summary.errors,
    toolRejected: summary.toolRejected,
    toolInternalErrors: summary.toolInternalErrors,
    processExitNonzero: summary.processExitNonzero,
    estimatedTokens: summary.estimatedTokens,
    contextTokens: summary.contextTokens,
    lastTurnOutcome: summary.lastTurnOutcome,
    activeTurnId: summary.activeTurnId ?? null,
    // A model picked in an earlier chat of this session says nothing about the attached one.
    model: summary.selectedModel?.conversationId === summary.conversationId ? summary.selectedModel?.model ?? null : null,
    agents: [...summary.agents],
    origin: summary.origin
      ? {
          kind: summary.origin.kind,
          fromSessionId: summary.origin.fromSessionId,
          agentId: summary.origin.agentId,
          task: line(summary.origin.task, TASK_CAP)
        }
      : null
  };
}

/** What the app is doing, or waiting for, in one chat: the same view the renderer polls, cut down to the fields that are a flag, a number, the running turn's id or one of a fixed set of words. Drafts, the goal's objective, the plan, and the continuation's token and ids are free text or handles and stay in the app; the one message a job can carry is redacted and cut like any other free text here. */
export function projectLive(controls: SessionControlsView): ControlApiLive {
  const { job, goalWait } = controls;
  return {
    activeTurnId: controls.activeTurnId,
    stopPending: controls.stopPending === true,
    automation: controls.automation,
    blocked: controls.blocked,
    canSendDirectly: controls.canSendDirectly === true,
    canInject: controls.canInject === true,
    queueAtFinish: controls.queueAtFinish === true,
    finishHeld: controls.finishHeld,
    finishWaiting: controls.finishWaiting === true,
    goalWait: goalWait ? { reason: goalWait.reason, until: goalWait.until ?? null } : null,
    recovery: (controls.recovery ?? []).slice(0, MAX_RECOVERY).map((wait) => ({
      kind: wait.kind,
      deadline: wait.deadline,
      visibleAt: wait.visibleAt ?? null,
      next: wait.next ?? null,
      reload: wait.reload === true,
      generating: wait.generating === true
    })),
    job: job
      ? {
          stage: job.stage,
          startedAt: job.startedAt,
          automatic: job.automatic,
          busy: job.busy,
          sourceSend: job.sourceSend.state,
          destinationSend: job.destinationSend.state,
          error: job.error ? line(job.error, SUMMARY_CAP) : null
        }
      : null
  };
}

export function projectEvent(event: SessionEvent): ControlApiEvent {
  const base: ControlApiEvent = {
    seq: event.seq,
    // Where the row sits in history. A revised message keeps its first position but carries its newest seq, so `before` and `after` take this, not `seq`.
    position: positionOf(event),
    time: event.time,
    kind: event.kind,
    source: event.source,
    agent: event.agent,
    turnId: event.turnId,
    model: event.model
  };
  switch (event.kind) {
    case 'session_start':
      return { ...base, conversationId: event.conversationId, title: line(event.title, TITLE_CAP) };
    case 'user_message': {
      // What the user wrote, not the text the app delivered: an app-sent message is framed with instructions and skills that can be far longer than the request itself.
      const authored = event.authoredText ?? userPromptText(event.message.text);
      return {
        ...base,
        message: authored === null || authored === undefined ? stored(event.message) : plain(authored),
        messageId: event.messageId,
        inputId: event.inputId,
        inputDelivery: event.inputDelivery,
        attachments: event.attachments?.length ?? 0,
        images: event.assets?.length ?? 0
      };
    }
    case 'assistant_message':
      return { ...base, message: stored(event.message), messageId: event.messageId, final: event.final, state: event.state, resolvedModel: event.resolvedModel };
    case 'native_image':
      return { ...base, previewStatus: event.previewStatus, width: event.width, height: event.height };
    case 'progress':
    case 'note':
      return { ...base, message: stored(event.message) };
    case 'page_tool':
      return { ...base, label: line(event.label, SUMMARY_CAP) };
    case 'turn_start':
      return { ...base, detail: event.detail && line(event.detail, SUMMARY_CAP) };
    case 'turn_end':
      return { ...base, outcome: event.outcome, detail: event.detail && line(event.detail, SUMMARY_CAP), reason: event.reason };
    case 'chat_error':
      return { ...base, message: stored(event.message), recoverable: event.recoverable, continueAvailable: event.continueAvailable, blocking: event.blocking, reason: event.reason };
    case 'tool_call': {
      const call = event.call;
      const summary = toolCallSummary(call);
      return {
        ...base,
        tool: {
          callId: call.callId,
          name: line(call.tool, TITLE_CAP),
          outcome: normalizedToolOutcome(call) ?? String(call.outcome),
          durationMs: call.durationMs,
          attribution: call.attribution,
          summary: {
            title: line(summary.title, SUMMARY_CAP),
            detail: summary.detail && line(summary.detail, SUMMARY_CAP),
            metric: summary.metric && line(summary.metric, SUMMARY_CAP),
            tone: summary.tone,
            kind: summary.kind
          },
          args: stored(call.args, TOOL_TEXT_CAP),
          result: stored(call.result, TOOL_TEXT_CAP),
          changes: (call.changes ?? []).slice(0, CHANGES_CAP).map((change) => ({
            path: line(change.path, CHANGE_PATH_CAP),
            added: change.added,
            removed: change.removed
          }))
        }
      };
    }
    case 'agent_message':
      return { ...base, messageId: event.messageId, from: event.from, to: event.to, message: stored(event.message), delivery: event.delivery };
    case 'handoff':
      return { ...base, handoffId: event.handoffId, chars: event.chars, reason: line(event.reason, SUMMARY_CAP) };
    default:
      // A kind added after this projection was written is named, not described.
      return base;
  }
}

/** One row that cannot be read must not take the rest of the page with it. */
export function projectReadableEvent(event: SessionEvent): ControlApiEvent {
  try {
    return projectEvent(event);
  } catch {
    return { seq: event.seq, position: event.seq, time: event.time, kind: event.kind, source: event.source, unreadable: true };
  }
}

export function projectInput(entry: InputEntry): ControlApiInput {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    deliveredSessionId: entry.deliveredSessionId ?? null,
    conversationId: entry.conversationId,
    state: entry.state,
    // What the row proves about delivery, from the one owner of that rule.
    delivery: deliveryProof(entry),
    mode: entry.mode,
    transportIntent: entry.transportIntent ?? null,
    // Filed by the app itself (a recovery pickup or an automatic follow-up), not typed by anyone. A silence boundary alone is not that: it can ride a message a person typed.
    automatic: !!(entry.recovery || entry.finishOwner),
    purpose: entry.purpose ?? null,
    createdAt: entry.createdAt,
    dueAt: entry.dueAt,
    offeredAt: entry.offeredAt ?? null,
    deliveredAt: entry.deliveredAt ?? null,
    sendAuthorizedAt: entry.sendAuthorizedAt ?? null,
    requiresAuthorization: entry.requiresAuthorization === true,
    cancelledByUser: entry.cancelledByUser === true,
    queueOrder: entry.queueOrder ?? null,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    messageId: entry.messageId ?? null,
    error: entry.error ? line(entry.error, SUMMARY_CAP) : null,
    text: plain(entry.text),
    attachments: entry.attachments?.length ?? 0,
    images: entry.images?.length ?? 0
  };
}

/** The rows a caller may see: everything the renderer's outbox lists, optionally in some states, oldest first, keeping the newest `limit`. Ordered by creation, not by the queue's own order: a reordered row sorts ahead of every other, and a cut would then drop the newest last. */
export function selectInputs(rows: readonly InputEntry[], query: { state?: readonly string[]; limit: number }) {
  const matching = rows
    .filter((row) => row.purpose !== 'decision' && (!query.state || query.state.includes(row.state)))
    .sort((a, b) => a.createdAt - b.createdAt);
  return { rows: matching.slice(-query.limit), total: matching.length };
}

export function projectAgents(swarm: SwarmState): ControlApiAgents {
  return {
    enabled: swarm.enabled,
    running: swarm.running,
    retainedHistory: swarm.retainedHistory === true,
    agents: swarm.agents.map((agent) => ({
      runId: agent.runId ?? null,
      id: agent.id,
      role: agent.role,
      label: line(agent.label, TITLE_CAP),
      task: plain(agent.task, TASK_CAP),
      state: agent.state,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      conversationId: agent.conversationId,
      createdAt: agent.createdAt,
      activatedAt: agent.activatedAt,
      finishedAt: agent.finishedAt,
      detachedAt: agent.detachedAt,
      sleptAt: agent.sleptAt,
      lastSeenAt: agent.lastSeenAt,
      revivable: agent.revivable,
      pending: agent.pending,
      awaitingAck: agent.awaitingAck,
      delivered: agent.delivered,
      contextTokens: agent.contextTokens,
      result: agent.result === null ? null : plain(agent.result)
    }))
  };
}

export function projectLog(entries: readonly LogEntry[]): ControlApiLog['entries'] {
  return entries.map((entry) => {
    const { text, clipped } = clip(redactSecretText(entry.message), TEXT_CAP);
    return {
      time: entry.time,
      level: entry.level,
      message: text,
      ...(entry.agent ? { agent: line(entry.agent, TITLE_CAP) } : {}),
      ...(clipped ? { truncated: true as const } : {})
    };
  });
}
