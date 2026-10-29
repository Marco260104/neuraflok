import type { InputAttachment, InputImage } from '../../../contracts/input.js';
import {
  isDeepseekDirectUpload,
  isDeepseekSupportedAttachment,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  isSupportedProviderImageAttachment
} from '../../../contracts/attachments.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { $, el, run, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

export type ComposerDraftOwner = { key: string; generation: number };
export type ComposerAttachment = InputImage | InputAttachment;
type UploadState = 'uploading' | 'ready' | 'failed';

export const imageDrafts = new Map<string, ComposerAttachment[]>();
const uploadStates = new Map<string, UploadState>();
const uploadPromises = new Map<string, Promise<boolean>>();

export async function waitForComposerAttachmentUploads(attachments: ComposerAttachment[]): Promise<boolean> {
  const files = attachments.filter((file): file is InputAttachment => 'id' in file);
  const pending = files.map(file => uploadPromises.get(file.id)).filter((promise): promise is Promise<boolean> => !!promise);
  if (pending.length && !(await Promise.all(pending)).every(Boolean)) return false;
  return files.every(file => uploadStates.get(file.id) !== 'failed');
}

export function composerAttachmentUploadState(file: InputAttachment): UploadState | undefined {
  return uploadStates.get(file.id);
}

interface Runtime {
  api: Pick<typeof window.api, 'chooseFiles' | 'dropFiles' | 'attachText' | 'ensureAttachmentSession' | 'uploadProviderAttachments' | 'removeProviderAttachments'>;
  draftKey(): string;
  owner(): ComposerDraftOwner;
  ownsOwner(owner: ComposerDraftOwner): boolean;
  get selectedId(): string | null;
  get selectedProjectId(): string | null;
  get sessions(): SessionSummary[];
  set sessions(value: SessionSummary[]);
  inputDrafts: Map<string, string>;
  authoredComposerText(): string;
  selectSession(id: string): void;
  paintSessions(): void;
  run: typeof run;
  attachmentCard(file: InputAttachment, inComposer?: boolean, uploadStatus?: UploadState): HTMLElement;
  paintDeliveryControls(): void;
}

