import { mountChat, projectSidebarFixture, settle } from './context.js';
import { emptyWebProviderPresence } from "../../contracts/web-providers.js";
import { expect, it, vi } from 'vitest';

it('keeps project keyboard focus across activity repaint without taking composer focus or reloading on disclosure', async () => {
  const { project, session } = projectSidebarFixture();
  const listSessions = vi.fn(async () => ({ ok: true, data: { sessions: [session], activeId: null, pressure: [], blocked: [] } }));
  const mounted = await mountChat({}, [], {
    listProjects: async () => ({ ok: true, data: [project] }), listSessions
  });
  const doc = mounted.window.document;
  const heading = () => doc.querySelector<HTMLElement>(`[data-project-id="${project.id}"] > summary`)!;
  await vi.waitFor(() => expect(heading()).not.toBeNull());
  await settle();
  const reads = listSessions.mock.calls.length;
  heading().focus(); heading().click();
  await settle();
  expect(listSessions).toHaveBeenCalledTimes(reads);
  expect(doc.activeElement).toBe(heading());
  mounted.push(structuredClone(mounted.state));
  expect(doc.activeElement).toBe(heading());
  const input = doc.getElementById('chatInput') as HTMLTextAreaElement;
  input.focus(); input.value = 'Keep typing here';
  mounted.push(structuredClone(mounted.state));
  expect(doc.activeElement).toBe(input);
  expect(input.value).toBe('Keep typing here');
  const { chatVisible } = await import('../../frontend/features/chat/chat.js');
  chatVisible(false); chatVisible(true);
  await settle();
  expect(listSessions).toHaveBeenCalledTimes(reads + 1);
});

it('saves provider selection and only enables signed-in sessions', async () => {
  const openWebProvider = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({}, [], { openWebProvider });
  const doc = mounted.window.document;
  const active = doc.getElementById('webProvider') as HTMLSelectElement;
  const qwenUse = doc.querySelector<HTMLButtonElement>('[data-select-provider="qwen"]')!;
  expect(qwenUse.disabled).toBe(true);

  const seen = structuredClone(mounted.state);
  seen.bridge = {
    ...seen.bridge,
    present: true,
    paired: true,
    webProviders: {
      ...emptyWebProviderPresence(),
      deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() },
      qwen: { open: true, signedIn: false, tabId: 22, lastSeenAt: Date.now() }
    }
  };
  mounted.push(seen);
  expect(doc.getElementById('providerStatusDeepseek')!.textContent).toBe('Session active');
  expect(doc.getElementById('providerStatusQwen')!.textContent).toBe('Sign in required');
  expect(qwenUse.disabled).toBe(true);
  expect(active.querySelector<HTMLOptionElement>('option[value="kimi"]')!.disabled).toBe(true);

  const signedIn = structuredClone(seen);
  signedIn.bridge.webProviders.qwen = { open: true, signedIn: true, tabId: 22, lastSeenAt: Date.now() };
  mounted.push(signedIn);
  // Keep the fake IPC reply aligned with the latest live bridge snapshot after saving the provider.
  mounted.state.bridge = signedIn.bridge;
  expect(qwenUse.disabled).toBe(false);
  qwenUse.click();
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.ui?.webProvider).toBe('qwen'));
  expect(doc.getElementById('chatModelPickerName')!.textContent).toBe('Qwen Web');
  expect(doc.getElementById('executorQuickSelect')).toBeNull();
  expect(doc.getElementById('providerQuickSelect')).toBeNull();

  const qwenModel = doc.querySelector<HTMLButtonElement>('[data-model-pick-web="qwen"]')!;
  expect(qwenModel.disabled).toBe(false);
  qwenModel.click();
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.ui?.chatExecutor).toBe('web'));

  doc.querySelector<HTMLButtonElement>('[data-open-provider="glm"]')!.click();
  await vi.waitFor(() => expect(openWebProvider).toHaveBeenCalledWith('glm', 'connect'));

});

