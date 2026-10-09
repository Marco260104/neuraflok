// IPC tests exercise renderer-facing handlers and their shared lifecycle boundaries.

import { afterAll, beforeAll, beforeEach, vi } from 'vitest';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const ipcState = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
export const handlers = ipcState.handlers;

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => ipcState.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })), showSaveDialog: vi.fn(async () => ({ canceled: true })) },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  nativeTheme: { themeSource: 'system' },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  app: { on: vi.fn(), getPath: (_name: string) => '', getLocale: () => 'en-US', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false }
}));

// This suite owns IPC behavior, not Electron's packaged-vs-checkout path discovery.
vi.mock('../backend/domains/browser/extension-path.js', () => ({ shippedExtensionBuild: () => null, extensionUpdateOffer: () => null, prepareExtensionUpdate: () => null }));
vi.mock('../backend/domains/browser/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));
vi.mock('../backend/domains/browser/embedded/selection.js', () => ({ loadIntegratedBrowser: vi.fn(), syncIntegratedBrowser: vi.fn() }));

export const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import('../backend/infrastructure/settings/config.js');
export const { initSecretsPath, resetSecretsCacheForTests } = await import('../backend/infrastructure/settings/secrets.js');
export const { appendEvent, createSession, getSession, initSessionStore, rebindSession, resetSessionStoreForTests, upsertMessageEvent } = await import('../backend/domains/sessions/history/store.js');
export const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../backend/persistence/durable.js');
export const { pendingCommands, resetBridgeForTests, setBrowserOpener, startBridge, stopBridge } = await import(
  '../backend/domains/browser/bridge.js'
);
export const {
  bindConversation,
  finishAgent,
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmPersist,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  pendingWorkerRevivals,
  releaseQuiescentRun,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  snapshotRetiredWorkers,
  snapshotSwarm,
  spawn,
  swarmStateForCaller
} = await import('../backend/domains/automation/agents.js');
export const { registerIpc, cleanSessionName } = await import('../backend/application/ipc/register.js');
export const { openInPreferredBrowser } = await import('../backend/domains/browser/browser.js');
export const { loadIntegratedBrowser } = await import('../backend/domains/browser/embedded/selection.js');
export const { app, nativeTheme, safeStorage, shell, dialog } = await import('electron');
export const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../backend/domains/workspace/workspace.js');
export const { faultGate, makeTempDir, removeTempDir } = await import('./helpers.js');

export const ipcFixture = { dir: '', currentWindow: null as any, quitToInstallCalls: 0 };

export const save = (patch: unknown, base: unknown = getConfig()): Promise<any> =>
  handlers.get('settings:save')!(null, { patch, base }) as Promise<any>;
export const renameRoot = (payload: unknown): Promise<any> => handlers.get('roots:rename')!(null, payload) as Promise<any>;
export const removeRoot = (payload: unknown): Promise<any> => handlers.get('roots:remove')!(null, payload) as Promise<any>;
export const sessionEvents = (payload: unknown): Promise<any> => handlers.get('sessions:events')!(null, payload) as Promise<any>;
export const sessionList = (): Promise<any> => handlers.get('sessions:list')!(null, undefined) as Promise<any>;

export function settings(over: { record: boolean; multiAgent: boolean }) {
  const base = defaultConfig();
  return {
    capabilities: base.capabilities,
    readOnly: base.readOnly,
    commandAllowlist: base.commandAllowlist,
    ui: base.ui,
    sessions: { ...base.sessions, record: over.record },
    compaction: base.compaction,
    multiAgent: { ...base.multiAgent, enabled: over.multiAgent },
    providers: base.providers,
    goal: base.goal
  };
}

beforeAll(async () => {
  ipcFixture.dir = await makeTempDir('clf-ipc-');
  initConfigPath(ipcFixture.dir);
  initSecretsPath(ipcFixture.dir);
  initSessionStore(ipcFixture.dir);
  initDurableStore(ipcFixture.dir);
  onSwarmPersist(() => writeDurableSoon('ipc-swarm', snapshotSwarm()));
  onSwarmPersistNow((snapshot) => writeDurableNow('ipc-swarm', snapshot));
  onRetiredWorkersPersist(() => writeDurableSoon('ipc-retired-workers', snapshotRetiredWorkers()));
  onRetiredWorkersPersistNow((snapshot) => writeDurableNow('ipc-retired-workers', snapshot));
  registerIpc(
    () => ipcFixture.currentWindow as any,
    () => {
      ipcFixture.quitToInstallCalls += 1;
    }
  );
});

afterAll(async () => {
  await stopBridge();
  await flushDurable();
  onSwarmPersist(null);
  onSwarmPersistNow(null);
  onRetiredWorkersPersist(null);
  onRetiredWorkersPersistNow(null);
  resetSessionStoreForTests();
  await removeTempDir(ipcFixture.dir);
});

beforeEach(async () => {
  ipcFixture.currentWindow = null;
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
  nativeTheme.themeSource = 'system';
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(shell.openExternal).mockReset().mockResolvedValue(undefined);
  vi.mocked(app.getVersion).mockReset().mockReturnValue('0.0.0');
  resetSwarm();
  resetBridgeForTests();
  vi.mocked(loadIntegratedBrowser).mockReset();
  resetWorkspaces();
  // The app opens the worker's chat itself; a command only exists while a page it opened still has it to redeem.
  setBrowserOpener(async () => undefined);
  await saveConfig({
    ...defaultConfig(),
    sessions: { ...defaultConfig().sessions, record: true },
    multiAgent: { enabled: true, maxWorkers: 3, allowUnattributedCalls: false, recoverAgentTabs: true }
  });
});

