import { domState, installDialog, TestResizeObserver } from './context.js';
import { readRendererMarkup } from "../../scripts/read-renderer-markup.cjs";
import { JSDOM } from 'jsdom';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from "../../contracts/automation/goal-prompts.js";
import { DEFAULT_HANDOFF_PROMPT } from "../../contracts/sessions/continuity-brief.js";
import { expect, it, vi } from 'vitest';

it('keeps an explicit provider model in worker settings across state updates', async () => {
  const html = await readRendererMarkup(process.cwd());
  domState.dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  installDialog(domState.dom.window);
  const w = domState.dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, { window: w, document: w.document, getComputedStyle: w.getComputedStyle.bind(w), ResizeObserver: TestResizeObserver, HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node,
    DocumentFragment: w.DocumentFragment, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLButtonElement: w.HTMLButtonElement });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};
  let stateListener: (state: any) => void = () => undefined;
  const state = {
    config: {
      roots: [{ name: 'repo', path: 'C:\\repo' }], readOnly: true,
      capabilities: { browse: true, search: true, read: true, metadata: true, create: false, edit: false, move: false, deleteFile: false,
        command: false, screen: false, control: false, clipboardRead: false, clipboardWrite: false },
      commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
      providers: { api: { kind: 'openrouter' as const, baseUrl: '' } },
      ui: { minimizeToTray: true, privacyScreenshots: false, theme: 'light' },
      sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
      compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
      multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true, defaultModel: 'qwen3-coder', defaultReasoning: 'high' },
      goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const, prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
        backend: 'web', loopBackend: 'web' }
    },
    hasApiKey: false, hasGoalKey: false,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.1.31', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../../frontend/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const value = (id: string) => (w.document.getElementById(id) as HTMLInputElement).value;
  const shown = () => ({ worker: value('workerModel') });
  expect(shown()).toEqual({ worker: 'qwen3-coder' });
  stateListener(structuredClone(state));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(shown()).toEqual({ worker: 'qwen3-coder' });
});

