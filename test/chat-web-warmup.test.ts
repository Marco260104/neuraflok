import { expect, it, vi } from 'vitest';
import { createWebChatWarmup, isWarmupInput, webChatWarmupNeeded, WEB_CHAT_PREPARATION_TIMEOUT_MS } from '../frontend/features/chat/chat-web-warmup.js';
import { composerReadyPhase, composerSendBlocked, composerWarmupState, resetComposerReadyGateForTests } from '../frontend/features/chat/chat-composer-ready.js';

const base = {
  apiExecutor: false,
  signedIn: true,
  webProvider: 'deepseek',
  newChatSelected: true,
  selectedId: null,
  hasConversation: false,
  pending: false,
  turnWorking: false
};

it('prepares new and existing DeepSeek chats before enabling the composer', () => {
  expect(webChatWarmupNeeded({
    ...base
  })).toBe(true);
  expect(webChatWarmupNeeded({
    ...base, newChatSelected: false, selectedId: 'session-1', hasConversation: true
  })).toBe(true);
  expect(webChatWarmupNeeded({ ...base, signedIn: false })).toBe(false);
  expect(webChatWarmupNeeded({ ...base, apiExecutor: true })).toBe(false);
  expect(webChatWarmupNeeded({ ...base, webProvider: 'kimi' })).toBe(false);
  expect(webChatWarmupNeeded({ ...base, pending: true })).toBe(false);
  expect(webChatWarmupNeeded({ ...base, turnWorking: true })).toBe(false);
  expect(webChatWarmupNeeded({ ...base, newChatSelected: false, selectedId: 'session-1', hasConversation: false })).toBe(false);
  expect(isWarmupInput({ warmup: true })).toBe(true);
  expect(isWarmupInput({})).toBe(false);
});

it('keeps the composer blocked until the provider confirms readiness', () => {
  expect(composerReadyPhase({ apiExecutor: false, signedIn: true, opening: true })).toBe('opening');
  expect(composerReadyPhase({ apiExecutor: false, signedIn: true, failed: true })).toBe('failed');
  expect(composerReadyPhase({ apiExecutor: true, signedIn: true, opening: true })).toBe('ready');
  expect(composerSendBlocked('opening', true)).toBe(true);
  expect(composerSendBlocked('failed', true)).toBe(true);
  expect(composerSendBlocked('ready', false)).toBe(false);
});

it('waits for the matching DeepSeek acknowledgement before unblocking an existing chat', async () => {
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
    turnWorking: () => false,
    pendingNewInput: null,
    startingInputs: new Map(),
    _pendingComposerInputs: [],
    set pendingComposerInputs(value: any[]) { this._pendingComposerInputs = value; },
    get pendingComposerInputs() { return this._pendingComposerInputs ?? []; },
    adoptAcceptedOpening: async () => false,
    selectSession: vi.fn(),
    paintDeliveryControls: vi.fn(),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput: vi.fn()
  };
  resetComposerReadyGateForTests();
  const warmup = createWebChatWarmup(runtime);

  warmup.ensure();

  expect(composerWarmupState(sessionId)).toEqual({ phase: 'opening' });
  expect(composerSendBlocked(composerReadyPhase({ apiExecutor: false, signedIn: true, opening: true }), false)).toBe(true);
  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull());
  expect(sendInput).toHaveBeenCalledTimes(1);
  expect(sendInput.mock.calls[0]![0]).toMatchObject({ sessionId, warmup: true, authoredSource: 'none' });
  expect(runtime.paintDeliveryControls).toHaveBeenCalled();
  resetComposerReadyGateForTests();
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
      refreshInputQueue: vi.fn(async () => undefined),
      setPendingNewInput: vi.fn()
    };
    resetComposerReadyGateForTests();
    createWebChatWarmup(runtime).ensure();
    await vi.advanceTimersByTimeAsync(WEB_CHAT_PREPARATION_TIMEOUT_MS);
    expect(composerWarmupState(sessionId)?.phase).toBe('failed');
  } finally {
    vi.useRealTimers();
    resetComposerReadyGateForTests();
  }
});
