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
        events: entry ? [{ kind: 'assistant_message', inputId: entry.id, state: 'final', final: true, message: { text: 'NEURAFLOK_READY' } }] : []
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
    refreshSessionControls: vi.fn(async () => undefined),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput: vi.fn()
  };
  resetComposerWarmupForTests();
  const warmup = createWebChatWarmup(runtime);

  warmup.ensure();

  expect(composerWarmupState(sessionId)).toEqual({ phase: 'opening', generation: 1, priorTurnWorking: true });
  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull());
  expect(sendInput).toHaveBeenCalledTimes(1);
  expect(sendInput.mock.calls[0]![0]).toMatchObject({ sessionId, warmup: true, authoredSource: 'none', mode: 'auto' });
  expect(runtime.pendingComposerInputs[0]).toMatchObject({ id: 'early-message', state: 'queued' });
  expect(runtime.paintDeliveryControls).toHaveBeenCalled();
  expect(runtime.refreshSessionControls).toHaveBeenCalled();
  expect(runtime.paintPreparationStatus).toHaveBeenCalled();

  warmup.ensure();
  expect(sendInput).toHaveBeenCalledTimes(1);
  runtime.selectionGeneration++;
  warmup.ensure();
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull());
  resetComposerWarmupForTests();
});

it('waits for a final readiness acknowledgement before releasing the internal preparation gate', async () => {
  const sessionId = 'old-chat-streaming-readiness';
  const conversationId = 'ds-00000000-0000-4000-8000-000000000042';
  let entry: any;
  let final = false;
  const getSession = vi.fn(async () => ({ ok: true, data: {
    summary: { id: sessionId, conversationId },
    events: entry ? [{ kind: 'assistant_message', inputId: entry.id, state: final ? 'final' : 'streaming', final,
      message: { text: 'NEURAFLOK_READY' } }] : []
  } }));
  const runtime: any = {
    api: {
      sendInput: vi.fn(async (request: any) => {
        entry = { ...request, sessionId, deliveredSessionId: sessionId, state: 'sent', createdAt: Date.now(), conversationId };
        return { ok: true, data: entry };
      }),
      listInputs: async () => ({ ok: true, data: entry ? [entry] : [] }),
      getSession,
      cancelInput: vi.fn()
    },
    state: () => ({ config: { ui: { chatExecutor: 'web', webProvider: 'deepseek' } },
      bridge: { webProviders: { deepseek: { signedIn: true } } } }),
    newChatSelected: false,
    selectedId: sessionId,
    selectedProjectId: null,
    selectionGeneration: 10,
    sessions: [{ id: sessionId, conversationId, projectId: null }],
    turnWorking: () => false,
    pendingNewInput: null,
    startingInputs: new Map(),
    pendingComposerInputs: [],
    adoptAcceptedOpening: async () => false,
    selectSession: vi.fn(),
    paintDeliveryControls: vi.fn(),
    paintPreparationStatus: vi.fn(),
    refreshSessionControls: vi.fn(async () => undefined),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput: vi.fn()
  };
  resetComposerWarmupForTests();
  createWebChatWarmup(runtime).ensure();
  await vi.waitFor(() => expect(getSession).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 25));

  expect(composerWarmupState(sessionId)?.phase).toBe('opening');
  expect(runtime.refreshSessionControls).not.toHaveBeenCalled();
  final = true;
  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull(), { timeout: 2_000 });
  expect(runtime.refreshSessionControls).toHaveBeenCalledTimes(1);
  resetComposerWarmupForTests();
});

