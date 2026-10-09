import { mountChat, settle } from './context.js';
import { BROWSER_READ_TOOLS, BROWSER_WRITE_TOOLS } from "../../contracts/browser/control-policy.js";
import { expect, it, vi } from 'vitest';

it('offers all six bridge ports, saves numbers, and distinguishes saved choice from the override listener', async () => {
  const mounted = await mountChat(); const w = mounted.window;
  const select = w.document.getElementById('browserBridgePort') as HTMLSelectElement;
  expect([...select.options].map(option => option.value)).toEqual(['auto', '8765', '8766', '8767', '8768', '8769']);
  expect(select.value).toBe('auto');
  for (const value of ['8765', '8766', '8767', '8768', '8769', 'auto']) {
    select.value = value; select.dispatchEvent(new w.Event('change', { bubbles: true }));
    await settle();
    expect(mounted.calls.at(-1).ui.browserBridgePort).toBe(value === 'auto' ? 'auto' : Number(value));
  }
  mounted.push({ ...mounted.state, bridge: { ...mounted.state.bridge, port: 12345, portOverridden: true } });
  expect(select.disabled).toBe(true); expect(select.value).toBe('auto');
  expect(w.document.getElementById('browserBridgePortHint')!.textContent).toContain('NEURAFLOK_BRIDGE_PORTS');
});

it('shows startup bind errors in the existing Setup status and clears them after recovery', async () => {
  const mounted = await mountChat({ bridge: { running: false, error: 'port 8767: EADDRINUSE' } });
  const status = mounted.window.document.getElementById('bridgeState')!;
  expect(status.textContent).toContain('Browser bridge could not start: port 8767: EADDRINUSE');
  mounted.push({ ...mounted.state, bridge: { running: true, port: 8768, paired: false, present: false, error: null } });
  expect(status.textContent).toContain('8768'); expect(status.textContent).not.toContain('EADDRINUSE');
});

it('restores a rejected focused port and prevents an unrelated queued save from retrying it', async () => {
  let release!: (result: any) => void; const calls: any[] = [];
  const mounted = await mountChat({}, [], { saveSettings: (patch: any, base: any) => {
    calls.push({ patch: structuredClone(patch), base: structuredClone(base) });
    if (calls.length === 1) return new Promise(resolve => { release = resolve; });
    // Match main's three-way port merge: an inherited failed value is not an explicit edit.
    const browserBridgePort = patch.ui.browserBridgePort === base.ui.browserBridgePort ? 'auto' : patch.ui.browserBridgePort;
    return Promise.resolve({ ok: true, data: { ...mounted.state,
      config: { ...mounted.state.config, ...patch, ui: { ...patch.ui, browserBridgePort } } } });
  } });
  const w = mounted.window; const select = w.document.getElementById('browserBridgePort') as HTMLSelectElement;
  select.focus(); select.value = '8767'; select.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  const background = w.document.getElementById('backgroundChats') as HTMLInputElement;
  background.checked = true; background.dispatchEvent(new w.Event('change', { bubbles: true }));
  release({ ok: false, error: 'Port 8767: EADDRINUSE' });
  await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 5000 }); await settle();
  expect(calls[1].patch.ui.browserBridgePort).toBe(calls[1].base.ui.browserBridgePort);
  expect(select.value).toBe('auto'); expect(background.checked).toBe(true);
});

it('keeps the removed external browser preference internal to the bundled browser', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const browser = w.document.getElementById('chatBrowser') as HTMLSelectElement;
  expect(browser.type).toBe('hidden');
  expect(browser.value).toBe('integrated');
  expect(mounted.calls).toHaveLength(0);
});

it('saves Auto-select Skills from Settings and restores it on state push', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const toggle = w.document.getElementById('autoSelectSkills') as HTMLInputElement;
  expect(toggle).not.toBeNull();
  expect(toggle.checked).toBe(false);
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].ui.autoSelectSkills).toBe(true);
  mounted.push({ ...mounted.state, config: { ...mounted.state.config, ui: { ...mounted.state.config.ui, autoSelectSkills: false } } });
  expect(toggle.checked).toBe(false);
});

it('saves and restores the global worker admission cap from Settings', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const globalWorkers = w.document.getElementById('globalMaWorkers') as HTMLInputElement;
  expect(globalWorkers.value).toBe('0');

  globalWorkers.value = '5';
  globalWorkers.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].multiAgent.globalMaxWorkers).toBe(5);

  mounted.push({
    ...mounted.state,
    config: {
      ...mounted.state.config,
      multiAgent: { ...mounted.state.config.multiAgent, globalMaxWorkers: 7 }
    }
  });
  expect(globalWorkers.value).toBe('7');
});

