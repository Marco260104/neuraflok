/** Local provider sends go through the durable outbox and the signed-in app browser. */
import { browserWakeConnected, startBridge, webProvidersStatus } from '../../browser/bridge.js';
import { resetBrowserStartupForTests } from '../../browser/browser-startup.js';
import { wakeBrowserWork } from '../../browser/browser-wake.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { WEB_PROVIDERS, isWebProviderId, providerForConversationId } from '../../../../contracts/web-providers.js';
import type { WebProviderId } from '../../../../contracts/web-providers.js';
import { isApiConversationId, usesApiProvider } from '../../../../contracts/chat-protocol.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, failLocalExecutorInput, nextAfterTurnLocalInput, type InputArgs, type InputEntry } from './input.js';
import { isProviderTextAttachment } from './attachments/index.js';
import { getSession } from '../history/store.js';
import { setLocalProviderTurnQueued } from './local-executor-activity.js';
// Only transient startup work lives here; the outbox owns accepted messages.
const starting = new Map<string, AbortController>();
/** Local providers cannot inject a new user message into a completion already in flight. */
const localRuns = new Map<string, string>();
let providerTurnQueue = Promise.resolve();
let stopped = false;
const localTurnSettledListeners = new Set<(result: { entry: Readonly<InputEntry>; conversationId: string | null; turnId: string | null; aborted: boolean; error: Error | null }) => void | Promise<void>>();

const PROVIDER_AUTH_REFRESH_MS = 8_000;
const PROVIDER_AUTH_POLL_MS = 100;

function waitForProviderPresence(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function assertWebProviderReady(provider: WebProviderId): Promise<void> {
  const label = WEB_PROVIDERS[provider].label;
  if (!browserWakeConnected()) throw new Error(`Connect the NEURAFLOK browser and sign in to ${label} before sending.`);

  const before = webProvidersStatus()[provider]?.lastSeenAt ?? 0;
  // Refresh authentication from the provider page immediately before the
  // message is accepted. A connected browser alone is not proof of sign-in.
  wakeBrowserWork();
  const deadline = Date.now() + PROVIDER_AUTH_REFRESH_MS;
  while (Date.now() < deadline) {
    const presence = webProvidersStatus()[provider];
    if ((presence?.lastSeenAt ?? 0) > before) {
      if (presence?.signedIn === true) return;
      throw new Error(`Connect ${label} in NEURAFLOK's browser before sending.`);
    }
    await waitForProviderPresence(PROVIDER_AUTH_POLL_MS);
  }
  throw new Error(`Could not verify your ${label} session. Reopen the provider in NEURAFLOK and sign in before sending.`);
}

export function onLocalExecutorTurnSettled(
  listener: (result: { entry: Readonly<InputEntry>; conversationId: string | null; turnId: string | null; aborted: boolean; error: Error | null }) => void | Promise<void>
): () => void {
  localTurnSettledListeners.add(listener);
  return () => localTurnSettledListeners.delete(listener);
}

export function isLocalExecutorRunning(sessionId: string): boolean {
  return localRuns.has(sessionId);
}
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  start?.abort(new Error('Input cancelled'));
  return await cancelInput(id) || !!start;
}

