import { randomUUID } from 'node:crypto';
import { queuedFollowup } from '../../../../contracts/input.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import { finishInstruction } from '../../../../contracts/automation/completion-policy.js';
import { MAX_PROVIDER_MESSAGE_CHARS } from '../../../../contracts/messaging/provider-message-envelope.js';
import type { InputEntry } from './input-schema.js';
import { inputArgs } from './input-schema.js';
import type { PromptLimits } from './prompt.js';
import { TOOL_INPUT_HEADER, TOOL_INPUT_TEXT_BYTES } from './input-tool-delivery.js';

export const terminal = (row: InputEntry): boolean => ['sent', 'cancelled', 'failed'].includes(row.state);
export const neverAuthorized = (row: InputEntry): boolean => row.sendAuthorizedAt === undefined &&
  (row.offeredAt === undefined || row.requiresAuthorization === true);

export type DeliveryProof = 'sent' | 'not_sent' | 'unconfirmed' | 'pending';

/** Delivery status reflects receipts and authorization, never source turn ids. */
export function deliveryProof(row: Readonly<InputEntry>): DeliveryProof {
  if (row.deliveredAt !== undefined) return 'sent';
  if (row.state === 'sent') return 'unconfirmed';
  if (terminal(row)) return neverAuthorized(row) ? 'not_sent' : 'unconfirmed';
  return row.state === 'queued' || (row.state === 'browser' && neverAuthorized(row)) ? 'pending' : 'unconfirmed';
}

export const preparable = (row: InputEntry): boolean => row.state === 'queued' ||
  (row.state === 'browser' && row.requiresAuthorization === true && row.sendAuthorizedAt === undefined);
export const needsHistory = (row: InputEntry): boolean => row.purpose !== 'decision' && !row.historyRecorded &&
  ((row.state === 'tool' && Number.isFinite(row.offeredAt)) || ((row.state === 'sent' || row.state === 'cancelled') && !!row.messageId));
export const pendingStages = (row: InputEntry): boolean => row.state === 'sent' && !!row.stages?.length && !row.stagesApplied;
export const ordered = (rows: InputEntry[]): InputEntry[] => [...rows].sort((a, b) =>
  (a.queueOrder ?? a.dueAt) - (b.queueOrder ?? b.dueAt) || a.createdAt - b.createdAt);
export const companionOf = (rows: InputEntry[], row: InputEntry): InputEntry | undefined => rows.find(root => root.companionInputId === row.id);
export const sameDelivery = (root: InputEntry, row: InputEntry): boolean => row.id === root.id || row.id === root.companionInputId;

export function combinedInput(root: InputEntry, companion?: InputEntry): InputEntry {
  if (!companion) return root;
  const images = inputArgs.shape.images.parse([...root.images ?? [], ...companion.images ?? []]);
  const attachments = inputArgs.shape.attachments.parse([...root.attachments ?? [], ...companion.attachments ?? []]);
  return { ...root, text: `${root.text}\n\nNext queued instruction:\n${companion.text}`,
    ...(images?.length ? { images } : {}), ...(attachments?.length ? { attachments } : {}) };
}

export type InputAdmissionRuntime = {
  getSession: (sessionId: string) => Promise<SessionSummary | null>;
  isChatBlocked: (conversationId: string) => boolean;
  goalDrivingMode: (conversationId: string) => 'goal' | 'loop';
  automaticFinishEnabled: (conversationId: string) => boolean;
  finishToolEnabled: () => boolean;
  finishLeadMinutes: () => number | undefined;
  assignSessionProject: (sessionId: string, projectId: string) => Promise<void>;
  createSession: (options: {
    reservedId: string;
    title: string;
    titleSource: 'fallback';
    origin: NonNullable<SessionSummary['origin']>;
  }) => Promise<SessionSummary>;
  userTitle: (text: string, fallback: string) => string;
  prepareText?: (entry: Readonly<InputEntry>, limits: PromptLimits, authored: string) => string | Promise<string>;
};

