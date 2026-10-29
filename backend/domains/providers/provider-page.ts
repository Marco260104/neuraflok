// Owns one provider page offer and rejects replies from any other provider conversation.
import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from '../browser/browser-wake.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { isWebProviderId, isWebProviderConversationId, type WebProviderId } from '../../../contracts/web-providers.js';
import { isDeepseekDirectUpload, MAX_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '../../../contracts/attachments.js';

const MAX_PAGE_TEXT = 96_000;
const PAGE_ATTACHMENT_CHUNK_BYTES = 256 * 1024;
const PAGE_WAIT_MS = 600_000;
const PAGE_WAIT_ERROR = 'The provider did not finish this reply in time. Check its browser tab and try again.';

export interface ProviderPageOffer {
  id: string;
  provider: WebProviderId;
  conversationId: string;
  text: string;
  stop: boolean;
  fresh: boolean;
  /** Attach the file to the provider composer and wait for its upload receipt without sending chat text. */
  uploadOnly?: boolean;
  /** Remove the listed staged files from the provider composer without sending chat text. */
  removeOnly?: boolean;
  /** Reuse a just-preuploaded empty DeepSeek page for the first authored request. */
  preparedAttachmentPage?: boolean;
  attachments?: ProviderPageAttachment[];
}

export interface ProviderPageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ProviderPageAttachmentSource extends ProviderPageAttachment {
  bytes: Uint8Array;
}

export interface ProviderPageReply {
  text: string;
  attachmentUploaded?: boolean;
  attachmentRemoved?: boolean;
}

interface Pending extends ProviderPageOffer {
  attachmentBytes: Map<string, Uint8Array>;
  at: number;
  resolve: (value: ProviderPageReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Complete = (
  provider: WebProviderId,
  conversationId: string,
  text: string,
  signal?: AbortSignal,
  options?: { fresh?: boolean; attachments?: ProviderPageAttachmentSource[]; attachmentTargets?: ProviderPageAttachment[]; uploadOnly?: boolean; removeOnly?: boolean; preparedAttachmentPage?: boolean }
) => Promise<ProviderPageReply>;

let pending: Pending | null = null;
let testComplete: Complete | undefined;

function expirePending(error: Error): void {
  if (!pending) return;
  const current = pending;
  pending = null;
  clearTimeout(current.timer);
  current.reject(error);
}

function armPageWait(id: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (pending?.id !== id) return;
    expirePending(new Error(PAGE_WAIT_ERROR));
  }, PAGE_WAIT_MS);
}

export function configureProviderPageForTests(options: { complete?: Complete }): void {
  testComplete = options.complete;
}

export function resetProviderPageForTests(): void {
  testComplete = undefined;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('test reset'));
  }
  pending = null;
}

export function pendingProviderPage(): ProviderPageOffer | null {
  if (!pending) return null;
  const attachments = pending.attachments ?? [];
  return {
    id: pending.id,
    provider: pending.provider,
    conversationId: pending.conversationId,
    text: pending.stop ? '' : pending.text,
    stop: pending.stop,
    fresh: pending.fresh,
    ...(pending.uploadOnly ? { uploadOnly: true } : {}),
    ...(pending.removeOnly ? { removeOnly: true } : {}),
    ...(pending.preparedAttachmentPage ? { preparedAttachmentPage: true } : {}),
    ...(attachments.length ? { attachments } : {})
  };
}

/** File pre-uploads wait behind any already accepted provider turn instead of competing for its page. */
export async function waitForProviderPageIdle(signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + PAGE_WAIT_MS;
  while (pending) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(PAGE_WAIT_ERROR);
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

/** Return a small, authorized slice of the one attachment currently offered to this provider page. */
export function readProviderPageAttachmentChunk(body: Record<string, unknown>): string | null {
  if (!pending || body.id !== pending.id || body.provider !== pending.provider ||
      body.conversationId !== pending.conversationId || typeof body.attachmentId !== 'string' ||
      !Number.isSafeInteger(body.offset) || (body.offset as number) < 0 ||
      (body.offset as number) % PAGE_ATTACHMENT_CHUNK_BYTES !== 0) return null;
  const bytes = pending.attachmentBytes.get(body.attachmentId);
  const offset = body.offset as number;
  if (!bytes || offset > bytes.byteLength) return null;
  return Buffer.from(bytes.subarray(offset, Math.min(offset + PAGE_ATTACHMENT_CHUNK_BYTES, bytes.byteLength))).toString('base64');
}

export interface ProviderPageProgress {
  id: string;
  provider: WebProviderId;
  conversationId: string;
  text: string;
  generating: boolean;
  attachmentsUploaded: boolean;
}

type ProgressListener = (progress: ProviderPageProgress) => void;
const progressListeners = new Set<ProgressListener>();

export function onProviderPageProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => { progressListeners.delete(listener); };
}

export function reportProviderPageProgress(body: Record<string, unknown>): boolean {
  if (!pending || typeof body.id !== 'string' || body.id !== pending.id) return false;
  if (body.provider !== pending.provider || body.conversationId !== pending.conversationId) return false;
  const text = typeof body.text === 'string' ? body.text : '';
  const generating = body.generating !== false;
  if (generating) {
    clearTimeout(pending.timer);
    pending.at = Date.now();
    pending.timer = armPageWait(pending.id);
  }
  const progress: ProviderPageProgress = {
    id: pending.id,
    provider: pending.provider,
    conversationId: pending.conversationId,
    text,
    generating,
    attachmentsUploaded: body.attachmentsUploaded === true
  };
  for (const listener of progressListeners) {
    try { listener(progress); } catch {}
  }
  return true;
}

