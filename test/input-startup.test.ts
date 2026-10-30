import { beforeEach, expect, it, vi } from 'vitest';
import type { InputArgs, InputEntry } from '../backend/domains/sessions/input/input.js';

const ports = vi.hoisted(() => ({
  provider: 'deepseek' as string,
  executor: 'web' as 'web' | 'api',
  backgroundChats: false,
  integratedWake: false,
  presenceAt: 0,
  refreshPresence: vi.fn(),
  connect: vi.fn(),
  bridge: vi.fn(),
  openProvider: vi.fn(),
  run: vi.fn(),
  apiReady: vi.fn(),
  runApi: vi.fn(),
  enqueue: vi.fn(),
  cancel: vi.fn(),
  list: vi.fn(),
  failLocal: vi.fn(),
  nextAfterTurn: vi.fn(),
  getSession: vi.fn(),
  session: null as { conversationId: string | null; activeTurnId?: string | null } | null,
  rows: [] as InputEntry[],
  presence: { deepseek: true, kimi: true, qwen: true, glm: true } as Record<string, boolean | null>
}));

vi.mock('../backend/infrastructure/connectivity/connection.js', () => ({
  connect: vi.fn(), getStatus: () => ({ state: 'disconnected', detail: '' }), onStatusChange: () => () => undefined
}));
vi.mock('../backend/domains/browser/bridge.js', () => ({
  browserWakeConnected: (host?: string) => host ? host === 'integrated' && ports.integratedWake : ports.integratedWake,
  startBridge: ports.bridge,
  webProvidersStatus: () => Object.fromEntries(Object.entries(ports.presence).map(([provider, signedIn]) => [provider,
    { open: signedIn !== false, signedIn, tabId: signedIn === false ? null : 1, lastSeenAt: ports.presenceAt }]))
}));
vi.mock('../backend/domains/browser/browser-wake.js', () => ({ wakeBrowserWork: ports.refreshPresence }));
vi.mock('../backend/domains/browser/browser-startup.js', () => ({
  wakeBrowserUrl: vi.fn(),
  resetBrowserStartupForTests: vi.fn()
}));
vi.mock('../backend/infrastructure/settings/config.js', () => ({
  getConfig: () => ({ ui: { chatExecutor: ports.executor, webProvider: ports.provider, backgroundChats: ports.backgroundChats } })
}));
vi.mock('../backend/domains/providers/browser-chat.js', () => ({ runWebProviderInput: ports.run }));
vi.mock('../backend/domains/providers/api-chat.js', () => ({ assertApiChatReady: ports.apiReady, runApiProviderInput: ports.runApi }));
vi.mock('../backend/domains/browser/embedded/selection.js', () => ({
  loadIntegratedBrowser: async () => ({ openProvider: ports.openProvider })
}));
vi.mock('../backend/domains/sessions/input/input.js', () => ({
  enqueueInput: ports.enqueue,
  cancelInput: ports.cancel,
  listInputs: ports.list,
  failLocalExecutorInput: ports.failLocal,
  nextAfterTurnLocalInput: ports.nextAfterTurn,
  noteInputStartupError: vi.fn()
}));
vi.mock('../backend/domains/sessions/history/store.js', () => ({ getSession: ports.getSession }));

import { sendDesktopInput, cancelDesktopInput, resetInputStartupForTests } from '../backend/domains/sessions/input/start-input.js';

const request: InputArgs = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  text: 'Please inspect this project',
  mode: 'auto',
  dueAt: 0,
  model: null,
  reasoningEffort: null
};

beforeEach(() => {
  vi.resetAllMocks();
  resetInputStartupForTests();
  ports.provider = 'deepseek';
  ports.executor = 'web';
  ports.backgroundChats = false;
  ports.integratedWake = true;
  ports.presenceAt = Date.now();
  ports.refreshPresence.mockImplementation(() => { ports.presenceAt = Date.now() + 1; });
  ports.rows = [];
  ports.nextAfterTurn.mockResolvedValue(null);
  ports.session = null;
  ports.getSession.mockImplementation(async () => ports.session);
  ports.presence = { deepseek: true, kimi: true, qwen: true, glm: true };
  ports.bridge.mockResolvedValue(8765);
  ports.openProvider.mockResolvedValue(undefined);
  ports.run.mockResolvedValue(undefined);
  ports.apiReady.mockResolvedValue(undefined);
  ports.runApi.mockResolvedValue(undefined);
  ports.enqueue.mockImplementation(async (input: InputArgs): Promise<InputEntry> => {
    const row = {
      ...input,
      ...(input.delivery === 'tool' ? { transportIntent: 'tool' as const } : {}),
      state: 'queued' as const,
      owner: null,
      createdAt: 1,
      conversationId: input.sessionId ? ports.session?.conversationId ?? null : null
    } as InputEntry;
    ports.rows.push(row);
    return row;
  });
  ports.cancel.mockImplementation(async (id: string) => {
    const row = ports.rows.find(entry => entry.id === id);
    if (!row) return false;
    row.state = 'cancelled';
    return true;
  });
  ports.list.mockImplementation(async () => ports.rows);
  ports.failLocal.mockImplementation(async (id: string, error: string) => {
    const row = ports.rows.find(entry => entry.id === id && entry.state === 'queued');
    if (!row) return false;
    row.state = 'failed';
    row.error = error.slice(0, 200);
    return true;
  });
});

