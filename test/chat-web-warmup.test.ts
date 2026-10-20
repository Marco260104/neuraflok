import { expect, it, vi } from 'vitest';
import { createWebChatWarmup, isWarmupInput, webChatWarmupNeeded, WEB_CHAT_PREPARATION_TIMEOUT_MS } from '../frontend/features/chat/chat-web-warmup.js';
import { composerWarmupKey, composerWarmupState, markComposerWarmupFailed, resetComposerWarmupForTests } from '../frontend/features/chat/chat-composer-ready.js';

const base = {
  apiExecutor: false,
  signedIn: true,
  webProvider: 'deepseek',
  newChatSelected: true,
  selectedId: null,
  hasConversation: false
};

it('prepares signed-in web chats before delivering queued messages', () => {
  expect(webChatWarmupNeeded({
    ...base
  })).toBe(true);
  expect(webChatWarmupNeeded({
    ...base, newChatSelected: false, selectedId: 'session-1', hasConversation: true
  })).toBe(true);
  expect(webChatWarmupNeeded({ ...base, signedIn: false })).toBe(false);
  expect(webChatWarmupNeeded({ ...base, apiExecutor: true })).toBe(false);
  expect(webChatWarmupNeeded({ ...base, webProvider: 'kimi' })).toBe(true);
  expect(webChatWarmupNeeded({ ...base, newChatSelected: false, selectedId: 'session-1', hasConversation: true })).toBe(true);
  expect(webChatWarmupNeeded({ ...base, newChatSelected: false, selectedId: 'session-1', hasConversation: false })).toBe(false);
  expect(isWarmupInput({ warmup: true })).toBe(true);
  expect(isWarmupInput({})).toBe(false);
});

it('waits for the matching DeepSeek acknowledgement while existing messages stay queued', async () => {
  const sessionId = 'session-existing';
  const conversationId = 'ds-00000000-0000-4000-8000-000000000015';
  let entry: any;
  const sendInput = vi.fn(async (request: any) => {
    entry = { ...request, sessionId, deliveredSessionId: sessionId, state: 'sent', createdAt: Date.now(), conversationId };
    return { ok: true, data: entry };
  });
  const runtime: any = {
    api: {
      sendInput,
      listInputs: async () => ({ ok: true, data: entry ? [entry] : [] }),
      getSession: async () => ({ ok: true, data: {
        summary: { id: sessionId, conversationId },
        events: entry ? [{ kind: 'assistant_message', inputId: entry.id, message: { text: 'NEURAFLOK_READY' } }] : []
      } })
    },
    state: () => ({ config: { ui: { chatExecutor: 'web', webProvider: 'deepseek' } },
      bridge: { webProviders: { deepseek: { signedIn: true } } } }),
    newChatSelected: false,
    selectedId: sessionId,
    selectedProjectId: null,
    selectionGeneration: 1,
    sessions: [{ id: sessionId, conversationId, projectId: null }],
    turnWorking: () => true,
    pendingNewInput: null,
    startingInputs: new Map(),
    _pendingComposerInputs: [{ id: 'early-message', sessionId, mode: 'after-turn', state: 'queued', createdAt: Date.now() }],
    set pendingComposerInputs(value: any[]) { this._pendingComposerInputs = value; },
    get pendingComposerInputs() { return this._pendingComposerInputs ?? []; },
    adoptAcceptedOpening: async () => false,
    selectSession: vi.fn(),
    paintDeliveryControls: vi.fn(),
    paintPreparationStatus: vi.fn(),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput: vi.fn()
  };
  resetComposerWarmupForTests();
  const warmup = createWebChatWarmup(runtime);

  warmup.ensure();

  expect(composerWarmupState(sessionId)).toEqual({ phase: 'opening', generation: 1, priorTurnWorking: true });
  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull());
  expect(sendInput).toHaveBeenCalledTimes(1);
  expect(sendInput.mock.calls[0]![0]).toMatchObject({ sessionId, warmup: true, authoredSource: 'none', mode: 'after-turn' });
  expect(runtime.pendingComposerInputs[0]).toMatchObject({ id: 'early-message', state: 'queued' });
  expect(runtime.paintDeliveryControls).toHaveBeenCalled();
  expect(runtime.paintPreparationStatus).toHaveBeenCalled();

  warmup.ensure();
  expect(sendInput).toHaveBeenCalledTimes(1);
  runtime.selectionGeneration++;
  warmup.ensure();
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull());
  resetComposerWarmupForTests();
});

