import { isAstraModel } from '../../../contracts/model-capabilities.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import { el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import type { QueuedTaskListRuntime } from './queued-task-list.js';

export type PausedHelper = { id: string; sourceSessionId: string };
type Reorder = (from: string, to: string, after: boolean) => Promise<void>;

export interface QueuedTaskCardOptions {
  queueSession: string | null;
  selection: number;
  taskList: HTMLElement;
  queuedTasks: InputEntry[];
  projected: boolean;
  optimistic?: boolean;
  reorder: Reorder;
}

export function createQueuedTaskCard(
  runtime: QueuedTaskListRuntime,
  entry: InputEntry,
  options: QueuedTaskCardOptions,
): HTMLElement {
  const { queueSession, selection, taskList, queuedTasks, projected, optimistic = false, reorder } = options;
  const card = el('div', 'queued-input');
  card.dataset.inputId = entry.id;
  if (projected)
    ui(card, 'aria-label', () => t('Plan stage · waiting for the first message to be sent'));
  if (entry.recovery) ui(card, 'aria-label', () => t('Automatic Continue'));
  const label = el(
    'span',
    'queue-label',
    entry.recovery ? () => `${t('Automatic Continue')} · ${entry.text}` : entry.text,
  );
  ui(label, 'title', () => `${entry.recovery
    ? t('Resumes without a final answer. If the provider is still generating, the turn is stopped before Continue is sent.')
    : entry.state === 'queued'
      ? entry.mode === 'after-turn'
        ? t('After the next completed answer')
        : t('At Session finish or after a completed answer')
      : t('Awaiting receipt')} · ${entry.text}`);
  label.dir = 'auto';
  card.append(icon(entry.recovery ? 'i-pulse' : 'i-clock'), label);
  if (optimistic) {
    card.classList.add('is-pending-admission');
    card.append(el('span', 'queue-pending', () => t('Queued')));
    return card;
  }
  if (entry.state !== 'queued') return card;

  const retireCard = () => {
    card.remove();
    taskList.hidden = taskList.childElementCount === 0;
  };
  const cancel = runtime.dockAction(
    () => entry.recovery ? t('Cancel automatic Continue') : t('Remove queued task'),
    'i-trash',
    () => {},
  );
  cancel.onclick = async () => {
    if (cancel.disabled || !card.isConnected || selection !== runtime.selectionGeneration) return;
    cancel.disabled = true;
    const removed = await runtime.run(runtime.api.cancelInput(entry.id));
    if (!card.isConnected || selection !== runtime.selectionGeneration) return;
    if (removed === true || removed === false) {
      runtime.inputQueueGeneration++;
      if (removed)
        runtime.pendingComposerInputs = runtime.pendingComposerInputs.filter(row => row.id !== entry.id);
      retireCard();
      void runtime.refreshInputQueue();
    } else cancel.disabled = false;
  };
  if (entry.recovery) {
    card.append(cancel);
    return card;
  }

  const session = runtime.sessions.find(row => row.id === runtime.selectedId);
  const modelSelection = session?.selectedModel;
  if (entry.mode === 'finish' && modelSelection?.conversationId === session?.conversationId &&
      isAstraModel(modelSelection?.model, modelSelection?.reasoningEffort)) {
    const delivery = el('button', 'btn queue-delivery', () =>
      entry.afterTurn === true ? t('Also after turn') : t('Finish only')) as HTMLButtonElement;
    delivery.type = 'button';
    ui(delivery, 'aria-label', () => t('Also send this task as a new message after Astra finishes its turn'));
    delivery.setAttribute('aria-pressed', String(entry.afterTurn === true));
    ui(delivery, 'title', () => entry.afterTurn === true
      ? t('At Session Finish, or as a new message after verified turn completion')
      : t('Only inside the Session Finish tool result; never start a new turn'));
    delivery.onclick = async () => {
      delivery.disabled = true;
      await runtime.run(runtime.api.editQueuedInput(entry.id, entry.text, entry.afterTurn !== true));
      void runtime.refreshInputQueue();
    };
    card.append(delivery);
  }

  label.draggable = true;
  label.tabIndex = 0;
  ui(label, 'title', () => t('Drag to reorder. Alt + Up/Down also moves this task.'));
  label.ondragstart = event => {
    card.classList.add('is-dragging');
    event.dataTransfer?.setData('application/x-neuraflok-queued-input', `${queueSession}:${entry.id}`);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  };
  label.ondragend = () => {
    card.classList.remove('is-dragging');
    void runtime.refreshInputQueue();
  };
  card.ondragover = event => {
    if (event.dataTransfer?.types.includes('application/x-neuraflok-queued-input')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  };
  card.ondrop = event => {
    const value = event.dataTransfer?.getData('application/x-neuraflok-queued-input') ?? '';
    if (!queueSession || !value.startsWith(`${queueSession}:`)) return;
    event.preventDefault();
    void reorder(
      value.slice(queueSession.length + 1),
      entry.id,
      event.clientY > card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2,
    );
  };
  label.onkeydown = event => {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const ids = queuedTasks.filter(row => row.state === 'queued' && !row.recovery).map(row => row.id);
    const next = ids[ids.indexOf(entry.id) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) void reorder(entry.id, next, event.key === 'ArrowDown');
  };
  const edit = runtime.dockAction(() => t('Edit queued task'), 'i-pencil', () => {});
  edit.onclick = () => {
    if (!card.isConnected || selection !== runtime.selectionGeneration) return;
    const field = document.createElement('textarea');
    field.dir = 'auto';
    field.value = entry.text;
    ui(field, 'aria-label', () => t('Queued task'));
    const contents = [...card.childNodes];
    const save = el('button', 'btn', () => t('Save')) as HTMLButtonElement;
    save.type = 'button';
    save.onclick = async () => {
      if (save.disabled || cancel.disabled || !card.isConnected || selection !== runtime.selectionGeneration) return;
      const value = field.value;
      if (!value.trim()) {
        cancel.click();
        return;
      }
      save.disabled = true;
      cancel.disabled = true;
      ui(save, 'textContent', () => t('Saving…'));
      field.readOnly = true;
      try {
        const saved = await runtime.run(runtime.api.editQueuedInput(entry.id, value));
        if (!card.isConnected || selection !== runtime.selectionGeneration) return;
        if (saved) {
          // A durable edit receipt completes Save even when queue refresh is delayed.
          entry.text = value.trim();
          label.textContent = entry.text;
          card.classList.remove('is-editing');
          card.replaceChildren(...contents);
          runtime.inputQueueGeneration++;
          void runtime.refreshInputQueue();
        } else if (saved === false) {
          // Drop stale editor state when the durable row is no longer editable.
          runtime.inputQueueGeneration++;
          retireCard();
          void runtime.refreshInputQueue();
        }
      } catch (error) {
        runtime.toast(error instanceof Error ? error.message : t('Could not save this task.'));
      } finally {
        save.disabled = false;
        cancel.disabled = false;
        ui(save, 'textContent', () => t('Save'));
        field.readOnly = false;
      }
    };
    card.classList.add('is-editing');
    card.replaceChildren(field, save, cancel);
    field.focus();
  };
  card.append(edit, cancel);
  return card;
}

export function createPausedHelperCard(runtime: QueuedTaskListRuntime, helper: PausedHelper): HTMLElement {
  const row = el('div', 'queued-input');
  row.append(el('span', '', () => t('Helper delivery was not confirmed. Its old chat may still be running.')));
  const retry = el('button', 'btn', () => t('Start a new helper'));
  retry.setAttribute('type', 'button');
  retry.onclick = async () => {
    retry.setAttribute('disabled', '');
    const accepted = await runtime.run(runtime.api.retryHelper(helper.id, helper.sourceSessionId));
    if (accepted) runtime.toast(t('New helper authorized for this chat'));
    else runtime.toast(t('This helper has changed. Refreshing its status.'));
    void runtime.refreshInputQueue();
  };
  row.append(retry);
  return row;
}
