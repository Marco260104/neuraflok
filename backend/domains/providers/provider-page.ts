// Owns one provider page offer and rejects replies from any other provider conversation.
import { randomUUID } from 'node:crypto';
import { wakeBrowserWork } from '../browser/browser-wake.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { isWebProviderId, isWebProviderConversationId, type WebProviderId } from '../../../contracts/web-providers.js';

const MAX_PAGE_TEXT = 96_000;
const PAGE_WAIT_MS = 600_000;
const PAGE_WAIT_ERROR = 'The provider did not finish this reply in time. Check its browser tab and try again.';

export interface ProviderPageOffer {
  id: string;
  provider: WebProviderId;
  conversationId: string;
  text: string;
  stop: boolean;
  fresh: boolean;
}

export interface ProviderPageReply {
  text: string;
}

interface Pending extends ProviderPageOffer {
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
  options?: { fresh?: boolean }
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
  return {
    id: pending.id,
    provider: pending.provider,
    conversationId: pending.conversationId,
    text: pending.stop ? '' : pending.text,
    stop: pending.stop,
    fresh: pending.fresh
  };
}

export interface ProviderPageProgress {
  id: string;
  provider: WebProviderId;
  conversationId: string;
  text: string;
  generating: boolean;
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
    generating
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
  options?: { fresh?: boolean }
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
  if (text.length > MAX_PAGE_TEXT) throw new Error('This message is too long for the provider web chat.');

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
    pending = {
      id,
      provider,
      conversationId,
      text,
      stop: false,
      fresh: options?.fresh === true,
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
