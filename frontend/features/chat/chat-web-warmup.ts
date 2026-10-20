import { usesApiProvider } from '../../../contracts/chat-protocol.js';
import { isWebProviderId, providerForConversationId, type WebProviderId } from '../../../contracts/web-providers.js';
import type { AppState } from '../../../contracts/types.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { run } from '../../shared/dom.js';
import {
  adoptOpeningSession,
  clearComposerWarmup,
  composerWarmupKey,
  composerWarmupState,
  markComposerWarmupFailed,
  markComposerWarmupOpening,
  setComposerWarmupHandlers
} from './chat-composer-ready.js';

export const WEB_CHAT_WARMUP_TEXT = 'NEURAFLOK_WARMUP';
const POLL_INTERVAL_MS = 750;
export const WEB_CHAT_PREPARATION_TIMEOUT_MS = 75_000;

async function beforeDeadline<T>(deadline: number, message: string, work: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remaining);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isWarmupInput(entry: { warmup?: boolean }): boolean {
  return entry.warmup === true;
}

export function webChatWarmupNeeded(input: {
  apiExecutor: boolean;
  signedIn: boolean;
  webProvider: string;
  newChatSelected: boolean;
  selectedId: string | null;
  hasConversation: boolean;
}): boolean {
  return !input.apiExecutor && input.signedIn &&
    (input.newChatSelected || (!!input.selectedId && input.hasConversation));
}

export interface WebChatWarmupRuntime {
  api: Pick<typeof window.api, 'sendInput' | 'listInputs' | 'getSession' | 'cancelInput'>;
  state: () => AppState | null;
  newChatSelected: boolean;
  selectedId: string | null;
  selectedProjectId: string | null;
  selectionGeneration: number;
  sessions: SessionSummary[];
  turnWorking: () => boolean;
  pendingNewInput: { id: string; generation: number } | null;
  startingInputs: Map<string, InputEntry>;
  pendingComposerInputs: InputEntry[];
  adoptAcceptedOpening: (entry: InputEntry) => Promise<boolean>;
  selectSession: (id: string) => void;
  paintDeliveryControls: () => void;
  refreshInputQueue: () => Promise<void>;
  setPendingNewInput: (value: { id: string; generation: number } | null) => void;
  paintPreparationStatus: () => void;
}