export function createChatComposerAttachments(runtime: Runtime) {
  const uploadQueues = new Map<string, Promise<void>>();
  const uploadSessions = new Map<string, SessionSummary>();
  const removingAttachments = new Set<string>();

  function uploadQueueKey(ownerKey: string): string {
    for (const [key, session] of uploadSessions) {
      if (session.id === ownerKey) return key;
    }
    return ownerKey;
  }

  function paint(): void {
    const key = runtime.draftKey();
    const images = imageDrafts.get(key) ?? [];
    const box = $('composerImages');
    box.hidden = !images.length;
    box.replaceChildren();
    images.forEach(image => {
      const uploadStatus = 'id' in image ? uploadStates.get(image.id) : undefined;
      const tile = 'dataUrl' in image ? el('div', 'composer-image') : runtime.attachmentCard(image, true, uploadStatus);
      if ('dataUrl' in image) {
        const preview = document.createElement('img');
        preview.src = image.dataUrl;
        preview.alt = image.name;
        tile.append(preview);
      }
      const remove = el('button', 'image-remove', '×') as HTMLButtonElement;
      remove.setAttribute('type', 'button');
      ui(remove, 'aria-label', () => t('Remove {0}', [image.name]));
      const attachmentId = 'id' in image ? image.id : '';
      remove.disabled = Boolean(attachmentId && removingAttachments.has(attachmentId));
      if (remove.disabled) remove.setAttribute('aria-busy', 'true');
      remove.addEventListener('click', async () => {
        if ('id' in image) {
          const currentStatus = uploadStates.get(image.id);
          const session = uploadSessions.get(key) ?? runtime.sessions.find(row => row.id === key);
          const provider = session?.conversationId ? providerForConversationId(session.conversationId) : null;
          const isDeepSeekUpload = provider === 'deepseek' && currentStatus !== undefined;
          if (isDeepSeekUpload) {
            if (removingAttachments.has(image.id)) return;
            removingAttachments.add(image.id);
            paint();
            try {
              // If the user removes a file while it is being uploaded, wait for
              // that single in-flight transfer. A failed transfer never became
              // a confirmed provider attachment, so it must remain removable
              // locally without asking DeepSeek to remove a chip that may not exist.
              const uploading = uploadPromises.get(image.id);
              if (uploading) await uploading;
              if (uploadStates.get(image.id) === 'ready') {
                const result = await runtime.run(runtime.api.removeProviderAttachments(session!.id, [image]));
                if (result?.removed !== true) throw new Error('DeepSeek could not confirm that the file was removed.');
              }
              uploadStates.delete(image.id);
              uploadPromises.delete(image.id);
            } catch (error) {
              const message = error instanceof Error ? error.message : 'DeepSeek could not confirm that the file was removed.';
              toast(t(message));
              return;
            } finally {
              removingAttachments.delete(image.id);
              paint();
            }
          }
        }
        if ('id' in image && uploadStates.get(image.id) === 'failed') {
          uploadStates.delete(image.id);
          uploadPromises.delete(image.id);
        }
        const current = imageDrafts.get(key) ?? [];
        imageDrafts.set(key, current.filter(entry => entry !== image && (!('id' in entry && 'id' in image) || entry.id !== image.id)));
        paint();
      });
      tile.append(remove);
      box.append(tile);
    });
    runtime.paintDeliveryControls();
  }

  function providerFiles(owner: ComposerDraftOwner, chosen: InputAttachment[]): InputAttachment[] {
    const session = runtime.sessions.find(row => row.id === owner.key);
    const provider = session?.conversationId
      ? providerForConversationId(session.conversationId)
      : $('webProvider') instanceof HTMLSelectElement ? $<HTMLSelectElement>('webProvider').value : 'deepseek';
    if (provider !== 'deepseek') return [];
    return chosen.filter(file => isDeepseekDirectUpload(file.name, file.mimeType));
  }

  function queueProviderUpload(
    owner: ComposerDraftOwner,
    files: InputAttachment[],
    selectedSessionId: string | null,
    projectId: string | null
  ): void {
    if (!files.length) return;
    const queueKey = uploadQueueKey(owner.key);
    const previous = uploadQueues.get(queueKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      try {
        let session = uploadSessions.get(queueKey) ?? uploadSessions.get(owner.key);
        if (!session) {
          session = await runtime.run(runtime.api.ensureAttachmentSession(selectedSessionId, projectId)) ?? undefined;
          if (!session) throw new Error('Could not prepare a DeepSeek chat for the attachment.');
          uploadSessions.set(queueKey, session);
          uploadSessions.set(owner.key, session);

          const oldKey = owner.key;
          const oldImages = imageDrafts.get(oldKey) ?? files;
          const currentText = runtime.ownsOwner(owner)
            ? runtime.authoredComposerText()
            : runtime.inputDrafts.get(oldKey) ?? '';
          if (session.id !== oldKey) {
            const currentSessionImages = imageDrafts.get(session.id) ?? [];
            const mergedImages = new Map<string, ComposerAttachment>();
            for (const image of [...oldImages, ...currentSessionImages]) {
              mergedImages.set('id' in image ? `file:${image.id}` : `image:${image.name}:${image.dataUrl.slice(-20)}`, image);
            }
            imageDrafts.set(session.id, [...mergedImages.values()]);
            runtime.inputDrafts.set(session.id, currentText);
            runtime.sessions = [...runtime.sessions.filter(row => row.id !== session!.id), session];
            runtime.paintSessions();
            if (runtime.ownsOwner(owner)) runtime.selectSession(session.id);
            imageDrafts.delete(oldKey);
            runtime.inputDrafts.delete(oldKey);
            paint();
          }
        }
        uploadSessions.set(queueKey, session);
        uploadSessions.set(owner.key, session);

        const draftFiles = imageDrafts.get(session.id) ?? imageDrafts.get(owner.key) ?? [];
        const draftIds = new Set(draftFiles.filter((entry): entry is InputAttachment => 'id' in entry).map(entry => entry.id));
        const remaining = files.filter(file => draftIds.has(file.id));
        if (!remaining.length) {
          for (const file of files) {
            uploadStates.delete(file.id);
            uploadPromises.delete(file.id);
          }
          paint();
          return;
        }
        const result = await runtime.run(runtime.api.uploadProviderAttachments(session.id, remaining));
        const ready = result?.ready === true && result.attachmentIds.length === remaining.length;
        if (!ready) throw new Error('DeepSeek did not confirm that the files finished uploading.');
        for (const file of remaining) uploadStates.set(file.id, 'ready');
      } catch (error) {
        for (const file of files) uploadStates.set(file.id, 'failed');
        if (error instanceof Error && !uploadStates.has(files[0]?.id ?? '')) toast(t(error.message));
      } finally {
        for (const file of files) uploadPromises.delete(file.id);
        paint();
      }
    });
    uploadQueues.set(queueKey, next);
    for (const file of files) {
      uploadStates.set(file.id, 'uploading');
      const finished = next.then(() => uploadStates.get(file.id) === 'ready');
      uploadPromises.set(file.id, finished);
    }
    paint();
    void next.finally(() => {
      if (uploadQueues.get(queueKey) === next) uploadQueues.delete(queueKey);
    });
  }

  function append(owner: ComposerDraftOwner, chosen: InputAttachment[] | null | undefined): boolean {
    if (!chosen?.length) return false;
    if (!runtime.ownsOwner(owner)) {
      toast(t('Files were not added because the draft changed.'));
      return false;
    }
    const supported = chosen.filter(file => isDeepseekSupportedAttachment(file.name, file.mimeType));
    if (supported.length !== chosen.length) {
      toast(t('Unsupported file format. DeepSeek accepts PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, images, text, and code files.'));
      if (!supported.length) return false;
    }
    const oversized = supported.some(file => 'size' in file && file.size > MAX_ATTACHMENT_SIZE_BYTES);
    if (oversized) {
      toast(t('Each attachment must be 100 MB or smaller'));
      return false;
    }
    const combined = [...(imageDrafts.get(owner.key) ?? []), ...supported];
    if (combined.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      toast(t('Attach up to 50 files per message'));
      return false;
    }
    imageDrafts.set(owner.key, combined);
    const files = providerFiles(owner, supported);
    if (files.length) {
      const missing = files.filter(file => uploadStates.get(file.id) !== 'ready' && uploadStates.get(file.id) !== 'uploading');
      const selectedSession = runtime.selectedId;
      const selectedProject = runtime.sessions.find(row => row.id === selectedSession)?.projectId ?? runtime.selectedProjectId;
      if (missing.length) queueProviderUpload(owner, missing, selectedSession, selectedProject);
      else paint();
    } else paint();
    return true;
  }

  function bindFilePicker(): void {
    $('attachImages').addEventListener('click', async () => {
      const owner = runtime.owner();
      append(owner, await runtime.run(runtime.api.chooseFiles()));
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
        const file = await runtime.run(runtime.api.attachText(text));
        if (file) append(owner, [file]);
      }
    });
    window.addEventListener('paste', async event => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(file =>
        file.type?.startsWith('image/') || isSupportedProviderImageAttachment(file.name, file.type ?? ''));
      if (!files.length) return;
      event.preventDefault();
      const owner = runtime.owner();
      if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > MAX_ATTACHMENTS_PER_MESSAGE) {
        toast(t('Attach up to 50 files per message'));
        return;
      }
      append(owner, await runtime.run(runtime.api.dropFiles(files)));
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
      if (files.length + (imageDrafts.get(owner.key)?.length ?? 0) > MAX_ATTACHMENTS_PER_MESSAGE) {
        toast(t('Attach up to 50 files per message'));
        return;
      }
      append(owner, await runtime.run(runtime.api.dropFiles(files)));
    });
  }

  return { append, bindDropTargets, bindFilePicker, paint };
}