it('disconnects a signed-in web model from the chat picker', async () => {
  let disconnectedState: any = null;
  const disconnectWebProvider = vi.fn(async () => ({ ok: true, data: disconnectedState }));
  const mounted = await mountChat({}, [], { disconnectWebProvider });
  const doc = mounted.window.document;
  const connected = structuredClone(mounted.state);
  connected.bridge.webProviders.deepseek = { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() };
  const disconnected = structuredClone(connected);
  disconnected.bridge.webProviders.deepseek = { open: false, signedIn: false, tabId: null, lastSeenAt: Date.now() };
  disconnectedState = disconnected;
  mounted.push(connected);

  const confirmDisconnect = vi.fn(() => true);
  mounted.window.confirm = confirmDisconnect;
  const button = doc.querySelector<HTMLButtonElement>('[data-model-disconnect="deepseek"]')!;
  expect(button.textContent).toBe('Disconnect');
  button.click();
  await vi.waitFor(() => expect(disconnectWebProvider).toHaveBeenCalledWith('deepseek'));
  expect(confirmDisconnect).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(doc.getElementById('providerStatusDeepseek')!.textContent).toBe('Not detected'));
  expect(doc.querySelector('[data-model-disconnect="deepseek"]')).toBeNull();
});

it('shows one configured model picker and selects its saved provider model', async () => {
  const mounted = await mountChat({ hasGoalKey: true });
  const doc = mounted.window.document;
  const picker = doc.getElementById('chatModelPicker') as HTMLDetailsElement;
  expect(doc.getElementById('chatModelPickerName')!.textContent).toBe('DeepSeek Web');
  expect(doc.querySelector('[data-model-pick-web="deepseek"] .model-picker-provider-mark')).not.toBeNull();
  const apiModel = doc.querySelector<HTMLButtonElement>('[data-model-pick-api="true"]')!;
  expect(apiModel.disabled).toBe(false);
  expect(apiModel.textContent).toContain('OpenRouter');
  apiModel.click();
  await vi.waitFor(() => expect(mounted.calls.at(-1)?.ui?.chatExecutor).toBe('api'), { timeout: 5000 });
  expect(picker.open).toBe(false);
});

it('keeps global connection controls in a compact sidebar popover', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const now = Date.now();
  const connected = structuredClone(mounted.state);
  connected.bridge = { ...connected.bridge, running: true, port: 8765, paired: true, present: true,
    lastSeenAt: now - 1_000, extensionVersion: connected.update.current,
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: now } } };
  mounted.push(connected);

  const trigger = doc.getElementById('sidebarConnection') as HTMLButtonElement;
  const popover = doc.getElementById('connectionPopover') as HTMLElement;
  expect(doc.querySelector('#chatTitle')!.closest('header')!.querySelector('#connectBtn')).toBeNull();
  expect(trigger.closest('.app-topbar-connection')).not.toBeNull();
  // Connected: the quiet dot alone, with the label column collapsed.
  expect(trigger.classList.contains('has-label')).toBe(false);
  expect(trigger.getAttribute('aria-label')).toBe('System active · DeepSeek');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');

  Object.defineProperty(mounted.window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(mounted.window, 'innerHeight', { configurable: true, value: 760 });
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
    x: 200, y: 700, left: 200, top: 700, right: 236, bottom: 736, width: 36, height: 36,
    toJSON: () => ({})
  } as DOMRect);
  vi.spyOn(popover, 'getBoundingClientRect').mockReturnValue({ width: 160 } as DOMRect);
  trigger.click();
  expect(popover.hidden).toBe(false);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(popover.style.left).toBe('138px');
  expect(popover.parentElement).toBe(doc.body);
  expect(doc.getElementById('connectionPopoverSettings')).toBeNull();
  trigger.click(); trigger.click();
  expect(popover.hidden).toBe(false);
  expect(popover.querySelector('details')).toBeNull();
  expect(doc.getElementById('connectionPopoverTitle')!.textContent).toBe('System active · DeepSeek');
  expect(doc.getElementById('connectionPopoverBrowser')!.textContent).toBe('Connected');
  expect(doc.getElementById('connectionPopoverBrowser')!.parentElement!.title).toMatch(/Seen/i);
  expect(doc.getElementById('connectionPopoverBrowser')!.classList.contains('sr-only')).toBe(true);
  expect(doc.getElementById('connectionPopoverBrowser')!.parentElement!.dataset.tone).toBe('ok');
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.textContent).toBe('Session active');
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.parentElement!.querySelector('span')!.textContent).toBe('DeepSeek');
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.classList.contains('sr-only')).toBe(true);
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.parentElement!.dataset.tone).toBe('ok');
  expect(doc.getElementById('connectionPopoverVerified')).toBeNull();
  expect(doc.getElementById('connectionPopoverTitle')!.title).toBe('System active · DeepSeek');
  expect(doc.getElementById('connectionPipeline')).toBeNull();
  expect(doc.getElementById('connectionPopoverExtension')).toBeNull();
  expect(doc.getElementById('connectionPopoverToggle')).toBeNull();

  doc.body.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true }));
  expect(popover.hidden).toBe(true);
});