export function createWebChatWarmup(runtime: WebChatWarmupRuntime): { ensure: () => void; retry: () => void } {
  let inflightKey: string | null = null;
  const verifiedSessions = new Map<string, { provider: WebProviderId; conversationId: string; generation: number }>();

  function currentSelectionKey(): string {
    return composerWarmupKey(runtime.selectedId, runtime.selectionGeneration);
  }

  function currentProvider(app: AppState): WebProviderId {
    return isWebProviderId(app.config.ui.webProvider) ? app.config.ui.webProvider : 'deepseek';
  }

  function cachedReady(sessionId: string, provider: WebProviderId, conversationId: string, generation: number): boolean {
    const cached = verifiedSessions.get(sessionId);
    return !!cached && cached.provider === provider && cached.conversationId === conversationId && cached.generation === generation;
  }

  async function findExistingWarmup(sessionId: string | null, deadline: number): Promise<InputEntry | undefined> {
    if (!sessionId) return undefined;
    const rows = await beforeDeadline(deadline, 'The model took too long to prepare this chat. Retry to try again.',
      () => run(runtime.api.listInputs()));
    if (!rows) throw new Error('Could not check existing chat preparation requests.');
    const related = rows.filter(entry => isWarmupInput(entry) &&
      (entry.sessionId === sessionId || entry.deliveredSessionId === sessionId));
    const pending = related.filter(entry => ['queued', 'browser'].includes(entry.state))
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (pending && Date.now() - pending.createdAt <= WEB_CHAT_PREPARATION_TIMEOUT_MS) return pending;
    if (pending) {
      const cancelled = await beforeDeadline(deadline, 'The model took too long to prepare this chat. Retry to try again.',
        () => run(runtime.api.cancelInput(pending.id)));
      if (!cancelled) throw new Error('The previous chat preparation is stuck in the delivery queue. Retry in a moment.');
    }
    const accepted = related.filter(entry => entry.state === 'sent')
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!accepted || Date.now() - accepted.createdAt > WEB_CHAT_PREPARATION_TIMEOUT_MS) return undefined;
    const detail = await beforeDeadline(deadline, 'The model took too long to prepare this chat. Retry to try again.',
      () => run(runtime.api.getSession(sessionId, { limit: 160 })));
    const acknowledged = detail?.events.some(event =>
      event.kind === 'assistant_message' && event.inputId === accepted.id &&
      (event.message.text.trim() === 'NEURAFLOK_READY' || event.message.text.trim() === 'NEURAL_JAM_READY'));
    const failed = detail?.events.some(event => event.kind === 'chat_error' && event.inputId === accepted.id);
    if (failed) return undefined;
    return acknowledged ? undefined : accepted;
  }

  async function waitForAcknowledgement(entry: InputEntry, sessionId: string, deadline: number): Promise<{ conversationId: string }> {
    while (Date.now() < deadline) {
      const [rows, detail] = await beforeDeadline(deadline,
        'The model took too long to confirm this chat. Retry to try again.',
        () => Promise.all([
          run(runtime.api.listInputs()),
          run(runtime.api.getSession(sessionId, { limit: 160 }))
        ]));
      if (!rows) throw new Error('Could not check whether the model finished preparing this chat.');
      const acknowledged = detail?.events.some(event =>
        event.kind === 'assistant_message' && event.inputId === entry.id &&
        (event.message.text.trim() === 'NEURAFLOK_READY' || event.message.text.trim() === 'NEURAL_JAM_READY'));
      if (acknowledged && detail?.summary?.conversationId) return { conversationId: detail.summary.conversationId };
      const current = rows.find(row => row.id === entry.id);
      if (!current) throw new Error('The preparation request disappeared before the model confirmed the chat.');
      const failure = detail?.events.find(event => event.kind === 'chat_error' && event.inputId === entry.id);
      if (failure?.kind === 'chat_error') throw new Error(failure.message.text || 'The model could not prepare this chat.');
      if (current.state === 'failed' || current.state === 'cancelled')
        throw new Error(current.error || 'The model did not confirm this chat context.');
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('The model took too long to confirm this chat context.');
  }

  async function bindWarmupSession(entry: InputEntry, generation: number, priorKey: string): Promise<string> {
    const boundId = entry.sessionId ?? entry.deliveredSessionId ?? entry.id;
    if (!entry.opening) return boundId;
    markComposerWarmupOpening(boundId, runtime.selectionGeneration);
    clearComposerWarmup(priorKey);
    const adopted = await runtime.adoptAcceptedOpening(entry);
    if (!adopted && boundId && runtime.selectionGeneration === generation && runtime.newChatSelected && runtime.selectedId === null) {
      adoptOpeningSession(boundId);
      runtime.selectSession(boundId);
    }
    return boundId;
  }

  async function start(key: string, provider: WebProviderId, sessionId: string | null, projectId: string | null,
    generation: number): Promise<void> {
    const deadline = Date.now() + WEB_CHAT_PREPARATION_TIMEOUT_MS;
    const id = crypto.randomUUID();
    const dueAt = Date.now();
    const mode = runtime.turnWorking() ? 'after-turn' as const : 'auto' as const;
    const seed: InputEntry = {
      id, sessionId, projectId, text: WEB_CHAT_WARMUP_TEXT, warmup: true, authoredSource: 'none',
      mode, dueAt, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: dueAt,
      conversationId: null
    };
    runtime.startingInputs.set(id, seed);
    if (sessionId === null) runtime.setPendingNewInput({ id, generation });
    runtime.paintDeliveryControls();
    runtime.paintPreparationStatus();

    let boundId: string | null = sessionId;
    let boundConversation: string | null = null;
    try {
      let accepted = await findExistingWarmup(sessionId, deadline);
      if (!accepted) {
        try {
          accepted = (await beforeDeadline(deadline, 'The model took too long to queue chat preparation. Retry to try again.',
            () => run(runtime.api.sendInput({
              id, sessionId, projectId, text: WEB_CHAT_WARMUP_TEXT, warmup: true, authoredSource: 'none',
              mode, dueAt, model: null, reasoningEffort: null, webProvider: provider
            })))) ?? undefined;
        } catch (error) {
          accepted = (await beforeDeadline(deadline, 'The model took too long to queue chat preparation. Retry to try again.',
            () => run(runtime.api.listInputs())))?.find(row => row.id === id);
          if (!accepted) throw error;
        }
        if (!accepted) accepted = (await beforeDeadline(deadline, 'The model took too long to queue chat preparation. Retry to try again.',
          () => run(runtime.api.listInputs())))?.find(row => row.id === id);
      }
      if (!accepted) throw new Error('NeuraFlok could not queue the chat preparation request.');

      runtime.pendingComposerInputs = [
        ...runtime.pendingComposerInputs.filter(row => row.id !== accepted!.id),
        accepted
      ];
      if (sessionId === null) runtime.setPendingNewInput({ id: accepted.id, generation });
      boundId = await bindWarmupSession(accepted, generation, key);
      if (boundId !== key) markComposerWarmupOpening(boundId, runtime.selectionGeneration);
      runtime.paintDeliveryControls();
      runtime.paintPreparationStatus();

      const ready = await waitForAcknowledgement(accepted, boundId, deadline);
      boundConversation = ready.conversationId;
      verifiedSessions.clear();
      verifiedSessions.set(boundId, {
        provider,
        conversationId: ready.conversationId,
        generation: runtime.selectedId === boundId ? runtime.selectionGeneration : generation
      });
      clearComposerWarmup(key);
      clearComposerWarmup(boundId);
      runtime.paintPreparationStatus();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const failedKey = boundId ?? key;
      if (failedKey !== key) clearComposerWarmup(key);
      markComposerWarmupFailed(failedKey, message,
        runtime.selectedId === boundId ? runtime.selectionGeneration : generation);
      if (runtime.pendingNewInput?.id === id && runtime.pendingNewInput.generation === generation)
        runtime.setPendingNewInput(null);
      runtime.paintPreparationStatus();
    } finally {
      runtime.startingInputs.delete(id);
      if (inflightKey === key) inflightKey = null;
      runtime.paintDeliveryControls();
      runtime.paintPreparationStatus();
      void runtime.refreshInputQueue();
      if (boundConversation) void runtime.refreshInputQueue();
      if (currentSelectionKey() !== key) ensure();
    }
  }

  function ensure(): void {
    const app = runtime.state();
    if (!app || runtime.selectionGeneration === 0) return;
    const provider = currentProvider(app);
    const session = runtime.selectedId ? runtime.sessions.find(row => row.id === runtime.selectedId) : undefined;
    const sessionProvider = session?.conversationId ? providerForConversationId(session.conversationId) : null;
    const matchingSession = !runtime.selectedId || sessionProvider === provider;
    const key = currentSelectionKey();
    const status = composerWarmupState(key);
    const conversationId = session?.conversationId ?? null;
    if (status?.phase === 'failed' && status.generation === runtime.selectionGeneration) return;
    if (status?.phase === 'failed') clearComposerWarmup(key);
    if (status?.phase === 'opening' && inflightKey !== null) return;
    if (inflightKey === key) return;
    if (runtime.selectedId && conversationId && cachedReady(runtime.selectedId, provider, conversationId, runtime.selectionGeneration)) {
      clearComposerWarmup(key);
      runtime.paintPreparationStatus();
      return;
    }
    if (runtime.selectedId && !matchingSession) return;

    const needed = webChatWarmupNeeded({
      apiExecutor: usesApiProvider(app.config.ui.chatExecutor),
      signedIn: app.bridge.webProviders?.[provider]?.signedIn === true,
      webProvider: provider,
      newChatSelected: runtime.newChatSelected,
      selectedId: runtime.selectedId,
      hasConversation: !!conversationId
    });
    if (!needed) return;

    if (status?.phase !== 'opening') {
      markComposerWarmupOpening(key, runtime.selectionGeneration);
      if (inflightKey !== null) {
        runtime.paintDeliveryControls();
        runtime.paintPreparationStatus();
        return;
      }
    } else if (inflightKey !== null) return;
    inflightKey = key;
    if (status?.phase !== 'opening') {
      runtime.paintDeliveryControls();
      runtime.paintPreparationStatus();
    }
    void start(key, provider, runtime.selectedId, session?.projectId ?? runtime.selectedProjectId, runtime.selectionGeneration);
  }

  function retry(): void {
    const key = currentSelectionKey();
    clearComposerWarmup(key);
    if (runtime.selectedId) verifiedSessions.delete(runtime.selectedId);
    ensure();
  }

  setComposerWarmupHandlers({ ensure, retry });
  return { ensure, retry };
}
