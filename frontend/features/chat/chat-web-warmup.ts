import { usesApiProvider } from '../../../contracts/chat-protocol.js';
import { providerForConversationId, selectableWebProviderOrDefault, type WebProviderId } from '../../../contracts/web-providers.js';
import type { AppState } from '../../../contracts/types.js';
import type { SessionEvent } from '../../../contracts/session.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { run } from '../../shared/dom.js';
import {
  adoptOpeningSession,
  clearComposerWarmup,
  composerWarmupKey,
  composerWarmupState,
  isHandshakeAck,
  markComposerWarmupFailed,
  markComposerWarmupOpening,
  setComposerWarmupHandlers
} from './chat-composer-ready.js';

export const WEB_CHAT_WARMUP_TEXT = 'NEURAFLOK_WARMUP';
const POLL_INTERVAL_MS = 750;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const IDLE_RETRIES_BEFORE_PAUSE = 3;
// Keep the renderer waiting long enough for the backend's bounded, progress-aware
// provider handshake to finish and record its final state.
export const WEB_CHAT_PREPARATION_TIMEOUT_MS = 6 * 60_000;

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

function confirmedWarmupAcknowledgement(event: SessionEvent, inputId: string): boolean {
  return event.kind === 'assistant_message' && event.inputId === inputId &&
    (event.final === true || event.state === 'final') && isHandshakeAck(event.message.text);
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
  events: SessionEvent[];
  turnWorking: () => boolean;
  pendingNewInput: { id: string; generation: number } | null;
  startingInputs: Map<string, InputEntry>;
  pendingComposerInputs: InputEntry[];
  adoptAcceptedOpening: (entry: InputEntry) => Promise<boolean>;
  selectSession: (id: string) => void;
  paintDeliveryControls: () => void;
  refreshSessionControls: () => Promise<void>;
  refreshInputQueue: () => Promise<void>;
  setPendingNewInput: (value: { id: string; generation: number } | null) => void;
  paintPreparationStatus: () => void;
}

