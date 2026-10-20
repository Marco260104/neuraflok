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
const PREPARATION_TIMEOUT_MS = 11 * 60_000;
const READY_CACHE_MS = 2 * 60_000;

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
  pending: boolean;
  turnWorking: boolean;
}): boolean {
  return !input.apiExecutor && input.webProvider === 'deepseek' && input.signedIn &&
    !input.pending && !input.turnWorking &&
    (input.newChatSelected || (!!input.selectedId && input.hasConversation));
}

export interface WebChatWarmupRuntime {
  api: Pick<typeof window.api, 'sendInput' | 'listInputs' | 'getSession'>;
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
}

export function createWebChatWarmup(runtime: WebChatWarmupRuntime): { ensure: () => void; retry: () => void } {
  let inflightKey: string | null = null;
  const verifiedSessions = new Map<string, { provider: WebProviderId; conversationId: string; at: number }>();

  function currentSelectionKey(): string {
    return composerWarmupKey(runtime.selectedId, runtime.selectionGeneration);
  }

  function currentProvider(app: AppState): WebProviderId {
    return isWebProviderId(app.config.ui.webProvider) ? app.config.ui.webProvider : 'deepseek';
  }

  function hasPendingInput(sessionId: string | null): boolean {
    if (sessionId === null && runtime.pendingNewInput?.generation === runtime.selectionGeneration) return true;
    return [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs].some(entry => {
      if (isWarmupInput(entry) || !['queued', 'browser', 'tool'].includes(entry.state)) return false;
      const owner = entry.sessionId ?? entry.deliveredSessionId ?? null;
      return sessionId ? owner === sessionId : owner === null;
    });
  }

  function cachedReady(sessionId: string, provider: WebProviderId, conversationId: string): boolean {
    const cached = verifiedSessions.get(sessionId);
    return !!cached && cached.provider === provider && cached.conversationId === conversationId &&
      Date.now() - cached.at < READY_CACHE_MS;
  }

  async function findExistingWarmup(sessionId: string | null): Promise<InputEntry | undefined> {
    if (!sessionId) return undefined;
    const rows = await run(runtime.api.listInputs());
    if (!rows) throw new Error('Could not check existing chat preparation requests.');
    const related = rows.filter(entry => isWarmupInput(entry) &&
      (entry.sessionId === sessionId || entry.deliveredSessionId === sessionId));
    const pending = related.filter(entry => ['queued', 'browser'].includes(entry.state))
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (pending) return pending;
    const accepted = related.filter(entry => entry.state === 'sent')
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!accepted || Date.now() - accepted.createdAt > PREPARATION_TIMEOUT_MS) return undefined;
    const detail = await run(runtime.api.getSession(sessionId, { limit: 160 }));
    const acknowledged = detail?.events.some(event =>
      event.kind === 'assistant_message' && event.inputId === accepted.id &&
      (event.message.text.trim() === 'NEURAFLOK_READY' || event.message.text.trim() === 'NEURAL_JAM_READY'));
    return acknowledged ? undefined : accepted;
  }

  async function waitForAcknowledgement(entry: InputEntry, sessionId: string): Promise<{ conversationId: string }> {
    const deadline = Date.now() + PREPARATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const [rows, detail] = await Promise.all([
        run(runtime.api.listInputs()),
        run(runtime.api.getSession(sessionId, { limit: 160 }))
      ]);
      if (!rows) throw new Error('Could not check whether DeepSeek finished preparing this chat.');
      const acknowledged = detail?.events.some(event =>
        event.kind === 'assistant_message' && event.inputId === entry.id &&
        (event.message.text.trim() === 'NEURAFLOK_READY' || event.message.text.trim() === 'NEURAL_JAM_READY'));
      if (acknowledged && detail?.summary?.conversationId) return { conversationId: detail.summary.conversationId };
      const current = rows.find(row => row.id === entry.id);
      if (!current) throw new Error('The preparation request disappeared before DeepSeek confirmed the chat.');
      if (current.state === 'failed' || current.state === 'cancelled')
        throw new Error(current.error || 'DeepSeek did not confirm this chat context.');
      await new Promise(resolve => window.setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('DeepSeek took too long to confirm this chat context.');
  }

  async function bindWarmupSession(entry: InputEntry, generation: number, priorKey: string): Promise<string> {
    const boundId = entry.sessionId ?? entry.deliveredSessionId ?? entry.id;
    if (!entry.opening) return boundId;
    markComposerWarmupOpening(boundId);
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
    const id = crypto.randomUUID();
    const dueAt = Date.now();
    const seed: InputEntry = {
      id, sessionId, projectId, text: WEB_CHAT_WARMUP_TEXT, warmup: true, authoredSource: 'none',
      mode: 'auto', dueAt, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: dueAt,
      conversationId: null
    };
    runtime.startingInputs.set(id, seed);
    if (sessionId === null) runtime.setPendingNewInput({ id, generation });
    runtime.paintDeliveryControls();

    let boundId: string | null = sessionId;
    let boundConversation: string | null = null;
    try {
      let accepted = await findExistingWarmup(sessionId);
      if (!accepted) {
        try {
          accepted = (await run(runtime.api.sendInput({
            id, sessionId, projectId, text: WEB_CHAT_WARMUP_TEXT, warmup: true, authoredSource: 'none',
            mode: 'auto', dueAt, model: null, reasoningEffort: null, webProvider: provider
          }))) ?? undefined;
        } catch (error) {
          accepted = (await run(runtime.api.listInputs()))?.find(row => row.id === id);
          if (!accepted) throw error;
        }
        if (!accepted) accepted = (await run(runtime.api.listInputs()))?.find(row => row.id === id);
      }
      if (!accepted) throw new Error('NeuraFlok could not queue the chat preparation request.');

      runtime.pendingComposerInputs = [
        ...runtime.pendingComposerInputs.filter(row => row.id !== accepted!.id),
        accepted
      ];
      if (sessionId === null) runtime.setPendingNewInput({ id: accepted.id, generation });
      boundId = await bindWarmupSession(accepted, generation, key);
      if (boundId !== key) markComposerWarmupOpening(boundId);
      runtime.paintDeliveryControls();

      const ready = await waitForAcknowledgement(accepted, boundId);
      boundConversation = ready.conversationId;
      verifiedSessions.set(boundId, { provider, conversationId: ready.conversationId, at: Date.now() });
      clearComposerWarmup(key);
      clearComposerWarmup(boundId);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      markComposerWarmupFailed(key, message);
      if (boundId) markComposerWarmupFailed(boundId, message);
      if (runtime.pendingNewInput?.id === id && runtime.pendingNewInput.generation === generation)
        runtime.setPendingNewInput(null);
    } finally {
      runtime.startingInputs.delete(id);
      if (inflightKey === key) inflightKey = null;
      runtime.paintDeliveryControls();
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
    if (status?.phase === 'failed') return;
    if (status?.phase === 'opening' && inflightKey !== null) return;
    if (inflightKey === key) return;
    if (runtime.selectedId && provider === 'deepseek' && conversationId && cachedReady(runtime.selectedId, provider, conversationId)) {
      clearComposerWarmup(key);
      return;
    }
    if (runtime.selectedId && !matchingSession) return;

    const needed = webChatWarmupNeeded({
      apiExecutor: usesApiProvider(app.config.ui.chatExecutor),
      signedIn: app.bridge.webProviders?.[provider]?.signedIn === true,
      webProvider: provider,
      newChatSelected: runtime.newChatSelected,
      selectedId: runtime.selectedId,
      hasConversation: !!conversationId,
      pending: hasPendingInput(runtime.selectedId),
      turnWorking: runtime.turnWorking()
    });
    if (!needed) return;

    if (status?.phase !== 'opening') {
      markComposerWarmupOpening(key);
      if (inflightKey !== null) {
        runtime.paintDeliveryControls();
        return;
      }
    } else if (inflightKey !== null) return;
    inflightKey = key;
    if (status?.phase !== 'opening') runtime.paintDeliveryControls();
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
