import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import {
  handlers,
  defaultConfig,
  getConfig,
  saveConfig,
  startBridge,
  openInPreferredBrowser,
  loadIntegratedBrowser,
  shell,
  setWorkspaceFor,
  workspaceEntries,
  save,
  renameRoot,
  removeRoot,
  settings,
  ipcFixture,
} from './ipc-context.js';
describe('root namespace invariants', () => {
  it('approves a dropped folder path exactly like the picker, and refuses a dropped file', async () => {
    await saveConfig({ ...defaultConfig(), roots: [] });
    const folder = path.join(ipcFixture.dir, 'dropped-project');
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(ipcFixture.dir, 'dropped-file.txt');
    await fs.writeFile(file, 'not a folder');
    const addPath = (payload: unknown): Promise<any> => handlers.get('roots:addPath')!(null, payload) as Promise<any>;

    const added = await addPath({ path: folder });
    expect(added.ok).toBe(true);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['dropped-project']);

    // The drop zone is not a second, weaker approval path: the same validation applies.
    const refused = await addPath({ path: file });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not a folder/i);
    expect((await addPath({ path: '' })).ok).toBe(false);
    expect(getConfig().roots).toHaveLength(1);
  });

  it('refuses a live rename into the reserved /skills namespace', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [
        { name: 'project', path: 'C:\\Users\\example\\project' },
        { name: 'skills-folder', path: 'C:\\Users\\example\\skills-folder' }
      ]
    });

    const reply = await renameRoot({ name: 'project', newName: 'skills' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/reserved/i);
    expect(getConfig().roots.map((root) => root.name)).toEqual(['project', 'skills-folder']);
  });

  it('moves live workspace bindings with a root rename and drops them with root removal', async () => {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      roots: [{ name: 'project', path: 'C:\\Users\\example\\project' }]
    });
    setWorkspaceFor('chat:conv-root-change', {
      virtual: '/project/src',
      real: 'C:\\Users\\example\\project\\src'
    });

    const renamed = await renameRoot({ name: 'project', newName: 'repo' });
    expect(renamed.ok, renamed.error).toBe(true);
    expect(workspaceEntries()).toEqual([{ key: 'chat:conv-root-change', virtual: '/repo/src' }]);

    const removed = await removeRoot({ name: 'repo' });
    expect(removed.ok, removed.error).toBe(true);
    expect(workspaceEntries()).toEqual([]);
  });

  it('refuses stale root rename/remove requests instead of reporting a no-op as success', async () => {
    await saveConfig({ ...defaultConfig(), roots: [] });
    const renamed = await renameRoot({ name: 'gone', newName: 'other' });
    expect(renamed.ok).toBe(false);
    expect(renamed.error).toMatch(/not an approved folder/i);
    const removed = await removeRoot({ name: 'gone' });
    expect(removed.ok).toBe(false);
    expect(removed.error).toMatch(/not an approved folder/i);
  });
});