it('loads, explains and saves both command policy modes without losing rules', async () => {
  const mounted = await mountChat();
  const w = mounted.window;
  const rules = w.document.getElementById('commandAllowlistRules') as HTMLTextAreaElement;
  const enabled = w.document.getElementById('commandAllowlistEnabled') as HTMLInputElement;
  const allow = w.document.getElementById('commandPolicyAllow') as HTMLButtonElement;
  const deny = w.document.getElementById('commandPolicyDeny') as HTMLButtonElement;
  const description = w.document.getElementById('commandPolicyDescription')!;
  const label = w.document.getElementById('commandPolicyRulesLabel')!;
  const error = w.document.getElementById('commandAllowlistError')!;

  mounted.state.config.commandAllowlist = { enabled: false, mode: 'deny', rules: ['dotnet *'] };
  mounted.push(structuredClone(mounted.state));
  expect(deny.getAttribute('aria-checked')).toBe('true');
  expect(rules.value).toBe('dotnet *');
  expect(description.textContent).toContain('may not start');
  expect(label.textContent).toContain('Blocked commands');

  rules.value = 'git status; whoami';
  rules.dispatchEvent(new w.Event('input', { bubbles: true }));
  rules.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();
  expect(error.hidden).toBe(false);
  expect(error.textContent).toContain('Line 1');
  expect(mounted.calls).toHaveLength(0);

  rules.value = 'git status\ngit diff *';
  rules.dispatchEvent(new w.Event('input', { bubbles: true }));
  allow.click();
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(1));
  expect(mounted.calls[0].commandAllowlist).toEqual({ enabled: false, mode: 'allow', rules: ['git status', 'git diff *'] });
  expect(description.textContent).toContain('Only commands matching');
  expect(label.textContent).toContain('Allowed commands');

  deny.click();
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(2));
  expect(mounted.calls[1].commandAllowlist).toEqual({ enabled: false, mode: 'deny', rules: ['git status', 'git diff *'] });
  expect(rules.value).toBe('git status\ngit diff *');
  enabled.checked = true;
  enabled.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(mounted.calls).toHaveLength(3));
  expect(mounted.calls[2].commandAllowlist).toEqual({ enabled: true, mode: 'deny', rules: ['git status', 'git diff *'] });
  expect(error.hidden).toBe(true);
});

it('shows the current host Desktop tools without rebuilding permission controls on state pushes', async () => {
  const mounted = await mountChat({
    platform: { family: 'windows', name: 'Windows', desktopAutomation: true }
  });
  const doc = mounted.window.document;
  const names = () => Array.from(doc.querySelectorAll('[data-group="desktop"] .tool-names code'), node => node.textContent);
  const control = doc.querySelector<HTMLInputElement>('[data-cap="control"]')!;
  const windowsNames = [...BROWSER_READ_TOOLS, 'list_windows', 'get_window', 'list_apps', 'get_window_state', ...BROWSER_WRITE_TOOLS,
    'launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag',
    'perform_secondary_action', 'activate_window', 'read_clipboard', 'write_clipboard', 'exec'];
  expect(names()).toEqual(windowsNames);
  mounted.push({ ...mounted.state, platform: { family: 'macos', name: 'macOS', desktopAutomation: true } });
  expect(names()).toEqual([...BROWSER_READ_TOOLS, 'observe', ...BROWSER_WRITE_TOOLS, 'computer', 'exec']);
  expect(doc.querySelector('[data-cap="control"]')).toBe(control);
  mounted.push(mounted.state);
  expect(names()).toEqual(windowsNames);
  expect(mounted.calls).toHaveLength(0);
});

it('preserves native Desktop permissions when saving unrelated settings on Linux', async () => {
  const mounted = await mountChat({
    platform: { family: 'linux', name: 'Linux', desktopAutomation: false }
  });
  const w = mounted.window;

  const desktopGroup = w.document.querySelector<HTMLElement>('[data-group="desktop"]')!;
  expect(desktopGroup.hidden).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="control"]')!.disabled).toBe(false);
  expect(w.document.querySelector<HTMLInputElement>('[data-cap="clipboardWrite"]')!.disabled).toBe(true);

  const minimizeToTray = w.document.getElementById('minimizeToTray') as HTMLInputElement;
  minimizeToTray.checked = false;
  minimizeToTray.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle();

  expect(mounted.calls).toHaveLength(1);
  expect(mounted.calls[0].ui.minimizeToTray).toBe(false);
  expect(mounted.calls[0].capabilities).toMatchObject({
    screen: true,
    control: true,
    clipboardRead: true,
    clipboardWrite: true
  });
});

it('uses native menu-bar wording on macOS and omits legacy connector copy', async () => {
  const mounted = await mountChat({
    platform: { family: 'macos', name: 'macOS', desktopAutomation: true }
  });
  const doc = mounted.window.document;

  expect(doc.getElementById('backgroundRunningCopy')).toBeNull();
  expect(doc.getElementById('minimizeToTrayCopy')!.textContent).toBe('Hide the window to the menu bar when closed');
});
