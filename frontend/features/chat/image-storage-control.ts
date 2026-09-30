import { el, run, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import type { ImageStorageClearResult } from '../../../contracts/session.js';

type ClearMode = 'oldest-gib' | 'all';
type CleanupResult = ImageStorageClearResult | null;
type CleanupOperation =
  | { phase: 'running'; completion: Promise<CleanupResult> }
  | { phase: 'finished'; result: CleanupResult };

let cleanupOperation: CleanupOperation | null = null;

export function imageStorageButton(): HTMLButtonElement {
  const button = el('button', 'btn small', () => t('Free image storage')) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', openCleanupDialog);
  return button;
}

function openCleanupDialog(): void {
  if (document.querySelector('.image-storage-dialog')) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'image-storage-dialog';
  ui(dialog, 'aria-label', () => t('Free image storage'));

  const status = el('p', 'muted', () => t('Loading storage usage…'));
  status.setAttribute('role', 'status');
  const actions = el('div', 'image-storage-actions');
  const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());

  dialog.append(
    el('h3', '', () => t('Free image storage')),
    status,
    el('p', '', () => t('Remove local recorded image copies. Chat text, original files and pending attachments stay. Removed previews will no longer be available in old chats.')),
    actions,
    close
  );
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();

  const renderOperation = () => renderCleanupState(dialog, status, actions);
  const choices: ReadonlyArray<{ mode: ClearMode; label: string }> = [
    { mode: 'oldest-gib', label: 'Free oldest 1 GB' },
    { mode: 'all', label: 'Remove all recorded images' }
  ];

  for (const choice of choices) {
    const action = el('button', 'btn', () => t(choice.label)) as HTMLButtonElement;
    action.type = 'button';
    action.addEventListener('click', () => {
      requestCleanup(choice.mode, dialog, status, actions);
    });
    actions.append(action);
  }

  if (cleanupOperation?.phase === 'running') {
    const operation = cleanupOperation;
    renderOperation();
    void operation.completion.then(renderOperation);
    return;
  }

  if (cleanupOperation?.phase === 'finished') {
    renderOperation();
    return;
  }

  void run(window.api.getImageStorage()).catch(() => null).then(usage => {
    if (!dialog.isConnected || cleanupOperation) return;
    ui(status, 'textContent', () => usage
      ? t('{0} GB used of {1} GB', [(usage.usedBytes / 2 ** 30).toFixed(2), (usage.limitBytes / 2 ** 30).toFixed(0)])
      : t('Storage usage could not be read.'));
  });
}

function requestCleanup(
  mode: ClearMode,
  dialog: HTMLDialogElement,
  status: HTMLElement,
  actions: HTMLElement
): void {
  if (cleanupOperation?.phase === 'running') return;

  const allImages = mode === 'all';
  const confirmation = allImages
    ? t('Permanently remove all local recorded images? Chat text and original files will stay.')
    : t('Permanently remove about 1 GB of the oldest local recorded images? Chat text and original files will stay.');
  if (!window.confirm(confirmation)) return;

  const completion = run(window.api.clearImageStorage(mode)).catch(() => null);
  const operation: CleanupOperation = { phase: 'running', completion };
  cleanupOperation = operation;
  renderCleanupState(dialog, status, actions);

  void completion.then(result => {
    if (cleanupOperation === operation) cleanupOperation = { phase: 'finished', result };
    renderCleanupState(dialog, status, actions);
    toast(cleanupResultText(result));
  });
}

function renderCleanupState(dialog: HTMLDialogElement, status: HTMLElement, actions: HTMLElement): void {
  if (!dialog.isConnected || !cleanupOperation) return;

  const running = cleanupOperation.phase === 'running';
  if (running) dialog.setAttribute('aria-busy', 'true');
  else dialog.removeAttribute('aria-busy');
  for (const button of actions.querySelectorAll('button')) button.disabled = running;

  const result = cleanupOperation.phase === 'finished' ? cleanupOperation.result : null;
  const message = running
    ? t('Removing recorded images in the background. You can close this window.')
    : cleanupResultText(result);
  ui(status, 'textContent', () => message);
}

function cleanupResultText(result: CleanupResult): string {
  return result
    ? t('Freed {0} MB. {1} GB of image storage is now available.', [
        (result.freedBytes / 2 ** 20).toFixed(1),
        (Math.max(0, result.limitBytes - result.usedBytes) / 2 ** 30).toFixed(2)
      ])
    : t('Image cleanup failed. No further cleanup was requested.');
}
