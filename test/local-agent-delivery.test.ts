import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  events: [] as string[],
  sessions: new Map<string, any>(),
  conversations: new Map<string, string>(),
  owners: new Map<string, any>(),
  swarmAgents: [] as any[],
  spawnHandler: null as ((workers: any[]) => void) | null,
  revivalHandler: null as ((workers: any[]) => void) | null,
  acceptanceHandler: null as ((entry: any) => Promise<void>) | null,
  settledHandler: null as ((result: any) => void | Promise<void>) | null,
  config: { multiAgent: { enabled: true as boolean }, goal: { model: null as string | null } },
  sendDesktopInput: vi.fn(async (input: any) => {
    state.events.push('send');
    return { id: input.id, sessionId: input.sessionId, state: 'queued' };
  }),
  persistCriticalSwarmNow: vi.fn(async () => { state.events.push('persist'); return true; }),
  createSession: vi.fn(async (input: any) => {
    state.events.push('create');
    const session = { id: `session-${state.sessions.size}`, ...input };
    state.sessions.set(session.id, session);
    return session;
  }),
  observeSessionModel: vi.fn(async () => { state.events.push('model'); }),
  bindConversation: vi.fn((id: string, conversationId: string, runId: string) => {
    state.events.push('bind');
    state.conversations.set(`${runId}:${id}`, conversationId);
    return true;
  }),
  noteWorkerRevived: vi.fn(() => { state.events.push('revive'); return true; }),
  failAgent: vi.fn(() => null),
  failWorkerRevival: vi.fn(() => null),
  recordAgentMessage: vi.fn(async () => undefined),
  getConfig: vi.fn(() => state.config)
}));