it.each([
  'deepseek', 'kimi', 'qwen', 'glm'
] as const)('sends through the selected %s browser session without an account tunnel', async (provider) => {
  ports.provider = provider;
  const row = await sendDesktopInput(request);
  expect(row).toMatchObject({ id: request.id, state: 'queued' });
  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledOnce());

  expect(ports.bridge).toHaveBeenCalledOnce();
  expect(ports.openProvider).toHaveBeenCalledWith(provider, { reveal: false });
  expect(ports.run).toHaveBeenCalledWith(row, provider, expect.any(AbortSignal));
  expect(ports.enqueue).toHaveBeenCalledWith(request, undefined, provider);
  expect(ports.connect).not.toHaveBeenCalled();
});

it('keeps the selected provider page hidden during a background send', async () => {
  ports.provider = 'qwen';
  ports.backgroundChats = true;
  await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledOnce());
  expect(ports.openProvider).toHaveBeenCalledWith('qwen', { reveal: false });
});

it('runs API chats through the configured endpoint without opening a browser session', async () => {
  ports.executor = 'api';
  const row = await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.runApi).toHaveBeenCalledOnce());
  expect(row.state).toBe('queued');
  expect(ports.apiReady).toHaveBeenCalledOnce();
  expect(ports.runApi).toHaveBeenCalledWith(row, expect.any(AbortSignal));
  expect(ports.bridge).not.toHaveBeenCalled();
  expect(ports.openProvider).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('keeps an existing web session on its original provider after the new-chat default changes', async () => {
  ports.provider = 'deepseek';
  ports.executor = 'api';
  ports.session = { conversationId: 'qw-00000000-0000-4000-8000-000000000001' };
  const row = await sendDesktopInput({ ...request, sessionId: 'session-existing' });

  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledOnce());
  expect(ports.openProvider).toHaveBeenCalledWith('qwen', { reveal: false });
  expect(ports.run).toHaveBeenCalledWith(row, 'qwen', expect.any(AbortSignal));
  expect(ports.apiReady).not.toHaveBeenCalled();
});

it('keeps an existing API session on its original endpoint after the new-chat default changes', async () => {
  ports.executor = 'web';
  ports.session = { conversationId: 'ap-00000000-0000-4000-8000-000000000001' };
  const row = await sendDesktopInput({ ...request, sessionId: 'session-existing' });

  await vi.waitFor(() => expect(ports.runApi).toHaveBeenCalledOnce());
  expect(ports.apiReady).toHaveBeenCalledOnce();
  expect(ports.bridge).not.toHaveBeenCalled();
  expect(ports.openProvider).not.toHaveBeenCalled();
  expect(ports.runApi).toHaveBeenCalledWith(row, expect.any(AbortSignal));
});

it('starts project preparation immediately when the existing local chat is idle', async () => {
  ports.session = { conversationId: 'ds-00000000-0000-4000-8000-000000000018', activeTurnId: null };
  const row = await sendDesktopInput({
    ...request,
    sessionId: 'session-existing',
    text: 'NEURAFLOK_WARMUP',
    warmup: true,
    authoredSource: 'none'
  });

  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledOnce());
  expect(row).toMatchObject({ state: 'queued', mode: 'auto', warmup: true });
  expect(ports.run).toHaveBeenCalledWith(row, 'deepseek', expect.any(AbortSignal));
});

it('defers project preparation only when the backend sees a live local turn', async () => {
  ports.session = { conversationId: 'ds-00000000-0000-4000-8000-000000000019', activeTurnId: 'live-turn' };
  const row = await sendDesktopInput({
    ...request,
    sessionId: 'session-existing',
    text: 'NEURAFLOK_WARMUP',
    warmup: true,
    authoredSource: 'none'
  });

  expect(row).toMatchObject({ state: 'queued', mode: 'after-turn', afterTurn: true, warmup: true });
  expect(ports.run).not.toHaveBeenCalled();
});

