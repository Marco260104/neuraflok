import type {
  InputArgs,
  InputEntry,
} from '../../../backend/domains/sessions/input/input.js';
import type { ComposerAttachment } from './chat-composer-attachments.js';
import type { NewChatTaskDraft } from './chat-draft-state.js';
import type { SessionEvent, SessionSummary } from '../../../contracts/session.js';
import { queuedFollowup } from '../../../contracts/input.js';
import { $ } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';
import { createQueuedTaskList } from './queued-task-list.js';
import { createChatInputRows } from './chat-input-rows.js';
import { adoptOpeningSession, markComposerWarmupOpening } from './chat-composer-ready.js';
import { isWarmupInput } from './chat-web-warmup.js';

export interface ChatInputQueueRuntime {
  api: Pick<typeof window.api, 'cancelInput' | 'editQueuedInput' | 'getSession' | 'listInputs' | 'listPausedHelpers' | 'reorderQueuedInputs' | 'retryHelper' | 'retryInputBrowser' | 'sendInput'>;
  run: typeof import('../../shared/dom.js').run;
  toast: typeof import('../../shared/dom.js').toast;
  visibleInputIds: Set<string>;
  hasLaterModelActivity: (time: number) => boolean;
  attachmentCard: (file: import('../../../contracts/input.js').InputAttachment, inComposer?: boolean) => HTMLElement;
  dockAction: (label: string | (() => string), symbol: string, click: (event: MouseEvent) => void) => HTMLButtonElement;
  dismissInputNotice: (id: string) => void;
  authoredComposerText: () => string;
  imageDrafts: Map<string, ComposerAttachment[]>;
  draftKey: () => string;
  replaceComposerDraft: () => void;
  rememberDraft: () => void;
  skillPicker: { restore: () => void } | undefined;
  paintComposerImages: () => void;
  paintDeliveryControls: () => void;
  pendingNewInput: { id: string; generation: number } | null;
  selectionGeneration: number;
  newChatSelected: boolean;
  selectedId: string | null;
  sessions: SessionSummary[];
  mergeSessionRows: (rows: SessionSummary[]) => void;
  inputDrafts: Map<string, string>;
  selectSession: (id: string) => void;
  newChatTasks: Map<string, NewChatTaskDraft>;
  pendingComposerInputs: InputEntry[];
  dismissedInputNotices: Set<string>;
  detailFor: string | null;
  events: SessionEvent[];
  historyBefore: number | null;
  detailCursor: number | null;
  selectedProjectId: string | null;
  projectGroup: (id: string | null | undefined) => string | null;
  startingInputs: Map<string, InputEntry>;
  holdSentMessage: () => boolean;
  reconcileChildren: (parent: Element, children: HTMLElement[]) => void;
  parkTurnStatus: (working: boolean) => void;
  inputQueueGeneration: number;
  paintDetail: (followBottom?: boolean) => void;
  cancelledStarts: Set<string>;
  refreshInputQueue: () => Promise<void>;
  turnWorking: boolean;
}

type Runtime = ChatInputQueueRuntime;

export function visibleStartingComposerInputs(
  startingInputs: Iterable<InputEntry>,
  belongsToSelection: (entry: InputEntry) => boolean,
  existingIds: ReadonlySet<string>,
): InputEntry[] {
  return [...startingInputs].filter(entry =>
    !isWarmupInput(entry) && !entry.warmupDeferred && belongsToSelection(entry) && !existingIds.has(entry.id));
}