export function createInputAdmission(runtime: InputAdmissionRuntime) {
  function append(current: InputEntry[], entry: InputEntry, stackDirect = false): InputEntry[] {
    const isFollowup = queuedFollowup(entry);
    if (isFollowup) {
      const positioned = current.filter(row => row.sessionId === entry.sessionId && queuedFollowup(row) && !terminal(row) && row.queueOrder !== undefined);
      if (positioned.length) entry = { ...entry, queueOrder: Math.max(...positioned.map(row => row.queueOrder!)) + 1 };
    }
    // Admission is per durable session. Native composer custody stays with each claim.
    if (!stackDirect && entry.purpose !== 'decision' && !isFollowup && current.some(row => row.sessionId === entry.sessionId && row.purpose !== 'decision' &&
        !(!entry.finishOwner && row.finishOwner && row.state === 'tool') &&
        (!queuedFollowup(row) || row.state === 'browser') && ['queued', 'browser', 'tool'].includes(row.state))) {
      throw new Error('One message is already awaiting delivery. Cancel it before sending another.');
    }
    const active = current.filter(row => !terminal(row) || needsHistory(row) || pendingStages(row));
    const reserved = (row: InputEntry) => row.stagesApplied ? [] : row.stages ?? [];
    if ([...active, entry].reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify({ ...row, images: undefined, toolImages: undefined, stages: reserved(row) })), 0) > 1024000)
      throw new Error('The message queue is full');
    const imageBytes = (row: InputEntry): number => [...row.images ?? [], ...row.toolImages ?? []].reduce((sum, image) => sum + image.dataUrl.length, 0) +
      (row.attachments ?? []).reduce((sum, file) => sum + (file.preview?.length ?? 0), 0);
    if ([...active, entry].reduce((sum, row) => sum + imageBytes(row), 0) > 4 * 1024 * 1024) throw new Error('The image queue is full');
    const history = current.filter(row => terminal(row) && !needsHistory(row) && !pendingStages(row)).slice(-50);
    const bytes = (row: InputEntry): number => Buffer.byteLength(row.text) + Buffer.byteLength(row.deliveryText ?? '') + Buffer.byteLength(row.response ?? '') + Buffer.byteLength(JSON.stringify(row.stages ?? [])) + imageBytes(row);
    let retainedBytes = [...history, ...active, entry].reduce((sum, row) => sum + bytes(row), 0);
    while (history.length && retainedBytes > 2048000) retainedBytes -= bytes(history.shift()!);
    // A frozen delivery needs both originals for restart/history until both can be discarded together.
    const retained = new Set([...history, ...active, entry].map(row => row.id));
    return [...history.filter(row => {
      const root = companionOf(current, row);
      return (!row.companionInputId || retained.has(row.companionInputId)) && (!root || retained.has(root.id));
    }), ...active, ...current.filter(row => !retained.has(row.id) && active.some(root => sameDelivery(root, row) || root.id === row.companionInputId)), entry];
  }

  async function target(entry: InputEntry): Promise<string | null> {
    if (entry.purpose === 'decision') {
      if (entry.conversationId && runtime.isChatBlocked(entry.conversationId)) throw new Error('Unblock this helper conversation before sending');
      return entry.conversationId;
    }
    if (!entry.sessionId) return null;
    const session = await runtime.getSession(entry.sessionId);
    if (entry.opening && session?.origin?.kind === 'desktop' && !session.conversationId) return null;
    if (!session?.conversationId) throw new Error('This recording has no provider conversation');
    if (runtime.isChatBlocked(session.conversationId)) throw new Error('Unblock this conversation before sending');
    return session.conversationId;
  }

  async function finishInputCurrent(entry: InputEntry): Promise<boolean> {
    // Periodic generation was retired; persisted rows cannot regain delivery authority.
    if (!entry.finishOwner || entry.finishOwner.periodic || !entry.sessionId) return false;
    const session = await runtime.getSession(entry.sessionId);
    return !!session?.conversationId && session.conversationId === entry.conversationId &&
      session.activeTurnId === entry.finishOwner.turnId && session.finishTurn?.turnId === entry.finishOwner.turnId &&
      !session.finishTurn.released && runtime.finishToolEnabled() && !runtime.isChatBlocked(session.conversationId) &&
      session.origin?.kind !== 'worker' && session.origin?.kind !== 'helper' &&
      (entry.finishOwner.mode ?? 'loop') === runtime.goalDrivingMode(session.conversationId) &&
      (entry.finishOwner.userRequested === true || runtime.automaticFinishEnabled(session.conversationId));
  }

  async function materializeOpening(entry: InputEntry): Promise<void> {
    if (!entry.opening || !entry.sessionId) return;
    const existing = await runtime.getSession(entry.sessionId);
    const recoveredExactOwner = !!existing && entry.requestedSessionId === null && !!entry.conversationId &&
      existing.conversationId === entry.conversationId &&
      existing.origin?.kind !== 'worker' && existing.origin?.kind !== 'helper';
    const session = recoveredExactOwner ? existing : await runtime.createSession({ reservedId: entry.sessionId,
      title: runtime.userTitle(entry.text, entry.text), titleSource: 'fallback',
      origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
    if (session.conversationId && session.conversationId !== entry.conversationId)
      throw new Error('Reserved opening session belongs to another provider conversation');
    if (entry.projectId && session.projectId !== entry.projectId) await runtime.assignSessionProject(session.id, entry.projectId);
  }

  function materializeStages(current: InputEntry[], entry: InputEntry): InputEntry[] {
    const sessionId = entry.sessionId ?? entry.deliveredSessionId;
    if (!sessionId || entry.stages === undefined || entry.stagesApplied) return current;
    let next = current.map(row => row.id === entry.id ? { ...row, stagesApplied: true } : row);
    // Checkpoints inherit the current chat model, including later user selections.
    for (const [index, text] of entry.stages.entries()) next = append(next, {
      id: randomUUID(), sessionId, projectId: entry.projectId, text, authoredSource: 'none', mode: 'finish', dueAt: entry.createdAt + index,
      model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: entry.createdAt + index, conversationId: entry.conversationId,
      ...(entry.queuedTurn ? { queuedTurn: entry.queuedTurn } : {})
    });
    return next;
  }

  async function prepare(entry: InputEntry, suffix = ''): Promise<InputEntry> {
    if (entry.purpose === 'decision') return entry;
    const text = entry.stages !== undefined && entry.mode !== 'finish'
      ? `Original user request:\n${entry.objective || entry.text}\n\nComplete workflow:\n${[entry.text, ...entry.stages].map((stage, index) => `${index + 1}. ${stage}`).join('\n\n')}\n\nBegin the complete implementation now. Later queued messages are verification checkpoints; do not wait for them to learn or implement requirements. Carry out and verify each received checkpoint before asking for the next one with session_finish; never call it repeatedly just to collect the queue.`
      : entry.objective && (entry.opening || !entry.sessionId)
        ? `Original user request:\n${entry.objective}\n\nOpening instruction:\n${entry.text}\n\nFollow the complete original request, including all constraints, throughout this task.`
        : entry.text;
    const mandatoryOverhead = `${TOOL_INPUT_HEADER}\n\n${finishInstruction(runtime.finishLeadMinutes())}`;
    const deliveryText = entry.deliveryText ?? await runtime.prepareText?.({ ...entry, text: text + suffix }, {
      maxChars: MAX_PROVIDER_MESSAGE_CHARS, maxBytes: TOOL_INPUT_TEXT_BYTES - Buffer.byteLength(mandatoryOverhead)
    }, entry.authoredSource === 'none' ? '' : entry.authoredSource === 'objective' ? entry.objective ?? '' : entry.text) ?? text + suffix;
    const envelope = `${TOOL_INPUT_HEADER}${deliveryText}\n\n${finishInstruction(runtime.finishLeadMinutes())}`;
    if (!deliveryText || deliveryText.length > MAX_PROVIDER_MESSAGE_CHARS || Buffer.byteLength(envelope) > TOOL_INPUT_TEXT_BYTES)
      throw new Error('Prepared message exceeds the delivery limit; shorten the request or plan');
    return { ...entry, deliveryText };
  }

  return { append, finishInputCurrent, materializeOpening, materializeStages, prepare, target };
}