it('keeps a second local-provider message queued until the active response finishes', async () => {
  ports.session = { conversationId: 'ap-00000000-0000-4000-8000-000000000001' };
  let complete!: (turnId: string | null) => void;
  ports.runApi.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const first = await sendDesktopInput({ ...request, id: '10000000-0000-4000-8000-000000000001', sessionId: 'session-existing' });
  await vi.waitFor(() => expect(ports.runApi).toHaveBeenCalledOnce());
  const second = await sendDesktopInput({ ...request, id: '20000000-0000-4000-8000-000000000002', sessionId: 'session-existing' });

  expect(first.mode).toBe('auto');
  expect(second).toMatchObject({ state: 'queued', mode: 'after-turn', afterTurn: true });
  expect(ports.runApi).toHaveBeenCalledOnce();
  complete(null);
});

it('dispatches the next local follow-up only after the provider reports a completed turn', async () => {
  ports.session = { conversationId: 'ap-00000000-0000-4000-8000-000000000001' };
  ports.runApi.mockResolvedValueOnce('completed-local-turn');
  const followup = {
    ...request,
    id: '30000000-0000-4000-8000-000000000003',
    sessionId: 'session-existing',
    mode: 'after-turn',
    afterTurn: true,
    state: 'queued',
    owner: null,
    createdAt: 1,
    conversationId: 'ap-00000000-0000-4000-8000-000000000001'
  } as InputEntry;
  ports.nextAfterTurn.mockResolvedValueOnce(followup);
  await sendDesktopInput({ ...request, sessionId: 'session-existing' });

  await vi.waitFor(() => expect(ports.runApi).toHaveBeenCalledTimes(2));
  expect(ports.nextAfterTurn).toHaveBeenCalledWith('session-existing', 'ap-00000000-0000-4000-8000-000000000001', 'completed-local-turn');
  expect(ports.runApi.mock.calls[1]?.[0]).toMatchObject({ id: followup.id, mode: 'after-turn' });
});

it('delivers a project message exactly once after its active preparation turn completes', async () => {
  const sessionId = 'project-session';
  const conversationId = 'ds-00000000-0000-4000-8000-000000000071';
  ports.session = { conversationId, activeTurnId: null };
  let releasePreparation!: () => void;
  ports.run.mockImplementation(async entry => {
    if (entry.warmup) {
      ports.session = { conversationId, activeTurnId: 'project-preparation-turn' };
      await new Promise<void>(resolve => { releasePreparation = resolve; });
      ports.session = { conversationId, activeTurnId: null };
      return 'project-preparation-turn';
    }
    return 'authored-project-turn';
  });

  const preparation = await sendDesktopInput({
    ...request,
    id: '40000000-0000-4000-8000-000000000004',
    sessionId,
    projectId: 'project-1',
    text: 'NEURAFLOK_WARMUP',
    warmup: true,
    authoredSource: 'none'
  });
  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledOnce());

  const authored = await sendDesktopInput({
    ...request,
    id: '50000000-0000-4000-8000-000000000005',
    sessionId,
    projectId: 'project-1',
    text: 'Explain this project',
    mode: 'auto'
  });
  expect(authored).toMatchObject({ state: 'queued', mode: 'after-turn', afterTurn: true });
  expect(ports.run).toHaveBeenCalledOnce();
  const queued = ports.rows.find(row => row.id === authored.id)!;
  ports.nextAfterTurn.mockResolvedValueOnce(queued);

  releasePreparation();
  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  expect(ports.run.mock.calls[0]?.[0]).toMatchObject({ id: preparation.id, warmup: true });
  expect(ports.run.mock.calls[1]?.[0]).toMatchObject({ id: authored.id, text: 'Explain this project', mode: 'after-turn' });
  expect(ports.nextAfterTurn).toHaveBeenCalledWith(sessionId, conversationId, 'project-preparation-turn');
  await vi.waitFor(() => expect(ports.nextAfterTurn).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  expect(ports.rows.filter(row => row.id === authored.id)).toHaveLength(1);
});

it('fails closed for a saved session with an unknown provider identity', async () => {
  ports.session = { conversationId: 'legacy-unknown-provider' };
  await expect(sendDesktopInput({ ...request, sessionId: 'session-existing' })).rejects.toThrow('unsupported provider session');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
  expect(ports.runApi).not.toHaveBeenCalled();
});

it('does not queue an API message until its endpoint and model settings are ready', async () => {
  ports.executor = 'api';
  ports.apiReady.mockRejectedValueOnce(new Error('Add an API key in Settings.'));
  await expect(sendDesktopInput(request)).rejects.toThrow('Add an API key');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.runApi).not.toHaveBeenCalled();
});