it('shows DeepSeek in Connection from the companion web-chat sighting', async () => {
  const now = Date.now();
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  mounted.push({
    ...mounted.state,
    bridge: {
      ...mounted.state.bridge,
      present: true,
      lastSeenAt: now,
      webProviders: {
        ...emptyWebProviderPresence(),
        deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: now }
      }
    }
  });
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.textContent).toBe('Session active');
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.parentElement!.dataset.tone).toBe('ok');
  expect(doc.getElementById('openDeepseekTunnel')).toBeNull();
  expect(doc.getElementById('openBrowserProvider')).not.toBeNull();
});

it('shows a checking state for an open provider tab without implying the session is ready', async () => {
  const now = Date.now();
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const next = structuredClone(mounted.state);
  next.config.ui = { ...next.config.ui, chatExecutor: 'web' };
  next.bridge = {
    ...next.bridge,
    paired: true,
    present: true,
    lastSeenAt: now,
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: null, tabId: 21, lastSeenAt: now } }
  };
  mounted.push(next);
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.textContent).toBe('Checking');
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.parentElement!.dataset.tone).toBe('ok');
  expect(doc.getElementById('sidebarConnection')!.classList.contains('is-busy')).toBe(false);
  expect(doc.getElementById('sidebarConnectionLabel')!.textContent).toBe('DeepSeek · Checking');
});

it('opens provider connection details from the capsule without launching the MCP connector', async () => {
  const now = Date.now();
  const mounted = await mountChat({ hasApiKey: false });
  const doc = mounted.window.document;
  const next = structuredClone(mounted.state);
  next.config.roots = [];
  next.config.ui = { ...next.config.ui, chatExecutor: 'web' };
  next.bridge = {
    ...next.bridge,
    paired: true,
    present: true,
    lastSeenAt: now,
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: now } }
  };
  mounted.push(next);
  const popover = doc.getElementById('connectionPopover')!;
  expect(popover.hidden).toBe(true);
  expect(doc.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('chat');
  doc.getElementById('sidebarConnection')!.click();
  expect(popover.hidden).toBe(false);
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.textContent).toBe('Session active');
  expect(doc.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('chat');
});

it('opens a selected provider from the internal browser setup step', async () => {
  const opened: Array<[string, string]> = [];
  const mounted = await mountChat({}, [], {
    openWebProvider: (provider: string, mode: string) => {
      opened.push([provider, mode]);
      return Promise.resolve({ ok: true, data: true });
    }
  });
  const doc = mounted.window.document;
  const ready = structuredClone(mounted.state);
  ready.bridge = {
    ...ready.bridge,
    running: true,
    paired: true,
    present: true,
    integratedExtension: { present: true },
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() } }
  };
  mounted.push(ready);
  expect(doc.querySelector('[data-step="browser"]')!.classList.contains('is-done')).toBe(true);
  expect((doc.getElementById('browserLocationStage') as HTMLElement).hidden).toBe(false);

  const provider = doc.getElementById('browserWebProvider') as HTMLSelectElement;
  provider.value = 'kimi';
  provider.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
  doc.getElementById('openBrowserProvider')!.click();
  expect(opened).toEqual([['kimi', 'connect']]);
});

it('keeps the provider capsule tied to the signed-in page', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  mounted.push(structuredClone(mounted.state));
  expect(doc.getElementById('sidebarConnectionLabel')!.textContent).toBe('Extension offline');
  expect(doc.getElementById('sidebarConnection')!.classList.contains('is-connected')).toBe(false);

  const signedIn = structuredClone(mounted.state);
  signedIn.config.ui = { ...signedIn.config.ui, chatExecutor: 'web', webProvider: 'deepseek' };
  signedIn.bridge = { ...signedIn.bridge, present: true, paired: true,
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() } } };
  mounted.push(signedIn);
  expect(doc.getElementById('sidebarConnection')!.getAttribute('aria-label')).toBe('System active · DeepSeek');
  expect(doc.getElementById('sidebarConnection')!.classList.contains('is-connected')).toBe(true);
});

