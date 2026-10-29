import type { InputAttachment } from '../../../contracts/input.js';
import { isDeepseekDirectUpload, MAX_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '../../../contracts/attachments.js';
import { readProviderUploadAttachment } from '../sessions/input/attachments/index.js';
import { requestProviderPageComplete, waitForProviderPageIdle, type ProviderPageAttachment, type ProviderPageAttachmentSource } from './provider-page.js';

const MAX_UPLOAD_ATTEMPTS = 3;
const INITIAL_UPLOAD_RETRY_MS = 1_000;
const MAX_UPLOAD_RETRY_MS = 15_000;
const uploadedByConversation = new Map<string, Set<string>>();
const freshUploadSessions = new Map<string, string>();
const uploadFlights = new Map<string, Promise<unknown>>();

export function markFreshAttachmentUploadSession(sessionId: string, conversationId: string): void {
  freshUploadSessions.set(sessionId, conversationId);
}

export function markProviderAttachmentSessionPrepared(sessionId: string, conversationId: string): void {
  if (freshUploadSessions.get(sessionId) === conversationId) freshUploadSessions.delete(sessionId);
}

export function hasFreshProviderAttachmentSession(sessionId: string, conversationId: string): boolean {
  return freshUploadSessions.get(sessionId) === conversationId;
}

export function wasProviderAttachmentPreuploaded(conversationId: string, attachmentId: string): boolean {
  return uploadedByConversation.get(conversationId)?.has(attachmentId) === true;
}

export function retirePreuploadedProviderAttachments(conversationId: string, attachments: InputAttachment[]): void {
  const uploaded = uploadedByConversation.get(conversationId);
  if (!uploaded) return;
  for (const attachment of attachments) uploaded.delete(attachment.id);
  if (!uploaded.size) uploadedByConversation.delete(conversationId);
}

export async function preuploadDeepseekAttachments(
  sessionId: string,
  conversationId: string,
  attachments: InputAttachment[]
): Promise<void> {
  await runAttachmentOperation(conversationId, () => uploadDeepseekAttachmentsNow(sessionId, conversationId, attachments));
}

export async function removeDeepseekAttachments(
  conversationId: string,
  attachments: InputAttachment[]
): Promise<void> {
  if (!attachments.length) throw new Error('Select a supported file before removing it.');
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE || attachments.some(file => !isDeepseekDirectUpload(file.name, file.mimeType))) {
    throw new Error('Only supported DeepSeek file attachments can be removed.');
  }
  await runAttachmentOperation(conversationId, async () => {
    await waitForProviderPageIdle();
    const targets: ProviderPageAttachment[] = attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));
    const reply = await requestProviderPageComplete('deepseek', conversationId, '', undefined, {
      removeOnly: true,
      attachmentTargets: targets
    });
    if (reply.attachmentRemoved !== true) throw new Error('DeepSeek did not confirm that the selected files were removed.');
    retirePreuploadedProviderAttachments(conversationId, attachments);
  });
}

async function runAttachmentOperation<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
  const previous = uploadFlights.get(conversationId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  uploadFlights.set(conversationId, next);
  try { return await next; }
  finally { if (uploadFlights.get(conversationId) === next) uploadFlights.delete(conversationId); }
}

async function uploadDeepseekAttachmentsNow(
  sessionId: string,
  conversationId: string,
  attachments: InputAttachment[]
): Promise<void> {
  if (!attachments.length) throw new Error('Select a supported file before uploading.');
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE || attachments.some(file => !isDeepseekDirectUpload(file.name, file.mimeType))) {
    throw new Error('DeepSeek Web supports PDF, images, DOC/DOCX, XLS/XLSX, and PPT/PPTX uploads.');
  }
  const uploaded = uploadedByConversation.get(conversationId);
  const pendingAttachments = attachments.filter(file => !uploaded?.has(file.id));
  if (!pendingAttachments.length) return;

  let freshPage = freshUploadSessions.get(sessionId) === conversationId;
  for (const file of pendingAttachments) {
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) throw new Error('Each attachment must be 100 MB or smaller.');
    const source: ProviderPageAttachmentSource = {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      bytes: await readProviderUploadAttachment(file)
    };
    let attempt = 0;
    while (attempt < MAX_UPLOAD_ATTEMPTS) {
      try {
        // Upload one file at a time to keep 50-file batches from duplicating
        // gigabytes in the main process and extension message channel.
        await waitForProviderPageIdle();
        const reply = await requestProviderPageComplete('deepseek', conversationId, '', undefined, {
          fresh: freshPage && attempt === 0,
          uploadOnly: true,
          attachments: [source]
        });
        if (reply.attachmentUploaded !== true) throw new Error('DeepSeek did not confirm that the file finished uploading.');
        let completed = uploadedByConversation.get(conversationId);
        if (!completed) uploadedByConversation.set(conversationId, completed = new Set());
        completed.add(file.id);
        freshPage = false;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        const terminal = /provider session identity is invalid|supports PDF|requires files|cannot include chat text|only in DeepSeek Web|file size|invalid attachment|100 MB/i.test(message);
        if (terminal || attempt + 1 >= MAX_UPLOAD_ATTEMPTS) throw error;
        const delay = Math.min(INITIAL_UPLOAD_RETRY_MS * 2 ** Math.min(attempt, 4), MAX_UPLOAD_RETRY_MS);
        attempt += 1;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}
