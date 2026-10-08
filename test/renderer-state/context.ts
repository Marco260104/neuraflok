import { readRendererMarkup } from "../../scripts/read-renderer-markup.cjs";
import { JSDOM } from 'jsdom';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from "../../contracts/automation/goal-prompts.js";
import { DEFAULT_HANDOFF_PROMPT } from "../../contracts/sessions/continuity-brief.js";
import { emptyWebProviderPresence } from "../../contracts/web-providers.js";
import { afterEach, vi } from 'vitest';
export const domState: { dom: JSDOM } = { dom: undefined as unknown as JSDOM };
export class TestResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
}

export function installDialog(w: any): void {
  const proto = w.HTMLDialogElement.prototype;
  if (typeof proto.showModal !== 'function') proto.showModal = function (this: any) { this.open = true; };
  if (typeof proto.close !== 'function') proto.close = function (this: any) { if (!this.open) return; this.open = false; this.dispatchEvent(new w.Event('close')); };
}

export function rowMenuItem(row: Element, action: string): HTMLButtonElement | null {
  const doc = row.ownerDocument;
  closeRowMenus(doc);
  (row.querySelector('[data-row-menu]') as HTMLButtonElement).click();
  return doc.querySelector<HTMLButtonElement>(`.row-menu [data-row-action="${action}"]`);
}

export function closeRowMenus(doc: Document): void {
  doc.querySelector('.row-menu')?.dispatchEvent(new (doc.defaultView as any).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

export interface GoalMount {
  window: JSDOM['window'];
  calls: any[];
  keys: Array<{ method: string; value: string }>;
  modelPages: any[];
  push(state: any): void;
  state: any;
}

export async function mountChat(
  overrides: Record<string, unknown> = {},
  models: any[] = [],
  apiOverrides: Record<string, (...args: any[]) => any> = {},
  initialGoal: Record<string, unknown> = {},
  initialProvider: Record<string, unknown> = {}
): Promise<GoalMount> {
  const html = await readRendererMarkup(process.cwd());
  domState.dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  installDialog(domState.dom.window);
  const w = domState.dom.window;
  w.HTMLElement.prototype.animate = vi.fn() as any;
  Object.assign(globalThis, { Event: w.Event });
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    getComputedStyle: w.getComputedStyle.bind(w),
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    DocumentFragment: w.DocumentFragment,
    HTMLInputElement: w.HTMLInputElement,
    HTMLSelectElement: w.HTMLSelectElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement,
    ResizeObserver: TestResizeObserver
  });
  if (!(w.HTMLElement.prototype as any).scrollIntoView) (w.HTMLElement.prototype as any).scrollIntoView = () => {};

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: false,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: true, edit: true, move: true, deleteFile: true, command: true,
      screen: true, control: true, clipboardRead: true, clipboardWrite: true
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    providers: { api: { kind: 'openrouter' as const, baseUrl: '', ...initialProvider } },
    ui: { minimizeToTray: true, privacyScreenshots: false, theme: 'light' as const,
      chatExecutor: 'web' as const, webProvider: 'deepseek' as const, chatBrowser: 'integrated' as const },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000, handoffPrompt: DEFAULT_HANDOFF_PROMPT },
    multiAgent: { enabled: false, maxWorkers: 2, globalMaxWorkers: 0, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      reasoning: 'default' as const,
      prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
      ...initialGoal
    }
  };
  const state: any = {
    config,
    hasApiKey: false,
    hasGoalKey: false,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null,
      webProviders: emptyWebProviderPresence() },
    update: { current: '2.0.2', latest: null, stage: 'idle', error: null, checkedAt: null },
    ...overrides
  };
  let listener: (next: any) => void = () => undefined;
  const calls: any[] = [];
  const keys: Array<{ method: string; value: string }> = [];
  const modelPages: any[] = [];
  const ok = (data: any) => Promise.resolve({ ok: true as const, data });
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: (fn: any) => {
        listener = fn;
        return () => undefined;
      },
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: () => () => undefined,
      listSessions: () => ok({ sessions: [], activeId: null, pressure: [] }),
      // Answers with the config it just stored, the way the real handler does. The panel paints from the app's answer rather than from what it just clicked, so a fake that replied with the old config would be testing a revert.
      saveSettings: (patch: any) => {
        calls.push(structuredClone(patch));
        state.config = { ...state.config, ...structuredClone(patch) };
        return ok(state);
      },
      setGoalKey: (value: string) => {
        keys.push({ method: 'setGoalKey', value });
        return ok({ ...state, hasGoalKey: value !== '' });
      },
      setApiKey: (value: string) => {
        keys.push({ method: 'setApiKey', value });
        return ok(state);
      },
      listGoalModels: (offset: number, query = '') => {
        const needle = query.trim().toLowerCase();
        const matches = needle
          ? models.filter(model => String(model.id).toLowerCase().includes(needle) || String(model.name).toLowerCase().includes(needle))
          : models;
        const page = { models: matches.slice(offset, offset + 20), total: matches.length, offset, query };
        modelPages.push(page);
        return ok(page);
      },
      ...apiOverrides
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });
  await import('../../frontend/main.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window: w, calls, keys, modelPages, state, push: (next) => listener(next) };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export const projectSidebarFixture = () => {
  const project = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Collapsed project', path: 'C:\\repo', createdAt: 1 };
  const session = { id: 'project-session', title: 'Project task', conversationId: 'chat-project', chatIds: ['chat-project'],
    startedAt: 1, updatedAt: 2, endedAt: null, events: 0, userMessages: 0, toolCalls: 0,
    lastToolCallAt: null, processExitNonzero: 0, toolRejected: 0, toolInternalErrors: 0, errors: 0,
    estimatedTokens: 0, contextTokens: 0, lastHandoffId: null, lastHandoffAt: null,
    lastTurnOutcome: null, activeTurnId: null, agents: [], origin: null, projectId: project.id };
  return { project, session };
};

export const catalogue = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `vendor${index}/model-${index}`,
    name: `Model ${index}`,
    created: 1_800_000_000 - index * 86_400,
    contextLength: 128_000
  }));
afterEach(() => {
  domState.dom?.window.close();
  domState.dom = undefined as unknown as JSDOM;
  vi.resetModules();
});