it('does not send a provider message when the companion cannot verify the session', async () => {
  ports.presence.deepseek = false;
  await expect(sendDesktopInput(request)).rejects.toThrow('no message was sent');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.openProvider).not.toHaveBeenCalled();
});

it('keeps a detected session distinct from browser-companion connectivity', async () => {
  ports.presence.deepseek = false;
  ports.integratedWake = true;
  await expect(sendDesktopInput(request)).rejects.toThrow('could not verify the DeepSeek session');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('does not send while provider sign-in is unknown, even when the browser extension is reachable', async () => {
  ports.presence.deepseek = null;
  ports.integratedWake = true;
  await expect(sendDesktopInput(request)).rejects.toThrow('could not verify the DeepSeek session');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('refreshes provider sign-in before accepting a message when saved presence is stale', async () => {
  ports.presence.deepseek = false;
  ports.integratedWake = true;
  ports.refreshPresence.mockImplementation(() => {
    ports.presence.deepseek = true;
    ports.presenceAt = Date.now() + 1;
  });
  const row = await sendDesktopInput(request);

  await vi.waitFor(() => expect(ports.run).toHaveBeenCalledOnce());
  expect(row).toMatchObject({ state: 'queued', id: request.id });
  expect(ports.openProvider).toHaveBeenCalledWith('deepseek', { reveal: false });
  expect(ports.run).toHaveBeenCalledWith(row, 'deepseek', expect.any(AbortSignal));
});

it('does not enqueue when the live provider refresh cannot confirm the session', async () => {
  ports.presence.deepseek = false;
  ports.integratedWake = true;
  await expect(sendDesktopInput(request)).rejects.toThrow('could not verify the DeepSeek session');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('reports a disconnected companion without claiming that DeepSeek signed out', async () => {
  ports.integratedWake = false;
  await expect(sendDesktopInput(request)).rejects.toThrow('browser connection to DeepSeek is not active');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('refuses live tool injection into a local provider response', async () => {
  await expect(sendDesktopInput({ ...request, sessionId: 'session-existing', delivery: 'tool' }))
    .rejects.toThrow('cannot receive a live message');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.bridge).not.toHaveBeenCalled();
  expect(ports.openProvider).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('explains that provider-neutral finish boundaries are unavailable for local chats', async () => {
  await expect(sendDesktopInput({ ...request, mode: 'finish' })).rejects.toThrow('Finish-boundary automation is not available');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.bridge).not.toHaveBeenCalled();
  expect(ports.openProvider).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('rejects attachments and images before creating a queue entry', async () => {
  await expect(sendDesktopInput({ ...request, images: [{ name: 'photo.webp', dataUrl: 'data:image/webp;base64,AA==' }] }))
    .rejects.toThrow('web sessions accept text and source files');
  expect(ports.enqueue).not.toHaveBeenCalled();
  expect(ports.run).not.toHaveBeenCalled();
});

it('surfaces a failed browser-page wake on the original queued entry without enqueueing again', async () => {
  ports.openProvider.mockRejectedValueOnce(new Error('The browser could not open the provider page.'));
  const row = await sendDesktopInput(request);
  await vi.waitFor(() => expect(row.state).toBe('failed'));
  expect(row.error).toContain('browser could not open');
  expect(ports.failLocal).toHaveBeenCalledOnce();
  expect(ports.enqueue).toHaveBeenCalledOnce();
  expect(ports.run).not.toHaveBeenCalled();
});

it('records provider execution errors against the same accepted message', async () => {
  ports.run.mockRejectedValueOnce(new Error('Provider did not accept this message.'));
  const row = await sendDesktopInput(request);
  await vi.waitFor(() => expect(row.state).toBe('failed'));
  expect(row.error).toBe('Provider did not accept this message.');
  expect(ports.enqueue).toHaveBeenCalledOnce();
  expect(ports.run).toHaveBeenCalledOnce();
});

it('cancels startup while waiting for the browser and never sends after cancellation', async () => {
  let release!: () => void;
  ports.openProvider.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const row = await sendDesktopInput(request);
  await vi.waitFor(() => expect(ports.openProvider).toHaveBeenCalledOnce());
  expect(await cancelDesktopInput(request.id)).toBe(true);
  expect(row.state).toBe('cancelled');
  release();
  await vi.waitFor(() => expect(ports.run).not.toHaveBeenCalled());
});

it('refuses new sends after shutdown starts', async () => {
  const { stopInputStartup } = await import('../backend/domains/sessions/input/start-input.js');
  stopInputStartup();
  await expect(sendDesktopInput({ ...request, id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }))
    .rejects.toThrow('shutting down');
  expect(ports.enqueue).not.toHaveBeenCalled();
});