it('does not overwrite a focused dirty settings field on an unsolicited state push', async () => {
  const html = await readRendererMarkup(process.cwd());
  domState.dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  installDialog(domState.dom.window);
  const w = domState.dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, {
    window: w,
    navigator: w.navigator,
    document: w.document,
    getComputedStyle: w.getComputedStyle.bind(w),
    ResizeObserver: TestResizeObserver,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  let stateListener: (state: any) => void = () => undefined;
  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    providers: { api: { kind: 'openrouter' as const, baseUrl: '' } },
    ui: { minimizeToTray: true, privacyScreenshots: false, theme: 'light', webProvider: 'deepseek' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
    multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const state = {
    config: baseConfig,
    hasApiKey: false,
    hasGoalKey: false,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const api: any = new Proxy({
    getState: () => ok(state),
    getLog: () => ok([{ time: Date.UTC(2026, 9, 2, 15, 4, 5), level: 'info', message: 'usage overview sessions=1 rebuilt=1' }]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    onStateChanged: (fn: any) => { stateListener = fn; return () => undefined; },
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../../frontend/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const field = w.document.getElementById('webProvider') as HTMLSelectElement;
  expect(field.value).toBe('deepseek');
  field.focus();
  field.value = 'kimi';

  stateListener(structuredClone(state));

  expect(w.document.activeElement).toBe(field);
  expect(field.value).toBe('kimi');

  // Log lines already on screen follow a language change, not only the ones added after it.
  const clock = () => w.document.querySelector('#fullFeed time')!.textContent!;
  expect(clock()).toMatch(/AM|PM/);
  const { setLanguage } = await import('../../frontend/shared/i18n.js');
  setLanguage('de');
  expect(clock()).not.toMatch(/AM|PM/);
  setLanguage('en');

  const multiAgent = w.document.getElementById('homeMaEnabled') as HTMLInputElement;
  multiAgent.focus();
  multiAgent.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(multiAgent);
  expect(multiAgent.checked).toBe(true);

  const allowUnattributed = w.document.getElementById('allowUnattributedCalls') as HTMLInputElement;
  allowUnattributed.focus();
  allowUnattributed.checked = true;
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(allowUnattributed);
  expect(allowUnattributed.checked).toBe(true);

  // The settings sheet used to bypass the dirty-field guard used by Home. An unrelated status push therefore erased this value while the user was still typing it.
  const compactionThreshold = w.document.getElementById('autoCompactTokens') as HTMLInputElement;
  compactionThreshold.focus();
  compactionThreshold.value = '355000';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(compactionThreshold);
  expect(compactionThreshold.value).toBe('355000');

  compactionThreshold.blur();
  const updatedThreshold = structuredClone(state) as any;
  updatedThreshold.config.compaction.autoTokens = 320000;
  stateListener(updatedThreshold);
  expect(compactionThreshold.value).toBe('320000');

  // A value whose switch is off does nothing, so it must not look editable: the threshold follows automatic compaction, and the notice lead follows Session finish.
  const finishLead = w.document.getElementById('finishLeadMinutes') as HTMLSelectElement;
  expect(compactionThreshold.disabled).toBe(false);
  expect(finishLead.disabled).toBe(true);
  const switchedOver = structuredClone(updatedThreshold) as any;
  switchedOver.config.compaction.auto = false;
  switchedOver.config.ui.finishTool = true;
  stateListener(switchedOver);
  expect(compactionThreshold.disabled).toBe(true);
  expect(finishLead.disabled).toBe(false);
  stateListener(structuredClone(updatedThreshold));
  expect(compactionThreshold.disabled).toBe(false);
  expect(finishLead.disabled).toBe(true);

  const goalPrompt = w.document.getElementById('goalPrompt') as HTMLTextAreaElement;
  goalPrompt.focus();
  goalPrompt.value = 'USER IS STILL EDITING THIS PROMPT';
  stateListener(structuredClone(state));
  expect(w.document.activeElement).toBe(goalPrompt);
  expect(goalPrompt.value).toBe('USER IS STILL EDITING THIS PROMPT');

  // The displayed tool total follows the enabled permission declarations.
  const withTools = structuredClone(state) as any;
  stateListener(withTools);
  expect(w.document.getElementById('facts')!.textContent).toContain('Local tools3 total');
  expect(w.document.getElementById('facts')!.textContent).not.toContain('of 9');

  const withMissingMacAccess = structuredClone(withTools) as any;
  withMissingMacAccess.platform = { family: 'macos', name: 'macOS', desktopAutomation: true };
  withMissingMacAccess.config.readOnly = false;
  withMissingMacAccess.config.capabilities.screen = true;
  withMissingMacAccess.config.capabilities.control = true;
  withMissingMacAccess.desktopAccess = {
    screen: 'granted',
    accessibility: 'missing',
    checkedAt: 1,
    error: null
  };
  stateListener(withMissingMacAccess);
  const accessWarning = w.document.getElementById('desktopAccess')!;
  expect(accessWarning.hidden).toBe(false);
  expect(accessWarning.textContent).toContain('Accessibility: missing');
  expect(accessWarning.textContent).toContain('live checks from the NEURAFLOK desktop service');
  expect((w.document.getElementById('openDesktopScreen') as HTMLButtonElement).hidden).toBe(true);
  expect((w.document.getElementById('openDesktopAccessibility') as HTMLButtonElement).hidden).toBe(false);

  const withReadOnlyMacAccess = structuredClone(withMissingMacAccess) as any;
  withReadOnlyMacAccess.config.readOnly = true;
  stateListener(withReadOnlyMacAccess);
  expect(accessWarning.hidden).toBe(true);
});

it('serializes settings intent so rapid toggles and later UI changes cannot undo each other', async () => {
  const html = await readRendererMarkup(process.cwd());
  domState.dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  installDialog(domState.dom.window);
  const w = domState.dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    getComputedStyle: w.getComputedStyle.bind(w),
    ResizeObserver: TestResizeObserver,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const baseConfig = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    providers: { api: { kind: 'openrouter' as const, baseUrl: '' } },
    ui: { minimizeToTray: true, privacyScreenshots: false, theme: 'light' as 'light' | 'dark' },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
    multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT
    }
  };
  const appState = (config: typeof baseConfig) => ({
    config,
    hasApiKey: false,
    hasGoalKey: false,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null }
  });
  let current = appState(baseConfig);
  const calls: any[] = [];
  const pending: Array<(reply: any) => void> = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const saveSettings = (patch: any) => {
    calls.push(structuredClone(patch));
    return new Promise<any>((resolve) => pending.push(resolve));
  };
  const api: any = new Proxy({
    getState: () => ok(current),
    getLog: () => ok([]),
    getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
    saveSettings,
    onStateChanged: () => () => undefined,
    onLogEntry: () => () => undefined,
    onSwarmChanged: () => () => undefined,
    onSessionChanged: () => () => undefined,
    listSessions: () => ok({ sessions: [], activeId: null, pressure: [] })
  }, { get(target, prop) { if (prop in target) return (target as any)[prop]; return (..._args: any[]) => ok(null); } });
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import('../../frontend/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));

  // First save toggles a value that has no form control of its own. Keep the IPC unresolved, matching a real save that is waiting for bridge lifecycle work in the main process.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].readOnly).toBe(true);

  // A second click before the first acknowledgement means "back off". The old handler derived both clicks from state.config.readOnly=false, so both snapshots requested true and the two clicks behaved like one.
  (w.document.getElementById('readOnlyBtn') as HTMLButtonElement).click();

  // While both are queued, change an unrelated checkbox. It must inherit the latest requested read-only intent rather than the stale acknowledged state.
  const minimizeToTray = w.document.getElementById('minimizeToTray') as HTMLInputElement;
  minimizeToTray.checked = false;
  minimizeToTray.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);

  current = appState({ ...baseConfig, readOnly: true });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1].readOnly).toBe(false);
  // The toggle tells assistive technology which state is saved, not just its colour.
  expect(w.document.getElementById('readOnlyBtn')?.getAttribute('aria-pressed')).toBe('true');
  // The lock reads like a state; its title says what a click changes.
  expect(w.document.getElementById('readOnlyBtn')?.title).toBe('Read-only is on: connected providers can only look. Click to allow changes again.');
  expect(calls[1].ui.minimizeToTray).toBe(true);

  current = appState({ ...baseConfig, readOnly: false });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2].readOnly).toBe(false);
  expect(w.document.getElementById('readOnlyBtn')?.getAttribute('aria-pressed')).toBe('false');
  expect(w.document.getElementById('readOnlyBtn')?.title).toMatch(/^Switch to read-only: connected providers can look at files and the screen/);
  expect(calls[2].ui.minimizeToTray).toBe(false);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, minimizeToTray: false } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Appearance changes must request dark then light in order, even though the first dark save has not answered yet.
  const theme = w.document.getElementById('appearanceTheme') as HTMLSelectElement;
  theme.value = 'dark'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  expect(calls[3].ui.theme).toBe('dark');
  theme.value = 'light'; theme.dispatchEvent(new w.Event('change', { bubbles: true }));
  expect(calls).toHaveLength(4);

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, minimizeToTray: false, theme: 'dark' } });
  pending.shift()!({ ok: true, data: current });
  await vi.waitFor(() => expect(calls).toHaveLength(5));
  expect(calls[4].ui.theme).toBe('light');

  current = appState({ ...baseConfig, readOnly: false, ui: { ...baseConfig.ui, minimizeToTray: false, theme: 'light' } });
  pending.shift()!({ ok: true, data: current });
  await new Promise((resolve) => setTimeout(resolve, 0));
});