// Exercise the real IPC policy for both Settings buttons and authored chat links.
describe('every link the window offers', () => {
  it('is one link:open will actually open', async () => {
    const html = await readRendererMarkup(process.cwd());

    const offered = [...html.matchAll(/data-link="([^"]+)"/g)].map((match) => match[1]!);
    expect(offered.length, 'the markup offers no links at all — has data-link been renamed?').toBeGreaterThan(0);

    for (const url of offered) expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
  });

  it('opens the OpenRouter key page the goal loop sends people to', async () => {
    const open = handlers.get('link:open')!;
    expect(await open(null, { url: 'https://openrouter.ai/settings/keys' })).toEqual({ ok: true, data: true });
    expect(await open(null, { url: 'https://example.com/reference#section' })).toEqual({ ok: true, data: true });
  });

  it.each(['https://example.com/path?q=hello', 'http://localhost:3000/', 'mailto:person@example.com?subject=Hello'])(
    'opens an authored external link: %s', async url => {
      expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
    }
  );
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/secret', 'ms-settings:privacy',
    'x-apple.systempreferences:unapproved', 'https://user:password@example.com/', '//example.com/',
    'https:example.com', 'https://example.com/\nfoo', 'mailto:a@example.com?body=%0Ainjected', 'https://example.com/\\path'])(
    'refuses unsafe authored link: %s', async url => {
    const before = vi.mocked(shell.openExternal).mock.calls.length;
    const refused = (await handlers.get('link:open')!(null, { url })) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/not allowed/i);
    expect(vi.mocked(shell.openExternal).mock.calls.length).toBe(before);
  });

  it("opens supported provider pages in the NEURAFLOK browser and honors the external override", async () => {
    const original = getConfig();
    const url = 'https://chat.deepseek.com/';
    try {
      await saveConfig({ ...original, ui: { ...original.ui, chatBrowser: 'integrated' } });
      vi.mocked(openInPreferredBrowser).mockClear();
      vi.mocked(shell.openExternal).mockClear();
      expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
      expect(openInPreferredBrowser).toHaveBeenCalledWith(url, { reveal: true });
      expect(shell.openExternal).not.toHaveBeenCalled();
      // "Open in another browser" beside it: the same page in the system's own browser.
      vi.mocked(openInPreferredBrowser).mockClear();
      expect(await handlers.get('link:open')!(null, { url, external: true })).toEqual({ ok: true, data: true });
      expect(shell.openExternal).toHaveBeenLastCalledWith(url);
      expect(openInPreferredBrowser).not.toHaveBeenCalled();
      // API key settings stay in the system browser.
      await handlers.get('link:open')!(null, { url: 'https://openrouter.ai/settings/keys' });
      expect(shell.openExternal).toHaveBeenCalledWith('https://openrouter.ai/settings/keys');

      await saveConfig({ ...original, ui: { ...original.ui, chatBrowser: 'chrome' } });
      vi.mocked(openInPreferredBrowser).mockClear();
      vi.mocked(shell.openExternal).mockClear();
      expect(await handlers.get('link:open')!(null, { url })).toEqual({ ok: true, data: true });
      expect(openInPreferredBrowser).toHaveBeenCalledWith(url, { reveal: true });
      expect(shell.openExternal).not.toHaveBeenCalled();
    } finally {
      await saveConfig(original);
    }
  });

  it('opens the selected web provider in the app-owned profile', async () => {
    const browser = { openProvider: vi.fn(async () => undefined) };
    vi.mocked(loadIntegratedBrowser).mockResolvedValue(browser as any);
    vi.mocked(openInPreferredBrowser).mockClear();
    await startBridge();
    expect(await handlers.get('web-provider:open')!(null, { provider: 'deepseek' })).toEqual({ ok: true, data: true });
    expect(loadIntegratedBrowser).toHaveBeenCalledOnce();
    expect(browser.openProvider).toHaveBeenCalledWith('deepseek', { reveal: true, hideAfterSignIn: true });
    expect(openInPreferredBrowser).not.toHaveBeenCalled();
  });

  it('serializes non-Error throws into a real IPC error string', async () => {
    vi.mocked(shell.openExternal).mockRejectedValueOnce('Windows shell refused the request');
    const reply = (await handlers.get('link:open')!(null, {
      url: 'https://openrouter.ai/settings/keys'
    })) as { ok: boolean; error?: string };
    expect(reply).toEqual({ ok: false, error: 'Windows shell refused the request' });
  });
});

// The Install button, from the renderer's side of the wire. There is one thing to be sure of here: a press with nothing staged must not quit the app. The button exists because this app is closed to the tray and a quit is rare and deliberate, so a press that closed the window and installed nothing would be worse than no button at all.
describe('installing a downloaded update on request', () => {
  it('refuses, and does not quit, when nothing has been downloaded', async () => {
    const before = ipcFixture.quitToInstallCalls;
    const reply = (await handlers.get('update:install')!(null, undefined)) as { ok: boolean; error: string };
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no downloaded update/i);
    expect(ipcFixture.quitToInstallCalls).toBe(before);
  });
});