vi.mock('../backend/infrastructure/settings/config.js', () => ({ getConfig: state.getConfig }));
vi.mock('../backend/infrastructure/settings/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('../backend/domains/providers/api-settings.js', () => ({ configuredApiEndpoint: () => ({ kind: 'openrouter', baseUrl: 'https://api.example.test/v1' }) }));
vi.mock('../backend/domains/sessions/input/start-input.js', () => ({
  sendDesktopInput: state.sendDesktopInput,
  isLocalExecutorRunning: () => false,
  onLocalExecutorTurnSettled: (handler: (result: any) => void | Promise<void>) => {
    state.settledHandler = handler;
    return () => { state.settledHandler = null; };
  }
}));
vi.mock('../backend/domains/sessions/input/input.js', () => ({
  listInputs: async () => [],
  onLocalExecutorInputAccepted: (handler: (entry: any) => Promise<void>) => {
    state.acceptanceHandler = handler;
    return () => { state.acceptanceHandler = null; };
  }
}));
vi.mock('../backend/domains/sessions/history/store.js', () => ({
  createSession: state.createSession,
  findSessionByConversation: async (conversationId: string) => {
    const session = [...state.sessions.values()].find(row => row.conversationId === conversationId);
    return session ? { id: session.id } : null;
  },
  getSession: async (sessionId: string) => state.sessions.get(sessionId) ?? null,
  observeSessionModel: state.observeSessionModel,
  readCompletedFinal: async () => null
}));
vi.mock('../backend/domains/sessions/history/recorder.js', () => ({ recordAgentMessage: state.recordAgentMessage }));
vi.mock('../backend/domains/automation/agents.js', () => ({
  agentConversation: (id: string, runId: string) => state.conversations.get(`${runId}:${id}`) ?? null,
  agentInfoForOwnedConversation: (conversationId: string) => state.owners.get(conversationId) ?? null,
  bindConversation: state.bindConversation,
  failAgent: state.failAgent,
  failWorkerRevival: state.failWorkerRevival,
  setLocalAgentDeliveryActive: vi.fn(),
  noteWorkerRevived: state.noteWorkerRevived,
  onReviveRequest: (handler: (workers: any[]) => void) => {
    state.revivalHandler = handler;
    return () => { state.revivalHandler = null; };
  },
  onSpawnRequest: (handler: (workers: any[]) => void) => {
    state.spawnHandler = handler;
    return () => { state.spawnHandler = null; };
  },
  persistCriticalSwarmNow: state.persistCriticalSwarmNow,
  releaseQuiescentRun: vi.fn(),
  requestWorkerRevivals: vi.fn(),
  sleepWorker: vi.fn(() => null),
  stageQueuedWorkerRevivals: vi.fn(() => ({ waking: [], rollback: vi.fn(), commit: vi.fn() })),
  stageWorkerConversationFinish: vi.fn(() => null),
  swarmState: () => ({ agents: state.swarmAgents })
}));

const { startLocalAgentDelivery, stopLocalAgentDelivery } = await import('../backend/domains/automation/local-agent-delivery.js');
const PARENT_ID = 'session-parent';
const API_PARENT = 'ap-11111111-1111-4111-8111-111111111111';
const WEB_PARENT = 'ds-22222222-2222-4222-8222-222222222222';
const API_WORKER = 'ap-33333333-3333-4333-8333-333333333333';

function parentSession(conversationId: string) {
  return {
    id: PARENT_ID,
    conversationId,
    selectedModel: {
      conversationId,
      model: 'account-model',
      reasoningEffort: 'high',
      apiProvider: { kind: 'openrouter', baseUrl: 'https://api.example.test/v1' }
    }
  };
}

function workerSpawn(primeConversationId: string) {
  return {
    runId: 'run-1',
    primeConversationId,
    id: 'worker-1',
    task: 'Inspect the assigned subsystem.',
    model: 'worker-model',
    reasoningEffort: 'medium'
  };
}

beforeEach(() => {
  state.events.length = 0;
  state.sessions.clear();
  state.conversations.clear();
  state.owners.clear();
  state.swarmAgents.length = 0;
  state.spawnHandler = null;
  state.revivalHandler = null;
  state.acceptanceHandler = null;
  state.settledHandler = null;
  state.config = { multiAgent: { enabled: true }, goal: { model: null } };
  state.sendDesktopInput.mockClear();
  state.persistCriticalSwarmNow.mockClear();
  state.createSession.mockClear();
  state.observeSessionModel.mockClear();
  state.bindConversation.mockClear();
  state.noteWorkerRevived.mockClear();
  state.failAgent.mockClear();
});

afterEach(async () => {
  await stopLocalAgentDelivery();
});

describe('local agent delivery', () => {
  it('binds and persists an API worker before sending its first task', async () => {
    state.sessions.set(PARENT_ID, parentSession(API_PARENT));
    state.swarmAgents.push({ id: 'worker-1', role: 'worker', state: 'invited' });
    const dispose = startLocalAgentDelivery();
    state.spawnHandler?.([workerSpawn(API_PARENT)]);
    await vi.waitFor(() => expect(state.sendDesktopInput).toHaveBeenCalledTimes(1));

    const input = state.sendDesktopInput.mock.calls[0]![0];
    const workerSession = [...state.sessions.values()].find(row => row.origin?.kind === 'worker');
    expect(workerSession?.conversationId).toMatch(/^ap-/);
    expect(workerSession?.origin).toMatchObject({ kind: 'worker', fromSessionId: PARENT_ID, agentId: 'worker-1' });
    expect(state.observeSessionModel).toHaveBeenCalledWith(
      workerSession?.id,
      workerSession?.conversationId,
      'worker-model',
      expect.any(Number),
      'medium',
      { kind: 'openrouter', baseUrl: 'https://api.example.test/v1' }
    );
    expect(input.localExecutor).toBeUndefined();
    expect(state.events.indexOf('create')).toBeLessThan(state.events.indexOf('bind'));
    expect(state.events.indexOf('model')).toBeLessThan(state.events.indexOf('bind'));
    expect(state.events.indexOf('bind')).toBeLessThan(state.events.indexOf('persist'));
    expect(state.events.indexOf('persist')).toBeLessThan(state.events.indexOf('send'));
    await dispose();
  });

  it('keeps a web worker on the exact provider used by its prime', async () => {
    state.sessions.set(PARENT_ID, parentSession(WEB_PARENT));
    state.swarmAgents.push({ id: 'worker-1', role: 'worker', state: 'invited' });
    const dispose = startLocalAgentDelivery();
    state.spawnHandler?.([workerSpawn(WEB_PARENT)]);
    await vi.waitFor(() => expect(state.sendDesktopInput).toHaveBeenCalledTimes(1));

    const input = state.sendDesktopInput.mock.calls[0]![0];
    const workerSession = [...state.sessions.values()].find(row => row.origin?.kind === 'worker');
    expect(input.webProvider).toBe('deepseek');
    expect(workerSession?.conversationId).toMatch(/^ds-/);
    await dispose();
  });

  it('refuses to create a worker on an unsupported browser conversation route', async () => {
    const legacyConversation = 'c-legacy-chat';
    state.sessions.set(PARENT_ID, parentSession(legacyConversation));
    state.swarmAgents.push({ id: 'worker-1', role: 'worker', state: 'invited' });
    const dispose = startLocalAgentDelivery();
    state.spawnHandler?.([workerSpawn(legacyConversation)]);
    await vi.waitFor(() => expect(state.failAgent).toHaveBeenCalledTimes(1));

    expect(state.sendDesktopInput).not.toHaveBeenCalled();
    await dispose();
  });

  it('marks a revived worker active only after its exact local input is accepted', async () => {
    const workerSessionId = 'session-worker';
    const worker = {
      id: 'worker-1',
      role: 'worker',
      runId: 'run-1',
      state: 'waking',
      conversationId: API_WORKER,
      model: 'worker-model',
      reasoningEffort: 'medium',
      sleptAt: 10,
      createdAt: 1
    };
    state.sessions.set(workerSessionId, {
      id: workerSessionId,
      conversationId: API_WORKER,
      origin: { kind: 'worker', fromSessionId: PARENT_ID, agentId: 'worker-1', task: 'Inspect the assigned subsystem.' }
    });
    state.owners.set(API_WORKER, worker);
    const dispose = startLocalAgentDelivery();
    state.revivalHandler?.([{
      id: 'worker-1',
      runId: 'run-1',
      conversationId: API_WORKER,
      messageIds: ['message-1'],
      text: 'Continue with the queued task.'
    }]);
    await vi.waitFor(() => expect(state.sendDesktopInput).toHaveBeenCalledTimes(1));

    const input = state.sendDesktopInput.mock.calls[0]![0];
    expect(state.noteWorkerRevived).not.toHaveBeenCalled();
    await state.acceptanceHandler?.({ id: input.id, conversationId: API_WORKER, state: 'sent' });
    expect(state.noteWorkerRevived).toHaveBeenCalledWith('worker-1', API_WORKER, ['message-1'], input.id, 'run-1');
    expect(state.events.indexOf('send')).toBeLessThan(state.events.indexOf('revive'));
    expect(state.events.indexOf('revive')).toBeLessThan(state.events.lastIndexOf('persist'));
    await dispose();
  });
});