export function createWebChatWarmup(runtime: WebChatWarmupRuntime): { ensure: () => void; retry: () => void; dispose: () => void } {
  let inflightKey: string | null = null;
  const verifiedSessions = new Map<string, { provider: WebProviderId; conversationId: string; generation: number }>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();

  function selectedProjectId(): string | null {
    return runtime.selectedId
      ? runtime.sessions.find(row => row.id === runtime.selectedId)?.projectId ?? runtime.selectedProjectId
      : runtime.selectedProjectId;
  }

  function authoredProjectInputWaiting(): boolean {
    if (!selectedProjectId()) return false;
    const pendingNewInput = runtime.pendingNewInput;
    const candidates = [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs];
    return candidates.some(entry => {
      if (entry.warmup || entry.purpose === 'decision' || ['failed', 'cancelled'].includes(entry.state)) return false;
      if (entry.warmupDeferred) return false;
      if (runtime.selectedId) {
        if ((entry.sessionId ?? entry.deliveredSessionId) !== runtime.selectedId) return false;
      } else if (!pendingNewInput || pendingNewInput.generation !== runtime.selectionGeneration || pendingNewInput.id !== entry.id) {
        return false;
      }
      if (entry.state === 'queued' || entry.state === 'browser') return true;
      if (entry.state !== 'sent') return false;
      const user = runtime.events.find(event => event.kind === 'user_message' && event.inputId === entry.id);
      const terminal = user && runtime.events.some(event => event.seq > user.seq &&
        ((event.kind === 'turn_end' && event.outcome !== 'unknown') ||
          (event.kind === 'assistant_message' && event.final) || event.kind === 'chat_error'));
      // A sent outbox row may still be waiting for its first provider event.
      // Do not start a second hidden bootstrap while its authored turn is live.
      return runtime.turnWorking() || Date.now() - entry.createdAt < WEB_CHAT_PREPARATION_TIMEOUT_MS && !terminal;
    });
  }

  function currentSelectionKey(): string {
    return composerWarmupKey(runtime.selectedId, runtime.selectionGeneration);
  }

  function currentProvider(app: AppState): WebProviderId {
    return selectableWebProviderOrDefault(app.config.ui.webProvider);
  }

  function hasPendingAuthoredMessage(sessionId: string | null, generation: number): boolean {
    const pendingNew = runtime.pendingNewInput;
    return [...runtime.startingInputs.values(), ...runtime.pendingComposerInputs].some(entry => {
      if (entry.warmup || entry.purpose === 'decision' || ['failed', 'cancelled'].includes(entry.state)) return false;
      const owner = entry.sessionId ?? entry.deliveredSessionId ?? null;
      const belongs = sessionId
        ? owner === sessionId
        : owner === null && (pendingNew?.generation === generation && pendingNew.id === entry.id ||
          runtime.selectionGeneration === generation && runtime.newChatSelected);
      if (!belongs) return false;
      if (entry.state === 'queued' || entry.state === 'browser') return true;
      if (entry.state !== 'sent') return false;
      const user = runtime.events.find(event => event.kind === 'user_message' && event.inputId === entry.id);
      if (!user) return true;
      return !runtime.events.some(event => event.seq > user.seq && (
        (event.kind === 'turn_end' && event.outcome !== 'unknown') ||
        (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) ||
        event.kind === 'chat_error'
      ));
    });
  }

  function scheduleInternalRetry(key: string, provider: WebProviderId, sessionId: string | null,
    projectId: string | null, generation: number): void {
    if (retryTimers.has(key)) return;
    const previousAttempts = retryAttempts.get(key) ?? 0;
    const pendingMessage = hasPendingAuthoredMessage(sessionId, generation);
    if (!pendingMessage && previousAttempts >= IDLE_RETRIES_BEFORE_PAUSE) {
      retryAttempts.delete(key);
      markComposerWarmupFailed(key, 'Internal context preparation will resume when this chat is used.', generation);
      runtime.paintPreparationStatus();
      return;
    }
    const attempt = previousAttempts + 1;
    retryAttempts.set(key, attempt);
    const delay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 5));
    retryTimers.set(key, setTimeout(() => {
      retryTimers.delete(key);
      const selectionStillOwns = runtime.selectionGeneration === generation &&
        (runtime.selectedId === sessionId || (sessionId === null && runtime.selectedId === null && runtime.newChatSelected));
      if (!hasPendingAuthoredMessage(sessionId, generation) && !selectionStillOwns) {
        retryAttempts.delete(key);
        clearComposerWarmup(key);
        runtime.paintPreparationStatus();
        return;
      }
      if (inflightKey !== null) {
        scheduleInternalRetry(key, provider, sessionId, projectId, generation);
        return;
      }
      if (!composerWarmupState(key)) markComposerWarmupOpening(key, generation);
      inflightKey = key;
      void start(key, provider, sessionId, projectId, generation);
    }, delay));
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
    const acknowledged = detail?.events.some(event => confirmedWarmupAcknowledgement(event, accepted.id));
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
      const acknowledged = detail?.events.some(event => confirmedWarmupAcknowledgement(event, entry.id));
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
    const priorTurnWorking = composerWarmupState(priorKey)?.priorTurnWorking;
    markComposerWarmupOpening(boundId, generation, priorTurnWorking);
    if (boundId !== priorKey) clearComposerWarmup(priorKey);
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
    // Let the backend bind after-turn delivery to the turn that is actually
    // active now. The renderer's remembered priorTurnWorking bit can outlive a
    // completed turn and strand this preparation request forever.
    const mode = 'auto' as const;
    const seed: InputEntry = {
      id, sessionId, projectId, text: WEB_CHAT_WARMUP_TEXT, warmup: true, authoredSource: 'none',
      mode, dueAt, model: null, reasoningEffort: null, state: 'queued', owner: null, createdAt: dueAt,
      conversationId: null
    };
    runtime.startingInputs.set(id, seed);
    if (sessionId === null && runtime.selectionGeneration === generation && runtime.newChatSelected && runtime.selectedId === null)
      runtime.setPendingNewInput({ id, generation });
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
      if (sessionId === null && runtime.selectionGeneration === generation && runtime.newChatSelected && runtime.selectedId === null)
        runtime.setPendingNewInput({ id: accepted.id, generation });
      boundId = await bindWarmupSession(accepted, generation, key);
      if (boundId !== key) markComposerWarmupOpening(boundId, generation);
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
      for (const retryKey of new Set([key, boundId])) {
        const timer = retryTimers.get(retryKey);
        if (timer) clearTimeout(timer);
        retryTimers.delete(retryKey);
        retryAttempts.delete(retryKey);
      }
      // Keep the internal-preparation gate in place until Stop is reconciled
      // with the turn that exists after the acknowledgement. The controls
      // fetched when the old chat opened can still describe its previous
      // turn, which briefly exposed Stop as soon as this gate was cleared.
      if (runtime.selectedId === boundId) await runtime.refreshSessionControls();
      clearComposerWarmup(key);
      clearComposerWarmup(boundId);
      runtime.paintPreparationStatus();
    } catch {
      const failedKey = boundId ?? key;
      if (failedKey !== key) clearComposerWarmup(key);
      // The provider flight for a failed warmup is internal preparation, not
      // an authored turn. Keep its gate in place until the old-chat controls
      // snapshot is refreshed, just as we do after a successful acknowledgement.
      if (runtime.selectedId === boundId) {
        try { await runtime.refreshSessionControls(); } catch { /* Preserve the original preparation error. */ }
      }
      // Context verification is internal preparation. Keep the queued user
      // input and preparation gate intact while retrying; a transient provider
      // handoff must not be presented as a failed user message.
      markComposerWarmupOpening(failedKey,
        runtime.selectedId === boundId ? runtime.selectionGeneration : generation);
      if (runtime.pendingNewInput?.id === id && runtime.pendingNewInput.generation === generation)
        runtime.setPendingNewInput(null);
      scheduleInternalRetry(failedKey, provider, boundId, projectId,
        runtime.selectedId === boundId ? runtime.selectionGeneration : generation);
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
    const projectScoped = Boolean(session?.projectId ?? runtime.selectedProjectId);
    if (retryTimers.has(key)) return;
    if (status?.phase === 'failed' && status.generation === runtime.selectionGeneration) {
      markComposerWarmupOpening(key, runtime.selectionGeneration, runtime.turnWorking());
      scheduleInternalRetry(key, provider, runtime.selectedId, session?.projectId ?? runtime.selectedProjectId,
        runtime.selectionGeneration);
      runtime.paintPreparationStatus();
      return;
    }
    if (status?.phase === 'failed') clearComposerWarmup(key);
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

    // A rapid project switch can leave another chat's bootstrap in the shared
    // provider queue. Do not mark this chat as preparing until its own request
    // can actually start; otherwise a message in a second new project chat is
    // queued after a warmup that belongs to the first chat and can never drain.
    if (projectScoped && inflightKey !== null) return;
    // If the user already started the first project request while another
    // chat's bootstrap was in flight, that authored request performs its own
    // project setup. Starting a separate warmup afterwards would create an
    // orphan provider chat or queue unnecessary work behind the answer.
    if (projectScoped && authoredProjectInputWaiting()) return;

    if (status?.phase !== 'opening') {
      markComposerWarmupOpening(key, runtime.selectionGeneration, runtime.turnWorking());
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
    const timer = retryTimers.get(key);
    if (timer) clearTimeout(timer);
    retryTimers.delete(key);
    retryAttempts.delete(key);
    clearComposerWarmup(key);
    if (runtime.selectedId) verifiedSessions.delete(runtime.selectedId);
    ensure();
  }

  function dispose(): void {
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    retryAttempts.clear();
  }

  setComposerWarmupHandlers({ ensure, retry });
  return { ensure, retry, dispose };
}