export function settleProviderPage(body: Record<string, unknown>): boolean {
  if (!pending || typeof body.id !== 'string' || body.id !== pending.id) return false;
  if (body.provider !== pending.provider || body.conversationId !== pending.conversationId) return false;
  const current = pending;
  pending = null;
  clearTimeout(current.timer);
  if (body.stopped === true) {
    current.reject(new Error('Stop requested'));
    return true;
  }
  if (current.uploadOnly && body.attachmentUploaded === true) {
    current.resolve({ text: '', attachmentUploaded: true });
    return true;
  }
  if (current.removeOnly && body.attachmentRemoved === true) {
    current.resolve({ text: '', attachmentRemoved: true });
    return true;
  }
  if (typeof body.text === 'string' && body.text.trim()) {
    current.resolve({ text: body.text });
    return true;
  }
  if (typeof body.error === 'string' && body.error.trim()) {
    const failure = new Error(body.error.slice(0, 500));
    if (body.providerIdle === true) Object.assign(failure, { providerIdle: true });
    current.reject(failure);
    return true;
  }
  current.reject(new Error('The provider page returned no reply.'));
  return true;
}

export function requestProviderPageStop(conversationId: string): boolean {
  if (!pending || pending.conversationId !== conversationId) return false;
  pending.stop = true;
  wakeBrowserWork();
  return true;
}

export async function requestProviderPageComplete(
  provider: WebProviderId,
  conversationId: string,
  text: string,
  signal?: AbortSignal,
  options?: { fresh?: boolean; attachments?: ProviderPageAttachmentSource[]; attachmentTargets?: ProviderPageAttachment[]; uploadOnly?: boolean; removeOnly?: boolean; preparedAttachmentPage?: boolean }
): Promise<ProviderPageReply> {
  if (!isWebProviderId(provider) || !isWebProviderConversationId(conversationId) ||
      !conversationId.toLowerCase().startsWith(`${providerConversationPrefix(provider)}-`)) {
    throw new Error('The provider session identity is invalid. Start a new session and try again.');
  }
  if (testComplete) return testComplete(provider, conversationId, text, signal, options);
  if (pending && (pending.stop === true || options?.fresh === true || Date.now() - pending.at > PAGE_WAIT_MS)) {
    expirePending(new Error(PAGE_WAIT_ERROR));
  }
  if (pending) throw new Error('A web provider turn is already in flight.');
  const attachments = options?.attachments ?? options?.attachmentTargets ?? [];
  if (text.length > MAX_PAGE_TEXT) throw new Error('This message is too long for the provider web chat.');
  if (options?.uploadOnly && options?.removeOnly) {
    throw new Error('A provider attachment cannot be uploaded and removed in the same request.');
  }
  if ((options?.uploadOnly || options?.removeOnly) && (!attachments.length || text.trim())) {
    throw new Error('A provider attachment request requires files and cannot include chat text.');
  }
  if (!options?.uploadOnly && !options?.removeOnly && !text.trim()) throw new Error('A provider message cannot be empty.');
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE || attachments.some(attachment =>
    !/^[a-f0-9-]{36}$/i.test(attachment.id) || !attachment.name || attachment.name.length > 255 ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) ||
    attachment.size > MAX_ATTACHMENT_SIZE_BYTES ||
    (options?.removeOnly !== true && !isDeepseekDirectUpload(attachment.name, attachment.mimeType)) ||
    (options?.removeOnly !== true && (!(attachment as ProviderPageAttachmentSource).bytes ||
      (attachment as ProviderPageAttachmentSource).bytes.byteLength !== attachment.size)))) {
    throw new Error('DeepSeek Web accepts up to 50 supported files, each up to 100 MB.');
  }
  if (attachments.length && provider !== 'deepseek') throw new Error('File uploads are currently supported in DeepSeek Web sessions.');

  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = armPageWait(id);
    const finish = (fn: () => void) => {
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      if (pending?.id !== id) return;
      pending.stop = true;
      wakeBrowserWork();
      setTimeout(() => {
        if (pending?.id === id && pending.stop) {
          expirePending(new Error('Stop requested'));
        }
      }, 1_000).unref?.();
      finish(() => reject(new Error('Stop requested')));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('Stop requested'));
      return;
    }
    const attachmentBytes = new Map((options?.attachments ?? []).map(attachment => [attachment.id, new Uint8Array(attachment.bytes)]));
    pending = {
      id,
      provider,
      conversationId,
      text,
      stop: false,
      fresh: options?.fresh === true,
      uploadOnly: options?.uploadOnly === true,
      preparedAttachmentPage: options?.preparedAttachmentPage === true,
      removeOnly: options?.removeOnly === true,
      attachments: attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
      attachmentBytes,
      at: Date.now(),
      resolve: (value) => finish(() => resolve(value)),
      reject: (error) => finish(() => reject(error)),
      timer
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    logInfo(`provider: waiting for ${provider} page ${id}${options?.fresh === true ? ' (new session)' : ''}`);
    wakeBrowserWork();
  });
}

function providerConversationPrefix(provider: WebProviderId): string {
  switch (provider) {
    case 'deepseek': return 'ds';
    case 'kimi': return 'km';
    case 'qwen': return 'qw';
    case 'glm': return 'gm';
  }
}