it('refreshes the visible connection capsule when provider presence changes between app snapshots', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  const next = structuredClone(mounted.state);
  next.config.ui = { ...next.config.ui, chatExecutor: 'web', webProvider: 'deepseek' };
  next.bridge = {
    ...next.bridge,
    present: true,
    paired: true,
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: false, tabId: 21, lastSeenAt: Date.now() } }
  };
  mounted.push(next);
  const capsule = doc.getElementById('sidebarConnection')!;
  const label = doc.getElementById('sidebarConnectionLabel')!;
  expect(label.textContent).toBe('DeepSeek · Sign in');

  next.bridge.webProviders.deepseek = { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() };
  await vi.waitFor(() => expect(capsule.getAttribute('aria-label')).toBe('System active · DeepSeek'));
  expect(capsule.classList.contains('is-connected')).toBe(true);
  expect(label.textContent).toBe('');
});

it('keeps the Settings footer action visible while settings are open', async () => {
  const mounted = await mountChat({ hasApiKey: true });
  const doc = mounted.window.document;
  const settings = doc.getElementById('workspaceSettings') as HTMLButtonElement;
  const dialog = doc.getElementById('quickSettingsDialog') as HTMLDialogElement;

  expect(settings.hidden).toBe(false);
  settings.click();
  expect(settings.hidden).toBe(false);
  expect(settings.classList.contains('is-sel')).toBe(true);
  expect(dialog.open).toBe(true);
  (doc.querySelector('[data-settings-go="home"]') as HTMLButtonElement).click();
  expect(settings.hidden).toBe(false);
  expect(settings.classList.contains('is-sel')).toBe(true);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  expect(settings.hidden).toBe(false);
  expect(settings.classList.contains('is-sel')).toBe(false);
});

it('shows provider status in the connection popover and opens the selected page', async () => {
  const openWebProvider = vi.fn(async () => ({ ok: true, data: true }));
  const mounted = await mountChat({ hasApiKey: true }, [], {
    openWebProvider
  });
  const doc = mounted.window.document;
  const popover = doc.getElementById('connectionPopover')!;
  const trigger = doc.getElementById('sidebarConnection') as HTMLButtonElement;
  expect(doc.getElementById('sidebarConnectionLabel')!.textContent).toBe('Extension offline');
  trigger.click();
  expect(popover.hidden).toBe(false);
  expect(popover.querySelector('.connection-popover-head')!.textContent?.trim()).toBe('Extension offline');
  expect(doc.getElementById('connectionPopoverToggle')).toBeNull();
  expect(doc.getElementById('connectionPopoverDeepseek')!.textContent).toContain('Sign in to DeepSeek');
  (doc.getElementById('connectionPopoverDeepseek') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(openWebProvider).toHaveBeenCalledWith('deepseek', 'connect'));

  const connected = structuredClone(mounted.state);
  connected.bridge = { ...connected.bridge, present: true, paired: true,
    webProviders: { ...emptyWebProviderPresence(), deepseek: { open: true, signedIn: true, tabId: 21, lastSeenAt: Date.now() } } };
  mounted.push(connected);
  expect(popover.querySelector('.connection-popover-head')!.textContent?.trim()).toBe('System active · DeepSeek');
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.textContent).toBe('Session active');
  expect(doc.getElementById('connectionPopoverDeepseekStatus')!.parentElement!.dataset.tone).toBe('ok');

  trigger.dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  doc.dispatchEvent(new mounted.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(popover.hidden).toBe(true);
  expect(doc.activeElement).toBe(trigger);
});

it('keeps only current provider setup controls in the setup view', async () => {
  const mounted = await mountChat();
  const doc = mounted.window.document;
  expect(doc.querySelector('[data-step="browser"]')).not.toBeNull();
  expect(doc.getElementById('openBrowserProvider')).not.toBeNull();
  expect(doc.getElementById('browserWebProvider')).not.toBeNull();
  for (const id of ['setupProfile', 'setupProfileDialog', 'setupChatExecutor', 'tunnelKind', 'binaryPath', 'openDeepseekTunnel']) {
    expect(doc.getElementById(id)).toBeNull();
  }
});