// Owns pending delivery rows, queued follow-ups, retries, and queue reconciliation.
export function createChatInputQueue(runtime: Runtime) {
  const queuedTaskList = createQueuedTaskList(runtime);

  const inputRows = createChatInputRows(runtime, refreshInputQueue, retryPlannedInput);
  const { historicalAutomaticInput, inputMessageRow } = inputRows;

  // Local admission moves the draft; a native receipt alone may mark it sent.
  async function adoptAcceptedOpening(entry: InputEntry): Promise<boolean> {
    const pending = runtime.pendingNewInput;
    const id = entry.opening
      ? entry.sessionId
      : entry.state === 'sent'
        ? entry.deliveredSessionId
        : null;
    if (
      !id ||
      !pending ||
      pending.id !== entry.id ||
      pending.generation !== runtime.selectionGeneration ||
      !runtime.newChatSelected ||
      runtime.selectedId !== null
    )
      return false;
    let summary = runtime.sessions.find((row) => row.id === id);
    if (!summary)
      summary =
        (await runtime.run(runtime.api.getSession(id, { limit: 1 })))
          ?.summary ?? undefined;
    if (
      !summary ||
      runtime.pendingNewInput !== pending ||
      pending.generation !== runtime.selectionGeneration ||
      runtime.selectedId !== null
    )
      return false;
    if (entry.warmup) markComposerWarmupOpening(id, runtime.selectionGeneration);
    runtime.pendingNewInput = null;
    runtime.mergeSessionRows([summary]);
    const from = runtime.draftKey();
    runtime.inputDrafts.set(summary.id, runtime.authoredComposerText());
    const images = runtime.imageDrafts.get(from);
    if (images) runtime.imageDrafts.set(summary.id, images);
    runtime.selectSession(summary.id);
    adoptOpeningSession(summary.id);
    runtime.inputDrafts.delete(from);
    runtime.imageDrafts.delete(from);
    runtime.newChatTasks.delete(from);
    return true;
  }
  function paintPendingInputs(): void {
    const all = runtime.pendingComposerInputs;
    const belongsToSelection = (entry: InputEntry): boolean =>
      runtime.selectedId === null
        ? runtime.pendingNewInput?.generation === runtime.selectionGeneration &&
          entry.id === runtime.pendingNewInput?.id
        : (entry.sessionId ?? entry.deliveredSessionId) === runtime.selectedId;
    // An unbound delivery row belongs only to its originating draft.
    const unbound = (entry: InputEntry) =>
      runtime.selectedId === null &&
      runtime.pendingNewInput?.id === entry.id &&
      runtime.pendingNewInput?.generation === runtime.selectionGeneration &&
      !entry.deliveredSessionId &&
      entry.purpose !== 'decision' &&
      ['queued', 'browser'].includes(entry.state);
    const notice = (entry: InputEntry) =>
      belongsToSelection(entry) &&
      entry.purpose !== 'decision' &&
      ['failed', 'cancelled'].includes(entry.state) &&
      !!entry.error &&
      !runtime.dismissedInputNotices.has(entry.id);
    const anchored = (entry: InputEntry) =>
      runtime.detailFor === runtime.selectedId &&
      (runtime.events.some(
        (event) =>
          event.kind === 'user_message' &&
          (event.inputId === entry.id ||
            event.messageId === (entry.messageId ?? `input:${entry.id}`)),
      ) ||
        // Keep committed off-page receipts only until the loaded history cursor covers them.
        ((entry.historyAnchored || entry.historyRecorded) &&
          (runtime.historyBefore !== null ||
            (entry.historySeq !== undefined
              ? (runtime.detailCursor ?? 0) > entry.historySeq
              : runtime.events.length > 0))));
    const rows = all.filter(
      (entry) =>
        !runtime.dismissedInputNotices.has(entry.id) &&
        !(!notice(entry) && anchored(entry)) &&
        !(
          queuedFollowup(entry) &&
          ['queued', 'tool', 'browser'].includes(entry.state)
        ) &&
        (belongsToSelection(entry) || unbound(entry) || notice(entry)) &&
        (notice(entry) ||
          unbound(entry) ||
          runtime.selectedId !== null ||
          runtime.projectGroup(entry.projectId) ===
            runtime.selectedProjectId) &&
        !isWarmupInput(entry) &&
        (!entry.warmupDeferred || notice(entry)) &&
        (notice(entry) ||
          !['sent', 'cancelled'].includes(entry.state) ||
          (entry.state === 'sent' && entry.messageId && !anchored(entry))),
    );
    rows.push(...visibleStartingComposerInputs(
      runtime.startingInputs.values(),
      belongsToSelection,
      new Set(all.map(entry => entry.id)),
    ));
    const host = $('inputQueue');
    const previous = new Map(
      [...host.querySelectorAll<HTMLElement>(':scope > .pending-message')].map(
        (row) => [row.dataset.inputId, row],
      ),
    );
    const next = rows
      .filter((entry) => !historicalAutomaticInput(entry))
      .map((entry) => {
        const sig = JSON.stringify([
          entry.text,
          entry.state,
          entry.error,
          entry.dueAt,
          notice(entry),
          entry.stagesApplied,
          entry.stages,
          entry.attachments?.map((file) => file.id),
          entry.images?.map((image) => [image.name, image.dataUrl.length]),
          runtime.hasLaterModelActivity(
            entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt,
          ),
        ]);
        const old = previous.get(entry.id);
        if (old?.dataset.inputSignature === sig) return old;
        const row = inputMessageRow(entry, notice(entry));
        row.dataset.inputSignature = sig;
        return row;
      });
    // Helper controls have their own owner and are refreshed by the queue read below.
    runtime.reconcileChildren(host, [
      ...next,
      ...host.querySelectorAll<HTMLElement>(':scope > .queued-input'),
    ]);
    runtime.holdSentMessage();
    runtime.parkTurnStatus(runtime.turnWorking);
  }
  async function refreshInputQueue(): Promise<void> {
    const request = ++runtime.inputQueueGeneration;
    const selection = runtime.selectionGeneration;
    const [all, pausedHelpers] = await Promise.all([
      runtime.run(runtime.api.listInputs()),
      runtime.run(runtime.api.listPausedHelpers()),
    ]);
    if (
      !all ||
      selection !== runtime.selectionGeneration ||
      request !== runtime.inputQueueGeneration
    )
      return;
    runtime.pendingComposerInputs = all;
    for (const id of runtime.dismissedInputNotices)
      if (!all.some((entry) => entry.id === id))
        runtime.dismissedInputNotices.delete(id);
    runtime.paintDeliveryControls();
    const accepted =
      runtime.pendingNewInput &&
      all.find((entry) => entry.id === runtime.pendingNewInput!.id);
    if (accepted && (await adoptAcceptedOpening(accepted))) return;
    if (
      selection !== runtime.selectionGeneration ||
      request !== runtime.inputQueueGeneration
    )
      return;
    queuedTaskList.paint(all, pausedHelpers, selection);
  }
  async function retryPlannedInput(entry: InputEntry): Promise<void> {
    if (
      runtime.dismissedInputNotices.has(entry.id) ||
      entry.stagesApplied ||
      !['failed', 'cancelled'].includes(entry.state)
    )
      return;
    // Retry the retained authored workflow with a fresh input identity.
    const {
      sessionId,
      projectId,
      text,
      objective,
      stages,
      images,
      attachments,
      attachmentDelivery,
      automation,
      loopAfterTurn,
      model,
      reasoningEffort,
      afterTurn,
      webProvider,
    } = entry;
    const args: InputArgs = {
      id: crypto.randomUUID(),
      sessionId,
      projectId,
      text,
      objective,
      stages,
      images,
      attachments,
      attachmentDelivery,
      automation,
      loopAfterTurn,
      model,
      reasoningEffort,
      afterTurn,
      webProvider,
      mode: entry.requestedMode ?? entry.mode,
      dueAt: Date.now(),
    };
    const generation = runtime.selectionGeneration;
    // Hide the failed row during retry and persist dismissal only after admission.
    runtime.dismissedInputNotices.add(entry.id);
    void refreshInputQueue();
    let accepted = false;
    try {
      runtime.startingInputs.set(args.id, {
        ...args,
        state: 'queued',
        owner: null,
        createdAt: args.dueAt,
        conversationId: null,
      });
      if (sessionId === null)
        runtime.pendingNewInput = { id: args.id, generation };
      runtime.paintDeliveryControls();
      void refreshInputQueue();
      const result = await runtime.run(runtime.api.sendInput(args));
      if (runtime.cancelledStarts.has(args.id)) return;
      if (!result) return;
      accepted = true;
      runtime.inputQueueGeneration++;
      runtime.pendingComposerInputs = [
        ...runtime.pendingComposerInputs.filter((row) => row.id !== result.id),
        result,
      ];
      showAutoSkillReceipt(result);
      await adoptAcceptedOpening(result);
    } finally {
      if (accepted) runtime.dismissInputNotice(entry.id);
      if (!accepted && !runtime.cancelledStarts.has(args.id))
        runtime.dismissedInputNotices.delete(entry.id);
      if (!accepted && runtime.pendingNewInput?.id === args.id)
        runtime.pendingNewInput = null;
      runtime.cancelledStarts.delete(args.id);
      runtime.startingInputs.delete(args.id);
      runtime.paintDeliveryControls();
      void refreshInputQueue();
    }
  }
  function showAutoSkillReceipt(entry: Pick<InputEntry, 'autoSkills'>): void {
    if (entry.autoSkills?.length)
      runtime.toast(t('Auto-selected Skill: /{0}', [entry.autoSkills[0]!.id]));
  }

  function pendingComposerInput(): InputEntry | undefined {
    return [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs].find(
      (entry) =>
        !isWarmupInput(entry) &&
        (!queuedFollowup(entry) || entry.state === 'browser') &&
        ['queued', 'browser'].includes(entry.state) &&
        (runtime.selectedId
          ? (entry.sessionId ?? entry.deliveredSessionId) === runtime.selectedId
          : runtime.pendingNewInput?.generation === runtime.selectionGeneration &&
            runtime.pendingNewInput.id === entry.id),
    );
  }

  return {
    historicalAutomaticInput,
    inputMessageRow,
    adoptAcceptedOpening,
    pendingComposerInput,
    paintPendingInputs,
    refreshInputQueue,
    retryPlannedInput,
    showAutoSkillReceipt,
  };
}