it('keeps stale Stop hidden until old-chat controls refresh after the warmup acknowledgement', async () => {
  const sessionId = 'old-chat-with-stale-stop';
  const conversationId = 'ds-00000000-0000-4000-8000-000000000041';
  let entry: any;
  let activeTurnId: string | null = 'stale-turn-from-before-opening';
  let releaseControls!: () => void;
  const visibleStopStates: boolean[] = [];
  const runtime: any = {
    api: {
      sendInput: vi.fn(async (request: any) => {
        entry = { ...request, sessionId, deliveredSessionId: sessionId, state: 'sent', createdAt: Date.now(), conversationId };
        return { ok: true, data: entry };
      }),
      listInputs: async () => ({ ok: true, data: entry ? [entry] : [] }),
      getSession: async () => ({ ok: true, data: {
        summary: { id: sessionId, conversationId },
        events: entry ? [{ kind: 'assistant_message', inputId: entry.id, state: 'final', final: true, message: { text: 'NEURAFLOK_READY' } }] : []
      } }),
      cancelInput: vi.fn()
    },
    state: () => ({ config: { ui: { chatExecutor: 'web', webProvider: 'deepseek' } },
      bridge: { webProviders: { deepseek: { signedIn: true } } } }),
    newChatSelected: false,
    selectedId: sessionId,
    selectedProjectId: 'synthetic-project',
    selectionGeneration: 9,
    sessions: [{ id: sessionId, conversationId, projectId: 'synthetic-project' }],
    turnWorking: () => false,
    pendingNewInput: null,
    startingInputs: new Map(),
    pendingComposerInputs: [],
    adoptAcceptedOpening: async () => false,
    selectSession: vi.fn(),
    paintDeliveryControls: vi.fn(() => {
      visibleStopStates.push(composerWarmupState(sessionId)?.phase !== 'opening' && activeTurnId !== null);
    }),
    paintPreparationStatus: vi.fn(),
    refreshSessionControls: vi.fn(() => new Promise<void>(resolve => {
      releaseControls = () => { activeTurnId = null; resolve(); };
    })),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput: vi.fn()
  };
  resetComposerWarmupForTests();
  const warmup = createWebChatWarmup(runtime);

  warmup.ensure();
  await vi.waitFor(() => expect(runtime.refreshSessionControls).toHaveBeenCalledTimes(1));

  expect(composerWarmupState(sessionId)?.phase).toBe('opening');
  expect(visibleStopStates).not.toContain(true);
  releaseControls();
  await vi.waitFor(() => expect(composerWarmupState(sessionId)).toBeNull());
  expect(visibleStopStates).not.toContain(true);
  resetComposerWarmupForTests();
});