it('asks whether an update came out when Settings open, not on every page inside them', async () => {
  const refreshUpdate = vi.fn(async () => ({ ok: true, data: true }));
  const { window: w } = await mountChat({}, [], { refreshUpdate });
  const doc = w.document;
  expect(refreshUpdate).not.toHaveBeenCalled();
  (doc.getElementById('workspaceSettings') as HTMLButtonElement).click();
  (doc.querySelector('[data-settings-go="home"]') as HTMLButtonElement).click();
  expect(refreshUpdate).toHaveBeenCalledTimes(1);
  for (const tab of ['general', 'activity', 'usage']) (doc.querySelector(`#tabs button[data-tab="${tab}"]`) as HTMLButtonElement).click();
  expect(refreshUpdate).toHaveBeenCalledTimes(1);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  (doc.getElementById('workspaceSettings') as HTMLButtonElement).click();
  (doc.querySelector('[data-settings-go="home"]') as HTMLButtonElement).click();
  expect(refreshUpdate).toHaveBeenCalledTimes(2);
});

it('searches every settings page from the sidebar and opens the setting it finds', async () => {
  const { window: w } = await mountChat();
  const doc = w.document;
  const field = doc.getElementById('settingsFind') as HTMLInputElement;
  const box = doc.getElementById('settingsFindBox')!, pages = doc.getElementById('tabs')!, results = doc.getElementById('settingsFindResults')!;
  const frame = () => new Promise(resolve => w.requestAnimationFrame(resolve));
  const type = (text: string) => { field.value = text; field.dispatchEvent(new w.Event('input')); };
  const rows = () => [...results.querySelectorAll<HTMLButtonElement>('.search-result')];
  expect(box.hidden).toBe(true);
  (doc.getElementById('workspaceSettings') as HTMLButtonElement).click();
  (doc.querySelector('[data-settings-go="home"]') as HTMLButtonElement).click();
  expect(box.hidden).toBe(false);
  // While the field holds a query, its results take the page list's place.
  type('privacy screenshots');
  expect([pages.hidden, results.hidden]).toEqual([true, false]);
  expect(rows().map(row => [row.querySelector('b')!.textContent, row.querySelector('.search-snippet')!.textContent])).toEqual([['Privacy screenshots', 'General › Privacy']]);
  expect(rows()[0]!.querySelectorAll('mark')).toHaveLength(2);
  rows()[0]!.click(); await frame();
  // Its page opens with the list back, the setting marked and its control focused.
  expect(doc.querySelector('[data-panel="general"]')!.classList.contains('is-active')).toBe(true);
  expect([field.value, pages.hidden, results.hidden]).toEqual(['', false, true]);
  expect(doc.getElementById('privacyScreenshots')!.closest('.setting')!.classList.contains('is-found')).toBe(true);
  expect(doc.activeElement).toBe(doc.getElementById('privacyScreenshots'));
  // Enter opens the best match, here on Agents & automation.
  type('default web provider');
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await frame();
  expect(doc.querySelector('[data-panel="chat"]')!.classList.contains('is-active')).toBe(true);
  expect(doc.querySelector<HTMLElement>('[data-view="settings"]')!.hidden).toBe(false);
  expect(doc.activeElement).toBe(doc.getElementById('webProvider'));
  // Nothing found says so; Escape empties the field and brings the list back.
  type('no-such-setting-123');
  expect(rows()).toHaveLength(0);
  expect(results.textContent).toContain('No settings match your search.');
  field.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect([field.value, pages.hidden, results.hidden]).toEqual(['', false, true]);
  // Ctrl+F (⌘F on macOS) reaches the field only while Settings are open; leaving them hides it.
  const mac = /^Mac/.test(w.navigator.platform);
  const find = () => { const event = new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }); doc.body.dispatchEvent(event); return event.defaultPrevented; };
  (doc.getElementById('chatBody') as HTMLElement).focus();
  expect(find()).toBe(true);
  expect(doc.activeElement).toBe(field);
  (doc.getElementById('backToChat') as HTMLButtonElement).click();
  expect(box.hidden).toBe(true);
  expect(find()).toBe(false);
});
