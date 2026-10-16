import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
export const { OFFLINE_GOAL_MARKER_INSTRUCTION } = await import('../../contracts/automation/offline-goal-catalog.js');
export const { currentCoreInstructions } = await import('../../backend/infrastructure/tool-gateway/protocol/instructions.js');
export const { prependUserPrompt, userPromptText } = await import('../../contracts/messaging/provider-message-envelope.js');
export const { finishInstruction } = await import('../../contracts/automation/completion-policy.js');
export const { initSkillsPath } = await import('../../backend/domains/skills/storage/catalog.js');
export const { randomUUID } = await import('node:crypto');
export const { promises: fs } = await import('node:fs');
export const path = (await import('node:path')).default;
export const { addProject, assignSessionProject } = await import('../../backend/domains/workspace/projects.js');
export const { APP_VERSION, BRIDGE_PROTOCOL } = await import('../../backend/infrastructure/settings/version.js');
export const browserWake = await import('../../backend/domains/browser/browser-wake.js');

export type Handler = (event: unknown, payload: unknown) => Promise<any>;

export const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) },
  BrowserWindow: class {}, clipboard: {}, dialog: {}, shell: {}, nativeTheme: { themeSource: 'system' },
  app: { on: vi.fn(), getPath: () => '', getVersion: () => '0.0.0', getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (text: string) => Buffer.from(text),
    decryptStringAsync: async (data: Buffer) => ({ result: data.toString(), shouldReEncrypt: false })
  }
}));

vi.mock('../../backend/domains/browser/extension-path.js', () => ({ extensionDir: () => process.cwd(), shippedExtensionBuild: () => null, extensionUpdateOffer: () => null, prepareExtensionUpdate: () => null }));

vi.mock('../../backend/domains/browser/browser.js', () => ({ openInPreferredBrowser: async () => 'chrome.exe', isPreferredBrowserRunning: async () => null }));

export const { defaultConfig, initConfigPath, saveConfig } = await import('../../backend/infrastructure/settings/config.js');

export const { initSecretsPath } = await import('../../backend/infrastructure/settings/secrets.js');

export const { initDurableStore, flushDurable, resetDurableForTests, writeDurableNow } = await import('../../backend/persistence/durable.js');

export const { createSession, getSession, rebindSession, initSessionStore, resetSessionStoreForTests } = await import('../../backend/domains/sessions/history/store.js');

export const { registerIpc } = await import('../../backend/application/ipc/register.js');

export const { bridgePort, startBridge, stopBridge } = await import('../../backend/domains/browser/bridge.js');

export const input = await import('../../backend/domains/sessions/input/input.js');

export const goal = await import('../../backend/domains/automation/goal.js');

export const providerPage = await import('../../backend/domains/providers/provider-page.js');

export const { makeTempDir, removeTempDir } = await import('../helpers.js');

export let directory: string;

export let bearer: string;

export const pushed = vi.fn();

export async function post(route: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${bridgePort()}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-extension-version': APP_VERSION,
      'x-extension-protocol': String(BRIDGE_PROTOCOL), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

beforeAll(async () => {
  directory = await makeTempDir('clf-input-integration-');
  initConfigPath(directory); initSecretsPath(directory); initDurableStore(directory); initSessionStore(directory);
  await saveConfig(defaultConfig());
  registerIpc(() => ({ isDestroyed: () => false, webContents: { send: pushed } }) as never, () => undefined);
  await startBridge();
  const paired = await post('/pair', {});
  expect(paired.status).toBe(200);
  bearer = paired.body.token;
});

beforeEach(async () => {
  providerPage.resetProviderPageForTests();
  await writeDurableNow('session-input', []);
  goal.resetGoalStateForTests(); input.resetInputForTests(); pushed.mockClear();
  await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoContinue: false }, goal: { ...defaultConfig().goal, enabled: false } });
});

/** Files the automatic Continue for a silent turn exactly as the app does, and returns its row. */
export async function silentTurnContinue(title: string, advance: (ms: number) => number) {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  const conversationId = randomUUID(), turnId = randomUUID(), questionId = randomUUID();
  const session = await createSession({ title, conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', time: Date.now() },
    { kind: 'user_message', messageId: questionId, text: 'Finish the task', time: Date.now() },
    { kind: 'turn_start', turnId, time: Date.now() }
  ] });
  await attributedMcp(conversationId);
  await bridge.sweepStaleSwarm(advance(120_000));
  const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs
    .find((item: any) => item.conversationId === conversationId);
  expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
  await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
  const row = (await input.listInputs()).find(item => item.sessionId === session.id && item.recovery)!;
  expect(row).toMatchObject({ state: 'queued' });
  return { conversationId, turnId, session, row };
}

export async function attributedMcp(conversationId: string): Promise<void> {
  const requestId = randomUUID();
  await post('/events', { conversationId, events: [{ kind: 'tool_evidence', time: Date.now(),
    calls: [{ messageId: randomUUID(), tool: 'read', order: 0, answered: false, requestId }] }] });
  const { recordToolCall } = await import('../../backend/domains/sessions/history/recorder.js');
  await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Fixture result' }],
    outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
}

export async function refreshFailedView(conversationId: string, advance: (ms: number) => void) {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  const { findSessionByConversation } = await import('../../backend/domains/sessions/history/store.js');
  const session = (await findSessionByConversation(conversationId))!;
  const deadline = (await bridge.sessionControlsFor(session.id)).recovery?.find(row => row.kind === 'silence')?.deadline;
  expect(deadline).toBeDefined();
  advance(Math.max(0, deadline! - Date.now()));
  await bridge.sweepStaleSwarm(Date.now());
  const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
  expect(repair).toMatchObject({ reason: 'silence' });
  await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
  const listenMs = session.selectedModel?.model === 'gpt-6-pro' ? 300_000 : 60_000;
  advance(listenMs - 1);
  const pending = await input.pendingBrowserInputs();
  expect(pending.some(row => row.conversationId === conversationId && !row.recovery)).toBe(false);
  advance(1);
}

afterAll(async () => {
  await stopBridge(); await flushDurable(); resetSessionStoreForTests(); resetDurableForTests();
  await removeTempDir(directory);
});

export const message = (sessionId: string | null, automation: 'off' | 'goal' | 'loop') => ({
  id: randomUUID(), sessionId, automation, text: 'Complete this request', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null
});