it('releases the preparing gate when a readiness IPC call never returns', async () => {
  vi.useFakeTimers();
  try {
    const sessionId = 'session-stalled';
    const runtime: any = {
      api: {
        sendInput: vi.fn(),
        listInputs: () => new Promise(() => undefined),
        getSession: vi.fn(),
        cancelInput: vi.fn()
      },
      state: () => ({ config: { ui: { chatExecutor: 'web', webProvider: 'deepseek' } },
        bridge: { webProviders: { deepseek: { signedIn: true } } } }),
      newChatSelected: false,
      selectedId: sessionId,
      selectedProjectId: null,
      selectionGeneration: 2,
      sessions: [{ id: sessionId, conversationId: 'ds-00000000-0000-4000-8000-000000000016', projectId: null }],
      turnWorking: () => false,
      pendingNewInput: null,
      startingInputs: new Map(),
      pendingComposerInputs: [],
      adoptAcceptedOpening: async () => false,
      selectSession: vi.fn(),
      paintDeliveryControls: vi.fn(),
      paintPreparationStatus: vi.fn(),
      refreshInputQueue: vi.fn(async () => undefined),
      setPendingNewInput: vi.fn()
    };
    resetComposerWarmupForTests();
    createWebChatWarmup(runtime).ensure();
    await vi.advanceTimersByTimeAsync(WEB_CHAT_PREPARATION_TIMEOUT_MS);
    expect(composerWarmupState(sessionId)?.phase).toBe('failed');
  } finally {
    vi.useRealTimers();
    resetComposerWarmupForTests();
  }
});

it('retries chat preparation even when a user message is waiting in the queue', async () => {
  const sessionId = 'session-with-queued-message';
  const conversationId = 'ds-00000000-0000-4000-8000-000000000017';
  let warmupEntry: any;
  const queuedMessage = { id: 'queued-request', sessionId, mode: 'after-turn', state: 'queued', createdAt: Date.now() };
  const runtime: any = {
    api: {
      sendInput: vi.fn(async (request: any) => {
        warmupEntry = { ...request, sessionId, deliveredSessionId: sessionId, state: 'sent', createdAt: Date.now(), conversationId };
        return { ok: true, data: warmupEntry };
      }),
      listInputs: async () => ({ ok: true, data: [queuedMessage, ...(warmupEntry ? [warmupEntry] : [])] }),
      getSession: async () => ({ ok: true, data: {
        summary: { id: sessionId, conversationId },
        events: warmupEntry ? [{ kind: 'assistant_message', inputId: warmupEntry.id, message: { text: 'NEURAFLOK_READY' } }] : []
      } }),
      cancelInput: vi.fn()
    },
    state: () => ({ config: { ui: { chatExecutor: 'web', webProvider: 'deepseek' } },
      bridge: { webProviders: { deepseek: { signedIn: true } } } }),
    newChatSelected: false,
    selectedId: sessionId,
    selectedProjectId: null,
    selectionGeneration: 3,
    sessions: [{ id: sessionId, conversationId, projectId: null }],
    turnWorking: () => false,
    pendingNewInput: null,
    startingInputs: new Map(),
    pendingComposerInputs: [queuedMessage],
    adoptAcceptedOpening: async () => false,
    selectSession: vi.fn(),
    paintDeliveryControls: vi.fn(),
    paintPreparationStatus: vi.fn(),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput: vi.fn()
  };
  resetComposerWarmupForTests();
  const key = composerWarmupKey(sessionId, runtime.selectionGeneration);
  markComposerWarmupFailed(key, 'previous readiness request timed out');
  const warmup = createWebChatWarmup(runtime);
  warmup.retry();

  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull());
  expect(runtime.api.sendInput).toHaveBeenCalledTimes(1);
  expect(runtime.api.sendInput.mock.calls[0]![0]).toMatchObject({ sessionId, warmup: true });
  resetComposerWarmupForTests();
});