it('keeps stale Stop hidden until old-project controls refresh after a failed warmup', async () => {
  const sessionId = 'old-project-chat-with-failed-warmup';
  const conversationId = 'ds-00000000-0000-4000-8000-000000000042';
  let entry: any;
  let activeTurnId: string | null = 'stale-turn-from-before-failed-warmup';
  let releaseControls!: () => void;
  const visibleStopStates: boolean[] = [];
  const runtime: any = {
    api: {
      sendInput: vi.fn(async (request: any) => {
        entry = { ...request, sessionId, deliveredSessionId: sessionId, state: 'sent', createdAt: Date.now(), conversationId };
        return { ok: true, data: entry };
      }),
      listInputs: async () => ({ ok: true, data: entry ? [entry] : [] }),
      getSession: async () => ({ ok: true, data: { summary: { id: sessionId, conversationId },
        events: entry ? [{ kind: 'chat_error', inputId: entry.id, message: { text: 'Synthetic warmup failure' } }] : [] } }),
      cancelInput: vi.fn()
    },
    state: () => ({ config: { ui: { chatExecutor: 'web', webProvider: 'deepseek' } },
      bridge: { webProviders: { deepseek: { signedIn: true } } } }),
    newChatSelected: false,
    selectedId: sessionId,
    selectedProjectId: 'synthetic-project',
    selectionGeneration: 10,
    sessions: [{ id: sessionId, conversationId, projectId: 'synthetic-project' }],
    turnWorking: () => false,
    pendingNewInput: null,
    startingInputs: new Map(),
    pendingComposerInputs: [],
    adoptAcceptedOpening: async () => false,
    selectSession: vi.fn(),
    paintDeliveryControls: vi.fn(() => {
      visibleStopStates.push(composerWarmupState(sessionId)?.phase !== 'opening' && activeTurnId !== null);
    }),
    paintPreparationStatus: vi.fn(),
    refreshSessionControls: vi.fn(() => new Promise<void>(resolve => {
      releaseControls = () => { activeTurnId = null; resolve(); };
    })),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput: vi.fn()
  };
  resetComposerWarmupForTests();
  const warmup = createWebChatWarmup(runtime);

  warmup.ensure();
  await vi.waitFor(() => expect(runtime.refreshSessionControls).toHaveBeenCalledTimes(1));

  expect(composerWarmupState(sessionId)?.phase).toBe('opening');
  expect(visibleStopStates).not.toContain(true);
  releaseControls();
  await vi.waitFor(() => expect(composerWarmupState(sessionId)?.phase).toBe('failed'));
  expect(visibleStopStates).not.toContain(true);
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
      refreshSessionControls: vi.fn(async () => undefined),
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
        events: warmupEntry ? [{ kind: 'assistant_message', inputId: warmupEntry.id, state: 'final', final: true,
          message: { text: 'NEURAFLOK_READY' } }] : []
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
    refreshSessionControls: vi.fn(async () => undefined),
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

it('does not show a second project as preparing while another chat owns the warmup slot', async () => {
  let releaseFirst!: (value: any) => void;
  let firstRequest: any;
  const sendInput = vi.fn((request: any) => {
    firstRequest = request;
    return new Promise(resolve => { releaseFirst = resolve; });
  });
  const conversationId = 'ds-00000000-0000-4000-8000-000000000031';
  const runtime: any = {
    api: {
      sendInput,
      listInputs: async () => ({ ok: true, data: [] }),
      getSession: async (sessionId: string) => ({ ok: true, data: {
        summary: { id: sessionId, conversationId },
        events: [{ kind: 'assistant_message', inputId: firstRequest?.id, state: 'final', final: true, message: { text: 'NEURAFLOK_READY' } }]
      } }),
      cancelInput: vi.fn()
    },
    state: () => ({ config: { ui: { chatExecutor: 'web', webProvider: 'deepseek' } },
      bridge: { webProviders: { deepseek: { signedIn: true } } } }),
    newChatSelected: true,
    selectedId: null,
    selectedProjectId: 'project-a',
    selectionGeneration: 4,
    sessions: [],
    events: [],
    turnWorking: () => false,
    pendingNewInput: null,
    startingInputs: new Map(),
    pendingComposerInputs: [],
    adoptAcceptedOpening: async () => false,
    selectSession: vi.fn(),
    paintDeliveryControls: vi.fn(),
    paintPreparationStatus: vi.fn(),
    refreshSessionControls: vi.fn(async () => undefined),
    refreshInputQueue: vi.fn(async () => undefined),
    setPendingNewInput(value: any) { this.pendingNewInput = value; }
  };
  resetComposerWarmupForTests();
  const warmup = createWebChatWarmup(runtime);
  warmup.ensure();
  await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(1));

  runtime.selectionGeneration = 5;
  runtime.selectedProjectId = 'project-b';
  runtime.pendingNewInput = null;
  warmup.ensure();
  expect(composerWarmupState(composerWarmupKey(null, 5))).toBeNull();

  const authored = { id: 'project-b-message', projectId: 'project-b', text: 'Question in project B', state: 'queued', createdAt: Date.now() };
  runtime.startingInputs.set(authored.id, authored);
  runtime.pendingNewInput = { id: authored.id, generation: 5 };
  const accepted = { ...firstRequest, id: firstRequest.id, sessionId: firstRequest.id, deliveredSessionId: firstRequest.id,
    opening: true, state: 'sent', createdAt: Date.now(), conversationId };
  runtime.api.listInputs = async () => ({ ok: true, data: [accepted] });
  releaseFirst({ ok: true, data: accepted });

  await vi.waitFor(() => expect(runtime.startingInputs.has(firstRequest.id)).toBe(false));
  expect(runtime.api.sendInput).toHaveBeenCalledTimes(1);
  expect(runtime.pendingNewInput).toEqual({ id: authored.id, generation: 5 });
  expect(composerWarmupState(composerWarmupKey(null, 5))).toBeNull();
  resetComposerWarmupForTests();
});
