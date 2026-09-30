import type { InputAttachment, InputImage } from '../../../contracts/input.js';
import { $, el, run, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

export type ComposerDraftOwner = { key: string; generation: number };
export type ComposerAttachment = InputImage | InputAttachment;

export const imageDrafts = new Map<string, ComposerAttachment[]>();

interface Runtime {
  draftKey(): string;
  owner(): ComposerDraftOwner;
  ownsOwner(owner: ComposerDraftOwner): boolean;
  attachmentCard(file: InputAttachment, inComposer?: boolean): HTMLElement;
  paintDeliveryControls(): void;
}

export function createChatComposerAttachments(runtime: Runtime) {
  function paint(): void {
    const key = runtime.draftKey();
    const images = imageDrafts.get(key) ?? [];
    const box = $('composerImages');
    box.hidden = !images.length;
    box.replaceChildren();
    images.forEach((image, index) => {
      const tile = 'dataUrl' in image ? el('div', 'composer-image') : runtime.attachmentCard(image, true);
      if ('dataUrl' in image) {
        const preview = document.createElement('img');
        preview.src = image.dataUrl;
        preview.alt = image.name;
        tile.append(preview);
      }
      const remove = el('button', 'image-remove', '×');
      remove.setAttribute('type', 'button');
      ui(remove, 'aria-label', () => t('Remove {0}', [image.name]));
      remove.addEventListener('click', () => {
        imageDrafts.set(key, images.filter((_entry, at) => at !== index));
        paint();
      });
      tile.append(remove);
      box.append(tile);
    });
    runtime.paintDeliveryControls();
  }

  function append(owner: ComposerDraftOwner, chosen: InputAttachment[] | null | undefined): boolean {
    if (!chosen?.length) return false;
    if (!runtime.ownsOwner(owner)) {
      toast(t('Files were not added because the draft changed.'));
      return false;
    }
    const combined = [...(imageDrafts.get(owner.key) ?? []), ...chosen];
    const bytes = combined.reduce((sum, file) => sum + ('size' in file ? file.size : 0), 0);
    if (combined.length > 20 || bytes > 512 * 1024 * 1024) {
      toast(t('Attach up to 20 files and 512 MB per message'));
      return false;
    }
    imageDrafts.set(owner.key, combined);
    paint();
    return true;
  }

  function bindFilePicker(): void {
    $('attachImages').addEventListener('click', async () => {
      const owner = runtime.owner();
      append(owner, await run(window.api.chooseFiles()));
    });
  }

  function bindDropTargets(): void {
    $('composer').addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.some(type => type === 'text/plain') || event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    $('composer').addEventListener('drop', async event => {
      if (!event.dataTransfer?.types.some(type => type === 'text/plain') || event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      const text = event.dataTransfer.getData('text/plain');
      const owner = runtime.owner();
      if (text) {
        const file = await run(window.api.attachText(text));
        if (file) append(owner, [file]);
      }
    });
    window.addEventListener('paste', async event => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      const owner = runtime.owner();
      if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > 20) {
        toast(t('Attach up to 20 files per message'));
        return;
      }
      append(owner, await run(window.api.dropFiles(files)));
    });
    window.addEventListener('dragover', event => {
      if ((event.target as Element | null)?.closest?.('#foldersCard') || !event.dataTransfer?.types?.includes?.('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', async event => {
      if ((event.target as Element | null)?.closest?.('#foldersCard') || !event.dataTransfer?.types?.includes?.('Files')) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files);
      const owner = runtime.owner();
      if (!files.length) return;
      if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > 20) {
        toast(t('Attach up to 20 files per message'));
        return;
      }
      append(owner, await run(window.api.dropFiles(files)));
    });
  }

  return { append, bindDropTargets, bindFilePicker, paint };
}
