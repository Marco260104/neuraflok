import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { ChatInputQueueRuntime } from './chat-input-queue.js';
import { $, el, icon } from '../../shared/dom.js';
import { currentLanguage, t, ui } from '../../shared/i18n.js';

type Runtime = Pick<ChatInputQueueRuntime,
  | 'visibleInputIds'
  | 'attachmentCard'
  | 'hasLaterModelActivity'
  | 'dockAction'
  | 'api'
  | 'run'
  | 'dismissInputNotice'
  | 'authoredComposerText'
  | 'imageDrafts'
  | 'draftKey'
  | 'toast'
  | 'replaceComposerDraft'
  | 'rememberDraft'
  | 'skillPicker'
  | 'paintComposerImages'
  | 'paintDeliveryControls'
>;

export function createChatInputRows(
  runtime: Runtime,
  refreshInputQueue: () => Promise<void>,
  retryPlannedInput: (entry: InputEntry) => Promise<void>
) {
  function historicalAutomaticInput(entry: InputEntry): boolean {
    return (
      (!!entry.recovery ||
        (!!entry.finishOwner && !entry.finishOwner.userRequested)) &&
      entry.state === 'cancelled' &&
      !!entry.error
    );
  }

  function inputMessageRow(entry: InputEntry, notice: boolean): HTMLElement {
    const row = el('div', 'pending-message');
    const looksSent = !entry.error && ['queued', 'browser', 'sent', 'tool'].includes(entry.state);
    const preparing = !entry.error && entry.state === 'queued';
    row.classList.toggle('is-delivered', looksSent);
    if (preparing) row.dataset.phase = 'preparing';
    row.classList.toggle(
      'is-delivery-error',
      !!entry.error || entry.state === 'failed',
    );
    row.dataset.inputId = entry.id;
    row.dataset.timelineKey = `input:${entry.id}`;
    if (!runtime.visibleInputIds.has(entry.id))
      row.classList.add('is-entering');
    runtime.visibleInputIds.add(entry.id);
    if (runtime.visibleInputIds.size > 100)
      runtime.visibleInputIds.delete(
        runtime.visibleInputIds.values().next().value!,
      );
    const status = () =>
      entry.error
        ? t(entry.error)
        : entry.state === 'failed'
          ? t('Delivery not confirmed')
          : entry.state === 'decision'
            ? t('Preparing follow-up')
            : entry.state === 'browser'
              ? t('Delivery confirmation pending')
              : entry.state === 'tool'
                ? t('Sent to the active turn · awaiting receipt')
                : entry.dueAt > Date.now()
                  ? t('Scheduled {0}', [
                      new Date(entry.dueAt).toLocaleString(currentLanguage()),
                    ])
                  : entry.delivery === 'tool'
                    ? t('Waiting for the next tool call')
                    : looksSent
                      ? ''
                      : t('Queued');
    const files = el('div', 'message-attachments');
    if (entry.attachments?.length)
      files.append(
        ...entry.attachments.map((file) => runtime.attachmentCard(file)),
      );
    for (const image of entry.images ?? []) {
      const preview = document.createElement('img');
      preview.src = image.dataUrl;
      preview.alt = image.name;
      files.append(preview);
    }
    if (files.childElementCount) row.append(files);
    if (entry.text) {
      const text = el('div', 'pending-message-text', entry.text);
      text.setAttribute('dir', 'auto');
      row.append(text);
    }
    const receipt = el('span', 'pending-message-status');
    ui(receipt, 'title', status);
    ui(receipt, 'aria-label', status);
    if (entry.error || entry.state === 'failed') {
      ui(receipt, 'textContent', status);
    } else
      receipt.append(icon(looksSent ? 'i-check' : 'i-clock'));
    receipt.hidden =
      looksSent &&
      runtime.hasLaterModelActivity(
        entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt,
      );
    row.append(receipt);
    if (notice) {
      const dismiss = runtime.dockAction(
        () => t('Dismiss delivery notice'),
        'i-x',
        () => {},
      );
      dismiss.onclick = async () => {
        dismiss.disabled = true;
        const result = await runtime.run(runtime.api.cancelInput(entry.id));
        if (result) runtime.dismissInputNotice(entry.id);
        else dismiss.disabled = false;
        void refreshInputQueue();
      };
      row.append(dismiss);
      const retry = runtime.dockAction(
        () => t('Retry delivery'),
        'i-retry',
        () => {},
      );
      retry.classList.add('delivery-retry');
      const unqueuedPlan = entry.stages !== undefined && !entry.stagesApplied;
      ui(retry, 'title', () =>
        unqueuedPlan
          ? t('Retry stage one with the complete plan and queued checkpoints')
          : t('Restore this message to the composer for review and sending'),
      );
      retry.onclick = () => {
        if (unqueuedPlan) {
          void retryPlannedInput(entry);
          return;
        }
        const input = $<HTMLTextAreaElement>('chatInput');
        if (
          runtime.authoredComposerText().trim() ||
          runtime.imageDrafts.get(runtime.draftKey())?.length
        ) {
          runtime.toast(
            t('Send or clear your current draft before retrying this message.'),
          );
          return;
        }
        runtime.replaceComposerDraft();
        input.value = entry.text;
        if (entry.images?.length)
          runtime.imageDrafts.set(runtime.draftKey(), [...entry.images]);
        if (entry.attachments?.length)
          runtime.imageDrafts.set(runtime.draftKey(), [
            ...(entry.images ?? []),
            ...entry.attachments,
          ]);
        runtime.rememberDraft();
        runtime.skillPicker?.restore();
        runtime.paintComposerImages();
        runtime.paintDeliveryControls();
        input.focus();
        runtime.dismissInputNotice(entry.id);
      };
      row.append(retry);
    }
    if (['queued', 'browser'].includes(entry.state)) {
      const cancel = runtime.dockAction(
        () => t('Cancel delivery'),
        'i-x',
        () => {},
      );
      cancel.onclick = async () => {
        cancel.disabled = true;
        const result = await runtime.run(runtime.api.cancelInput(entry.id));
        if (result) runtime.dismissInputNotice(entry.id);
        void refreshInputQueue();
      };
      row.append(cancel);
    }
    if (
      entry.state === 'queued' &&
      entry.mode === 'auto' &&
      (entry.error?.startsWith('Message queued.') ||
        entry.error?.startsWith('Local chat setup failed:'))
    ) {
      const retry = runtime.dockAction(
        () => t('Retry message'),
        'i-retry',
        () => {},
      );
      retry.classList.add('delivery-retry');
      retry.onclick = async () => {
        retry.setAttribute('disabled', '');
        await runtime.run(runtime.api.retryInputBrowser(entry.id));
        void refreshInputQueue();
      };
      row.append(retry);
    }
    return row;
  }
  return { historicalAutomaticInput, inputMessageRow };
}
