import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  handlers,
  defaultConfig,
  getConfig,
  saveConfig,
  nativeTheme,
  save,
  ipcFixture,
} from './ipc-context.js';
describe('bounded IPC identities and OS launch results', () => {
  it('bounds and validates an agent id before it reaches the global broker', async () => {
    const clear = handlers.get('swarm:clearAgent')!;
    const oversized = (await clear(null, 'worker-' + 'x'.repeat(200_000))) as { ok: boolean; error?: string };
    expect(oversized.ok).toBe(false);
    expect(oversized.error).toMatch(/64|too big/i);

    const punctuation = (await clear(null, 'worker-1\nspoofed')) as { ok: boolean; error?: string };
    expect(punctuation.ok).toBe(false);
  });
});

describe('integrated browser settings', () => {
  it('normalizes a legacy external-browser choice and keeps the integrated browser through a stale save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const result = await save({ ...base, ui: { ...base.ui, chatBrowser: 'edge' } }, base);
    expect(result.ok, result.error).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(ipcFixture.dir, 'config.json'), 'utf8')).ui.chatBrowser).toBe('integrated');
    const stale = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ chatBrowser: 'integrated', theme: 'light' });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, chatBrowser: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.chatBrowser).toBe('integrated');
  });
});

describe('settings writes from more than one UI', () => {
  it('changes login registration only on a changed preference and reports failure after other effects', async () => {
    const lifecycle = await import('../backend/infrastructure/desktop-shell/window-lifecycle.js');
    const login = vi.spyOn(lifecycle, 'applyLoginStartup').mockImplementation(() => { throw new Error('login registration refused'); });
    try {
      const base = defaultConfig();
      await saveConfig(base);
      const cosmetic = await save({ ...base, ui: { ...base.ui, theme: 'light' } }, base);
      expect(cosmetic.ok, cosmetic.error).toBe(true);
      expect(login).not.toHaveBeenCalled();
      const current = getConfig();
      const changed = await save({ ...current, ui: { ...current.ui, theme: 'dark', startAtLogin: true } }, current);
      expect(changed.ok).toBe(false);
      expect(changed.error).toContain('login registration refused');
      expect(getConfig().ui.startAtLogin).toBe(true);
      expect(nativeTheme.themeSource).toBe('dark');
      expect(login).toHaveBeenCalledOnce();
    } finally { login.mockRestore(); }
  });
  it('rotates only the active Goal provider and exposes key presence without the secret', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, providers: { api: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } } });
    const goal = await import('../backend/domains/automation/goal.js');
    const retired = vi.spyOn(goal, 'retireGoalDrafts');
    try {
      await handlers.get('secret:set')!({}, { key: 'openRouterApiKey', value: 'synthetic-inactive-key' });
      expect(retired).not.toHaveBeenCalled();
      const response = await handlers.get('secret:set')!({}, { key: 'customProviderApiKey', value: 'synthetic-active-key' });
      expect(retired).toHaveBeenCalledTimes(1);
      expect(response).toMatchObject({ ok: true, data: { hasCustomProviderKey: true } });
      expect(JSON.stringify(response)).not.toContain('synthetic-active-key');
    } finally { retired.mockRestore(); }
  });
  it('persists provider tool guidance through IPC, preserves concurrent edits, and allows explicit clearing', async () => {
    const base = defaultConfig(); await saveConfig(base);
    const wanted = { ...base, providerTools: { instructions: 'Use the approved project only.' }, ui: { ...base.ui, browserOnly: true } };
    expect((await save(wanted, base)).ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(ipcFixture.dir, 'config.json'), 'utf8')).providerTools).toEqual(wanted.providerTools);
    expect(getConfig().ui.browserOnly).toBe(true);
    expect((await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base)).ok).toBe(true);
    expect(getConfig().providerTools).toEqual(wanted.providerTools);
    expect(getConfig().ui.browserOnly).toBe(true);
    const legacy = { ...base } as any; delete legacy.providerTools;
    expect((await save(legacy, legacy)).ok).toBe(true);
    expect(getConfig().providerTools).toEqual(wanted.providerTools);
    const current = getConfig();
    expect((await save({ ...current, providerTools: { instructions: '' } }, current)).ok).toBe(true);
    expect(getConfig().providerTools.instructions).toBe('');
    expect((await save({ ...current, providerTools: { instructions: 'x'.repeat(4001) } }, current)).ok).toBe(false);
    expect(getConfig().providerTools.instructions).toBe('');
  });
  it('starts and stops the local control API only when its switch changes, and keeps it through stale saves', async () => {
    const controlApi = await import('../backend/infrastructure/local-api/control-api.js');
    controlApi.initControlApiPath(ipcFixture.dir);
    const endpoint = path.join(ipcFixture.dir, 'control-api', 'endpoint.json');
    try {
      const base = defaultConfig(); await saveConfig(base);
      expect((await save({ ...base, controlApi: { enabled: true } }, base)).ok).toBe(true);
      expect(JSON.parse(await fs.readFile(path.join(ipcFixture.dir, 'config.json'), 'utf8')).controlApi).toEqual({ enabled: true, allowActions: false });
      const { port } = JSON.parse(await fs.readFile(endpoint, 'utf8'));
      expect(controlApi.controlApiPort()).toBe(port);
      // A save from a form that still shows the old value, and one from a build that has no such field, both leave the switch and the running listener alone.
      expect((await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base)).ok).toBe(true);
      const legacy = { ...base } as Partial<typeof base>; delete legacy.controlApi;
      expect((await save(legacy, legacy)).ok).toBe(true);
      expect(getConfig().controlApi.enabled).toBe(true);
      expect(controlApi.controlApiPort()).toBe(port);
      const current = getConfig();
      expect((await save({ ...current, controlApi: { enabled: false } }, current)).ok).toBe(true);
      expect(controlApi.controlApiPort()).toBeNull();
      await expect(fs.access(endpoint)).rejects.toThrow();
      // Switched off means nothing listens any more, not merely that requests are refused.
      await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
    } finally {
      await controlApi.stopControlApi();
    }
  });
  it('keeps message actions behind the API switch and merges the two switches independently', async () => {
    const controlApi = await import('../backend/infrastructure/local-api/control-api.js');
    controlApi.initControlApiPath(ipcFixture.dir);
    try {
      const base = defaultConfig(); await saveConfig(base);
      // Actions cannot be granted while the API is off.
      expect((await save({ ...base, controlApi: { enabled: false, allowActions: true } }, base)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: false, allowActions: false });
      const off = getConfig();
      expect((await save({ ...off, controlApi: { enabled: true, allowActions: true } }, off)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: true, allowActions: true });
      expect(controlApi.controlApiPort()).not.toBeNull();
      // A form from a build with no allowActions field, and a stale form still showing it off, both leave a grant that was made after they were loaded.
      const granted = getConfig();
      expect((await save({ ...granted, controlApi: { enabled: true } }, granted)).ok).toBe(true);
      expect(getConfig().controlApi.allowActions).toBe(true);
      const stale = { ...granted, controlApi: { enabled: true, allowActions: false } };
      expect((await save(stale, stale)).ok).toBe(true);
      expect(getConfig().controlApi.allowActions).toBe(true);
      // Turning the API off revokes the grant and stops the listener; turning it back on does not bring the grant back.
      const running = getConfig();
      expect((await save({ ...running, controlApi: { enabled: false, allowActions: true } }, running)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: false, allowActions: false });
      expect(controlApi.controlApiPort()).toBeNull();
      const stopped = getConfig();
      expect((await save({ ...stopped, controlApi: { enabled: true } }, stopped)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: true, allowActions: false });
      // The grant can be withdrawn on its own without stopping the listener.
      const again = getConfig();
      expect((await save({ ...again, controlApi: { enabled: true, allowActions: true } }, again)).ok).toBe(true);
      const withdraw = getConfig();
      expect((await save({ ...withdraw, controlApi: { enabled: true, allowActions: false } }, withdraw)).ok).toBe(true);
      expect(getConfig().controlApi).toEqual({ enabled: true, allowActions: false });
      expect(controlApi.controlApiPort()).not.toBeNull();
    } finally {
      await controlApi.stopControlApi();
    }
  });
  it('saves tab retention through the renderer schema and merge boundary', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const wanted = { ...base, ui: { ...base.ui, tabsToKeepOpen: 6 } };
    const result = await save(wanted, base);
    expect(result.ok, result.error).toBe(true);
    expect(getConfig().ui.tabsToKeepOpen).toBe(6);
    expect(getConfig().goal.model).toBe(base.goal.model);
  });
  it('ignores removed account model defaults during settings saves', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const configured = { ...base, ui: { ...base.ui, defaultChatModel: 'gpt-5.6-sol', defaultChatReasoning: 'xhigh' } };
    expect((await save(configured, base)).ok).toBe(true);
    expect(getConfig().ui).not.toHaveProperty('defaultChatModel');
    expect(getConfig().ui).not.toHaveProperty('defaultChatReasoning');
    const stored = JSON.parse(await fs.readFile(path.join(ipcFixture.dir, 'config.json'), 'utf8'));
    expect(stored.ui).not.toHaveProperty('defaultChatModel');
    expect(stored.ui).not.toHaveProperty('defaultChatReasoning');
  });
  it('persists the planner backend and preserves it across an unrelated stale settings save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const selected = await save({ ...base, ui: { ...base.ui, planBackend: 'api' } }, base);
    expect(selected.ok, selected.error).toBe(true);
    expect(getConfig().ui.planBackend).toBe('api');
    expect(JSON.parse(await fs.readFile(path.join(ipcFixture.dir, 'config.json'), 'utf8')).ui.planBackend).toBe('api');
    const stale = await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().ui).toMatchObject({ planBackend: 'api', minimizeToTray: !base.ui.minimizeToTray });
    const current = getConfig();
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'web' } }, current)).ok).toBe(true);
    expect(getConfig().ui.planBackend).toBe('web');
    expect((await save({ ...current, ui: { ...current.ui, planBackend: 'unsupported' } }, current)).ok).toBe(false);
    expect(getConfig().ui.planBackend).toBe('web');
  });
  it('does not let a stale renderer snapshot undo a newer extension setting', async () => {
    ipcFixture.currentWindow = {
      setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn(),
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    };
    const original = defaultConfig();
    const base = {
      ...original,
      ui: { ...original.ui, theme: 'light' as const },
      goal: { ...original.goal, enabled: true }
    };
    await saveConfig(base);

    // The extension writes after the renderer has already captured `base` for an unrelated form edit. This is exactly the race a serialized config queue cannot solve by itself.
    await saveConfig({ ...base, goal: { ...base.goal, enabled: false } });
    const wanted = { ...base, ui: { ...base.ui, theme: 'dark' as const } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.theme).toBe('dark');
    expect(nativeTheme.themeSource).toBe('dark');
    const { defaultAppearance } = await import('../contracts/appearance-settings.js');
    expect(ipcFixture.currentWindow.setBackgroundColor).toHaveBeenCalledWith(defaultAppearance().dark.background);
    if (process.platform === 'win32') expect(ipcFixture.currentWindow.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 36, color: '#00000000', symbolColor: '#ffffff'
    });
    expect(getConfig().goal.enabled).toBe(false);
  });

  it('persists command policy fields independently across stale renderer saves', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    const enabled = await save({
      ...base, commandAllowlist: { enabled: true, mode: 'deny', rules: ['git status', 'git diff *'] }
    }, base);
    expect(enabled.ok, enabled.error).toBe(true);

    const stale = await save({ ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } }, base);
    expect(stale.ok, stale.error).toBe(true);
    expect(getConfig().commandAllowlist).toEqual({ enabled: true, mode: 'deny', rules: ['git status', 'git diff *'] });

    const current = getConfig();
    expect((await save({
      ...current, commandAllowlist: { ...current.commandAllowlist, enabled: false }
    }, current)).ok).toBe(true);
    expect(getConfig().commandAllowlist).toEqual({ enabled: false, mode: 'deny', rules: ['git status', 'git diff *'] });
    expect((await save({
      ...getConfig(), commandAllowlist: { enabled: true, mode: 'allow', rules: ['git status; whoami'] }
    }, getConfig())).ok).toBe(false);
  });

  it('preserves a newer unattributed-call choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, allowUnattributedCalls: true }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.allowUnattributedCalls).toBe(true);
  });

  it('preserves a newer agent-tab recovery choice across an unrelated stale renderer save', async () => {
    const base = defaultConfig();
    await saveConfig(base);
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, recoverAgentTabs: false }
    });

    const wanted = { ...base, ui: { ...base.ui, minimizeToTray: !base.ui.minimizeToTray } };
    const reply = await save(wanted, base);

    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().ui.minimizeToTray).toBe(!base.ui.minimizeToTray);
    expect(getConfig().multiAgent.recoverAgentTabs).toBe(false);
  });
});

