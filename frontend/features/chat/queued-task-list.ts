import { queuedFollowup } from '../../../contracts/input.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { $ } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';
import { createPausedHelperCard, createQueuedTaskCard, type PausedHelper } from './queued-task-card.js';

export interface QueuedTaskListRuntime {
  selectedId: string | null;
  selectionGeneration: number;
  pendingNewInput: { id: string; generation: number } | null;
  startingInputs: Map<string, InputEntry>;
  run: typeof import('../../shared/dom.js').run;
  api: Pick<typeof window.api, 'cancelInput' | 'editQueuedInput' | 'reorderQueuedInputs' | 'retryHelper'>;
  toast: typeof import('../../shared/dom.js').toast;
  refreshInputQueue: () => Promise<void>;
  reconcileChildren: (parent: Element, children: HTMLElement[]) => void;
  dockAction: (label: string | (() => string), symbol: string, click: (event: MouseEvent) => void) => HTMLButtonElement;
  inputQueueGeneration: number;
  pendingComposerInputs: InputEntry[];
  sessions: SessionSummary[];
  paintDetail: (followBottom?: boolean) => void;
}

type Runtime = QueuedTaskListRuntime;

// Owns the visual queue for follow-up tasks and paused helper deliveries.
export function createQueuedTaskList(runtime: Runtime) {
  function paint(
    all: InputEntry[],
    pausedHelpers: PausedHelper[] | null,
    selection: number,
  ): void {
    const belongsToSelection = (entry: {
      id: string;
      sessionId: string | null;
      deliveredSessionId?: string | null;
    }): boolean =>
      runtime.selectedId === null
        ? runtime.pendingNewInput?.generation === runtime.selectionGeneration &&
          entry.id === runtime.pendingNewInput.id
        : (entry.sessionId ?? entry.deliveredSessionId) === runtime.selectedId;
    const queuedTasks = all.filter(
      (entry) =>
        belongsToSelection(entry) &&
        queuedFollowup(entry) &&
        ['queued', 'tool', 'browser'].includes(entry.state),
    );
    // Keep every accepted plan stage visible until its durable queue row appears.
    const staged = [
      ...all,
      ...[...runtime.startingInputs.values()].filter(
        (entry) => !all.some((row) => row.id === entry.id),
      ),
    ].filter(
      (entry) =>
        belongsToSelection(entry) &&
        !entry.stagesApplied &&
        ['queued', 'browser', 'tool'].includes(entry.state),
    );
    const projectedIds = new Set<string>();
    for (const entry of staged)
      for (const [index, text] of (entry.stages ?? []).entries()) {
        const id = `${entry.id}:stage:${index}`;
        projectedIds.add(id);
        queuedTasks.push({
          ...entry,
          id,
          text,
          mode: 'finish',
          state: 'browser',
          stages: undefined,
        });
      }
    const queueSession = runtime.selectedId;
    const reorder = async (from: string, to: string, after: boolean) => {
      if (!queueSession || runtime.selectedId !== queueSession) return;
      const ids = queuedTasks
        .filter((row) => row.state === 'queued' && !row.recovery)
        .map((row) => row.id);
      if (from === to || !ids.includes(from) || !ids.includes(to)) return;
      ids.splice(ids.indexOf(from), 1);
      ids.splice(ids.indexOf(to) + Number(after), 0, from);
      const saved = await runtime.run(
        runtime.api.reorderQueuedInputs(queueSession, ids),
      );
      if (saved === false)
        runtime.toast(t('The queue changed during the move. Try again.'));
      void runtime.refreshInputQueue();
    };
    const taskList = $('finishQueue');
    taskList.hidden = queuedTasks.length === 0;
    const oldCards = new Map(
      [...taskList.children].map((node) => [
        (node as HTMLElement).dataset.inputId,
        node as HTMLElement,
      ]),
    );
    const dragging = !!taskList.querySelector('.is-dragging');
    runtime.reconcileChildren(
      taskList,
      queuedTasks.map((entry) => {
        const existing = oldCards.get(entry.id);
        if (dragging && existing) return existing;
        if (
          entry.state === 'queued' &&
          existing?.classList.contains('is-editing')
        )
          return existing;
        return createQueuedTaskCard(runtime, entry, {
          queueSession,
          selection,
          taskList,
          queuedTasks,
          projected: projectedIds.has(entry.id),
          reorder,
        });
      }),
    );
    runtime.paintDetail(false);
    for (const node of $('inputQueue').querySelectorAll(
      ':scope > .queued-input',
    ))
      node.remove();
    for (const helper of pausedHelpers ?? []) {
      if (helper.sourceSessionId !== runtime.selectedId) continue;
      $('inputQueue').append(createPausedHelperCard(runtime, helper));
    }
  }

  return { paint };
}