// OpenRouter publishes twelve ids that begin with `~` — `~deepseek/deepseek-v4-flash-latest` and its siblings — and they are aliases that always resolve to the newest model in a family. The picker lists them because the catalogue does, so a validator that refused the `~` made the one kind of entry most worth choosing the one kind that could not be saved: the click reported an error and the model in use silently stayed where it was.
describe('the goal model id', () => {
  const withModel = (model: string) => ({ ...settings({ record: false, multiAgent: false }), goal: { ...defaultConfig().goal, model } });

  it('accepts the family aliases OpenRouter marks with a tilde', async () => {
    const reply = await save(withModel('~z-ai/glm-latest'));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe('~z-ai/glm-latest');
  });

  it('still accepts an ordinary pinned id, with or without a variant suffix', async () => {
    expect((await save(withModel('deepseek/deepseek-v4-flash-0731'))).ok).toBe(true);
    expect((await save(withModel('openai/gpt-5.2-mini:nitro'))).ok).toBe(true);
  });

  it('refuses something that is not a model id at all', async () => {
    const reply = await save(withModel('not a model'));
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/vendor\/model/);
  });

  // The shipped default is one of those aliases, so it has to survive its own validator.
  it('accepts the default this app ships with', async () => {
    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.model).toBe(defaultConfig().goal.model);
  });

  it('accepts a bare endpoint id while custom and stores the base URL verbatim', async () => {
    const patch = {
      ...settings({ record: false, multiAgent: false }),
      providers: { api: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1/' } },
      goal: {
        ...defaultConfig().goal,
        model: 'llama3.1'
      }
    };
    const reply = await save(patch);
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().providers.api).toEqual({ kind: 'custom', baseUrl: 'http://localhost:11434/v1/' });
    expect(getConfig().goal.model).toBe('llama3.1');
  });

  it('still refuses a bare id while on OpenRouter, and an unknown provider kind', async () => {
    const custom = {
      ...settings({ record: false, multiAgent: false }),
      providers: { api: { kind: 'custom' as const, baseUrl: 'http://localhost:11434/v1' } },
      goal: {
        ...defaultConfig().goal,
        model: 'llama3.1'
      }
    };
    // Same model, OpenRouter provider: the vendor/model shape still applies.
    const openrouter = {
      ...custom,
      providers: { api: { kind: 'openrouter' as const, baseUrl: '' } }
    };
    expect((await save(openrouter)).ok).toBe(false);
    const unknown = {
      ...custom,
      providers: { api: { kind: 'own' as never, baseUrl: '' } }
    };
    expect((await save(unknown)).ok).toBe(false);
  });
});

describe('the custom provider key slot', () => {
  const storeSecret = (payload: unknown): Promise<any> =>
    handlers.get('secret:set')!(null, payload) as Promise<any>;

  it('stores a custom key in its own slot and refuses an unnamed one', async () => {
    const prior = await handlers.get('state:get')!(null, undefined) as any;
    const stored = await storeSecret({ value: 'sk-custom-1', key: 'customProviderApiKey' });
    expect(stored.ok, stored.error).toBe(true);
    expect(stored.data.hasCustomProviderKey).toBe(true);
    // The OpenRouter slot is untouched: naming is exact, never a shared bucket.
    expect(stored.data.hasGoalKey).toBe(prior.data.hasGoalKey);
    const cleared = await storeSecret({ value: '', key: 'customProviderApiKey' });
    expect(cleared.ok).toBe(true);
    expect(cleared.data.hasCustomProviderKey).toBe(false);
    const refused = await storeSecret({ value: 'x', key: 'nobodyDefinedThis' });
    expect(refused.ok).toBe(false);
  });
});

describe('the editable goal system prompt', () => {
  it('stores a deliberate custom prompt', async () => {
    const prompt = 'Only continue explicit missing work. Return NO_REPLY when ChatGPT says done.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, prompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.prompt).toBe(prompt);
  });

  it('refuses blank and unbounded prompts at the renderer boundary', async () => {
    const base = settings({ record: false, multiAgent: false });
    expect((await save({ ...base, goal: { ...base.goal, prompt: '   ' } })).ok).toBe(false);
    expect((await save({ ...base, goal: { ...base.goal, prompt: 'x'.repeat(20_001) } })).ok).toBe(false);
  });

  // The driver prompt crosses the same boundary as the gate, so it needs the same guards. It used to be a source constant no renderer could reach; now that it is editable, a blank or unbounded value has to be refused here rather than reaching the goal loop.
  it('stores the goal driver prompt and holds it to the same bounds', async () => {
    const objectivePrompt = 'Drive to the goal. NO_REPLY once it is reached.';
    const base = settings({ record: false, multiAgent: false });
    const reply = await save({ ...base, goal: { ...base.goal, objectivePrompt } });
    expect(reply.ok, reply.error).toBe(true);
    expect(getConfig().goal.objectivePrompt).toBe(objectivePrompt);

    expect((await save({ ...base, goal: { ...base.goal, objectivePrompt: '   ' } })).ok).toBe(false);
    expect(
      (await save({ ...base, goal: { ...base.goal, objectivePrompt: 'x'.repeat(20_001) } })).ok
    ).toBe(false);
  });
});