async function runLocalExecutorInput(entry: InputEntry, apiExecutor: boolean, provider: WebProviderId, signal: AbortSignal): Promise<void> {
  if (entry.localExecutor) {
    apiExecutor = entry.localExecutor === 'api';
    if (entry.localExecutor !== 'api') provider = entry.localExecutor;
  }
  const sessionId = entry.sessionId ?? entry.id;
  if (localRuns.has(sessionId)) throw new Error('A response is already running in this chat. This message will wait for it to finish.');
  localRuns.set(sessionId, entry.id);
  let queuedConversationId: string | null = null;
  let queueAbortListener: (() => void) | null = null;
  const clearProviderQueueWait = () => {
    if (queuedConversationId) setLocalProviderTurnQueued(queuedConversationId, false);
    queuedConversationId = null;
    if (queueAbortListener) signal.removeEventListener('abort', queueAbortListener);
    queueAbortListener = null;
  };
  let completedTurnId: string | null = null;
  let failure: Error | null = null;
  try {
    if (apiExecutor) {
      completedTurnId = await (await import('../../providers/api-chat.js')).runApiProviderInput(entry, signal);
    } else {
      queuedConversationId = entry.conversationId ?? (await getSession(sessionId))?.conversationId ?? null;
      if (queuedConversationId && !signal.aborted) {
        setLocalProviderTurnQueued(queuedConversationId, true);
        queueAbortListener = clearProviderQueueWait;
        signal.addEventListener('abort', queueAbortListener, { once: true });
      }
      const turn = providerTurnQueue.then(async () => {
        clearProviderQueueWait();
        signal.throwIfAborted();
        if (!await startBridge()) throw new Error('The browser bridge could not start.');
        const browser = await (await import('../../browser/embedded/selection.js')).loadIntegratedBrowser();
        await browser.openProvider(provider, { reveal: false });
        signal.throwIfAborted();
        return (await import('../../providers/browser-chat.js')).runWebProviderInput(entry, provider, signal);
      });
      providerTurnQueue = turn.then(() => undefined, () => undefined);
      completedTurnId = await turn;
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    clearProviderQueueWait();
    if (localRuns.get(sessionId) === entry.id) localRuns.delete(sessionId);
    const session = await getSession(sessionId).catch(() => null);
    const conversationId = session?.conversationId ?? entry.conversationId;
    for (const listener of localTurnSettledListeners) {
      try {
        await listener({ entry: { ...entry }, conversationId, turnId: completedTurnId, aborted: signal.aborted, error: failure });
      } catch (error) {
        console.warn(`Local executor turn observer failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!stopped) {
    const session = await getSession(sessionId).catch(() => null);
    const targetConversation = session?.conversationId ?? entry.conversationId;
    if (targetConversation) {
      void dispatchLocalAfterTurn(sessionId, targetConversation, completedTurnId ?? '').catch(() => undefined);
    }
  }
}

async function dispatchLocalAfterTurn(sessionId: string, conversationId: string, turnId: string): Promise<void> {
  if (stopped || localRuns.has(sessionId)) return;
  const entry = await nextAfterTurnLocalInput(sessionId, conversationId, turnId);
  if (!entry || starting.has(entry.id)) return;
  const session = await getSession(sessionId);
  if (!session || (session.conversationId && session.conversationId !== conversationId)) return;
  const provider = providerForConversationId(conversationId);
  const apiExecutor = isApiConversationId(conversationId);
  if (!apiExecutor && !provider) {
    await failLocalExecutorInput(entry.id, 'This queued message belongs to an unsupported provider session.');
    return;
  }
  try {
    if (apiExecutor) {
      await (await import('../../providers/api-chat.js')).assertApiChatReady();
      if (entry.attachments?.some(file => !file.mimeType.startsWith('image/') && !isProviderTextAttachment(file)))
        throw new Error('The API executor accepts text, source files, and images. Add other file types through a project folder.');
    } else {
      const selected = provider!;
      await assertWebProviderReady(selected);
      if ((entry.images?.length ?? 0) > 0 || entry.attachments?.some(file =>
        !file.mimeType.startsWith('image/') && !isProviderTextAttachment(file)))
        throw new Error(`${WEB_PROVIDERS[selected].label} web sessions accept text and source files. Use the API executor for image attachments.`);
    }
  } catch (error) {
    await failLocalExecutorInput(entry.id, (error as Error).message);
    return;
  }
  const controller = new AbortController();
  starting.set(entry.id, controller);
  void runLocalExecutorInput(entry, apiExecutor, provider ?? 'deepseek', controller.signal).catch(async error => {
    if (controller.signal.aborted) return;
    const latest = (await listInputs()).find(row => row.id === entry.id);
    if (latest?.state === 'queued') await failLocalExecutorInput(entry.id, (error as Error).message);
  }).finally(() => {
    if (starting.get(entry.id) === controller) starting.delete(entry.id);
  });
}

export async function sendDesktopInput(input: InputArgs): Promise<InputEntry> {
  if (stopped) throw new Error('The app is shutting down');
  if (starting.has(input.id)) return enqueueInput(input);
  const config = getConfig();
  const session = input.sessionId ? await getSession(input.sessionId) : null;
  const boundConversation = session?.conversationId ?? null;
  const boundProvider = boundConversation ? providerForConversationId(boundConversation) : null;
  const boundApi = boundConversation ? isApiConversationId(boundConversation) : false;
  if (boundConversation && !boundProvider && !boundApi) {
    throw new Error('This chat is linked to an unsupported provider session. Start a new chat to continue in NEURAFLOK.');
  }
  const chosenProvider = (input.webProvider && isWebProviderId(input.webProvider))
    ? input.webProvider
    : (isWebProviderId(config.ui.webProvider) ? config.ui.webProvider : 'deepseek');
  // If the user deliberately selected a provider that differs from the existing chat binding, decouple to start a clean session with the selected provider rather than failing.
  const providerMismatch = Boolean(boundProvider && input.webProvider && boundProvider !== input.webProvider);
  const effectiveSessionId = providerMismatch ? null : input.sessionId;
  const effectiveBoundProvider = providerMismatch ? null : boundProvider;
  const effectiveBoundApi = providerMismatch ? false : boundApi;

  // A session's provider is immutable. Settings choose the route for new chats only.
  const apiExecutor = effectiveBoundApi || (!effectiveBoundProvider && usesApiProvider(config.ui.chatExecutor));
  const provider = effectiveBoundProvider ?? chosenProvider;
  const localExecutor = true;
  if (localExecutor && (input.delivery === 'tool' || input.attachmentDelivery === 'tool')) {
    throw new Error('A local provider cannot receive a live message inside its current response. Choose “After this turn” instead.');
  }
  if (localExecutor && input.mode === 'finish') {
    throw new Error('Finish-boundary automation is not available for local provider chats. Send a regular message or queue it after the current turn.');
  }
  // Keep browser-only tool handoffs with the outbox. Local providers use their own exact completion boundary below and must never claim a browser document as sender.
  if (!localExecutor && (input.delivery === 'tool' || input.attachmentDelivery === 'tool' || input.mode === 'finish')) return enqueueInput(input);
  const effectiveInput: InputArgs = {
    ...input,
    sessionId: effectiveSessionId,
    ...(localExecutor && effectiveSessionId && input.mode === 'auto' &&
      (session?.activeTurnId !== undefined && !!session.activeTurnId || localRuns.has(effectiveSessionId))
      ? { mode: 'after-turn', afterTurn: true }
      : localExecutor && input.mode === 'after-turn' ? { afterTurn: true } : {})
  };
  if (!apiExecutor) {
    await assertWebProviderReady(provider);
    if ((input.images?.length ?? 0) > 0 || input.attachments?.some(file =>
      !file.mimeType.startsWith('image/') && !isProviderTextAttachment(file))) {
      throw new Error(`${WEB_PROVIDERS[provider].label} web sessions accept text and source files. Use the API executor for image attachments.`);
    }
  } else {
    await (await import('../../providers/api-chat.js')).assertApiChatReady(input.sessionId ?? undefined);
    if (input.attachments?.some(file => !file.mimeType.startsWith('image/') && !isProviderTextAttachment(file))) {
      throw new Error('The API executor accepts text, source files, and images. Add other file types through a project folder.');
    }
  }
  const providerController = new AbortController(); starting.set(input.id, providerController);
  try {
    const entry = await enqueueInput(effectiveInput, undefined, apiExecutor ? 'api' : provider);
    if (providerController.signal.aborted) { await cancelInput(input.id); providerController.signal.throwIfAborted(); }
    if (entry.state !== 'queued' || entry.transportIntent === 'tool' || entry.attachmentDelivery === 'tool' ||
        entry.mode === 'after-turn' || entry.mode === 'finish') {
      starting.delete(input.id); return entry;
    }
    void (async () => {
      try {
        await runLocalExecutorInput(entry, apiExecutor, provider, providerController.signal);
      } catch (error) {
        if (providerController.signal.aborted) return;
        const latest = (await listInputs()).find(row => row.id === entry.id);
        if (latest?.state === 'queued') await failLocalExecutorInput(entry.id, (error as Error).message);
      } finally {
        if (starting.get(entry.id) === providerController) starting.delete(entry.id);
      }
    })().catch(() => undefined);
    return entry;
  } catch (error) {
    if (starting.get(input.id) === providerController) starting.delete(input.id);
    throw error;
  }
}
export function stopInputStartup(): void {
  stopped = true;
  for (const controller of starting.values()) controller.abort(new Error('The app is shutting down'));
  starting.clear();
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  if (stopped || starting.has(id)) return null;
  const entry = (await listInputs()).find(row => row.id === id);
  if (!entry || entry.state !== 'queued' || entry.purpose === 'decision' || !entry.error ||
      entry.mode !== 'auto' || entry.transportIntent === 'tool' || entry.attachmentDelivery === 'tool' || stopped || starting.has(id)) return null;
  const sessionId = entry.sessionId ?? entry.id;
  const session = await getSession(sessionId);
  const boundConversation = session?.conversationId ?? entry.conversationId;
  const boundProvider = boundConversation ? providerForConversationId(boundConversation) : null;
  const boundApi = boundConversation ? isApiConversationId(boundConversation) : false;
  if (boundConversation && !boundProvider && !boundApi) return null;
  const config = getConfig();
  const apiExecutor = entry.localExecutor ? entry.localExecutor === 'api' : boundApi || (!boundConversation && usesApiProvider(config.ui.chatExecutor));
  const provider = boundProvider ?? (entry.localExecutor && entry.localExecutor !== 'api' ? entry.localExecutor
    : isWebProviderId(config.ui.webProvider) ? config.ui.webProvider : 'deepseek');
  try {
    if (apiExecutor) {
      await (await import('../../providers/api-chat.js')).assertApiChatReady(sessionId);
      if (entry.attachments?.some(file => !file.mimeType.startsWith('image/') && !isProviderTextAttachment(file)))
        throw new Error('The API executor accepts text, source files, and images. Add other file types through a project folder.');
    } else {
      await assertWebProviderReady(provider);
      if ((entry.images?.length ?? 0) > 0 || entry.attachments?.some(file =>
        !file.mimeType.startsWith('image/') && !isProviderTextAttachment(file)))
        throw new Error(`${WEB_PROVIDERS[provider].label} web sessions accept text and source files. Use the API executor for image attachments.`);
    }
    const repaired = await noteInputStartupError(id, null);
    if (!repaired || repaired.state !== 'queued') return repaired ?? null;
    const controller = new AbortController();
    starting.set(id, controller);
    void runLocalExecutorInput(repaired, apiExecutor, provider, controller.signal).catch(async error => {
      if (controller.signal.aborted) return;
      const latest = (await listInputs()).find(row => row.id === id);
      if (latest?.state === 'queued') await failLocalExecutorInput(id, (error as Error).message);
    }).finally(() => {
      if (starting.get(id) === controller) starting.delete(id);
    });
    return repaired;
  } catch (error) {
    return await noteInputStartupError(id, `Message queued. ${(error as Error).message}`);
  }
}
export function resetInputStartupForTests(): void { stopInputStartup(); stopped = false; resetBrowserStartupForTests(); }
