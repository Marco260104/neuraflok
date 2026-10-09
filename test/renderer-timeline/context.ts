import { readRendererMarkup } from "../../scripts/read-renderer-markup.cjs";
import { JSDOM } from 'jsdom';
import { afterEach, vi } from 'vitest';
import { DEFAULT_GOAL_SYSTEM_PROMPT } from "../../contracts/automation/goal-prompts.js";
import type { Handoff, SessionEvent, SessionSummary } from "../../contracts/session.js";
import type { InputArgs, InputEntry } from "../../backend/domains/sessions/input/input.js";
import type { LocalProject } from "../../contracts/workspace/projects.js";
import { positionOf } from "../../contracts/chronology.js";

// Tests the live session timeline in the renderer booted in jsdom.

let dom: JSDOM | null = null;

afterEach(() => {
  dom?.window.close();
  dom = null;
  vi.resetModules();
});

export const TOKEN = 'tok_0123456789abcdef';

export const T0 = Date.UTC(2026, 8, 2, 0, 50, 0);

export function text(value: string) {
  return { text: value, truncated: false, chars: value.length };
}

export function summary(events: SessionEvent[]): SessionSummary {
  return {
    id: '2026-09-02-test0001',
    title: 'Loop under test',
    conversationId: 'chat-b',
    selectedModel: { conversationId: 'chat-b', model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: T0 },
    chatIds: ['chat-a', 'chat-b'],
    startedAt: T0,
    updatedAt: T0 + 120_000,
    endedAt: null,
    events: events.length,
    userMessages: 2,
    toolCalls: 1,
    lastToolCallAt: null,
    processExitNonzero: 0,
    toolRejected: 0,
    toolInternalErrors: 0,
    errors: 0,
    estimatedTokens: 12_000,
    contextTokens: 900,
    lastHandoffId: null,
    lastHandoffAt: null,
    lastTurnOutcome: null,
    activeTurnId: null,
    agents: [],
    origin: null
  };
}

export function toolCall(seq: number, callId: string): SessionEvent {
  return {
    seq,
    time: T0 + seq * 1000,
    source: 'mcp',
    kind: 'tool_call',
    call: {
      callId,
      tool: 'read',
      attribution: 'request_id',
      requestId: `req-${callId}`,
      conversationId: 'chat-a',
      attributionMethod: 'request_id',
      args: text('{"path":"README.md"}'),
      result: text('# NEURAFLOK'),
      outcome: 'ok',
      durationMs: 40,
      summary: { kind: 'read', title: 'Read README.md', tone: 'neutral' }
    }
  };
}

export // Builds the recorded rows for a Compact & Resume handoff in their observed order.
function compaction(seq: number, escaped = false): SessionEvent[] {
  const mark = (kind: 'HANDOFF' | 'RESUME') =>
    escaped ? `[[CLF-${kind}\\:${TOKEN}]]` : `[[CLF-${kind}:${TOKEN}]]`;
  return [
    {
      seq,
      time: T0 + seq * 1000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'm-brief-request',
      turnId: 'turn-brief',
      message: text(`${mark('HANDOFF')} Write the handoff brief for this session.`)
    },
    { seq: seq + 1, time: T0 + (seq + 1) * 1000, source: 'extension', kind: 'turn_start', turnId: 'turn-brief' },
    {
      seq: seq + 2,
      time: T0 + (seq + 2) * 1000,
      source: 'extension',
      kind: 'assistant_message',
      messageId: 'm-brief',
      turnId: 'turn-brief',
      message: text('# Brief\n\nGoal: keep the loop running.'),
      state: 'final',
      final: true
    },
    {
      seq: seq + 3,
      time: T0 + (seq + 3) * 1000,
      source: 'extension',
      kind: 'turn_end',
      turnId: 'turn-brief',
      outcome: 'completed'
    },
    { seq: seq + 4, time: T0 + (seq + 4) * 1000, source: 'app', kind: 'handoff', handoffId: 'h-1', chars: 44, reason: 'auto' },
    {
      seq: seq + 5,
      time: T0 + (seq + 5) * 1000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'm-bootstrap',
      message: text(`${mark('RESUME')} Continue from this brief: keep the loop running.`)
    }
  ];
}

export async function settle(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export /** History paging yields to the browser frame after each bounded read. Timer ticks alone can all finish before that frame on Linux and macOS. */
async function settleHistoryFrame(w: Pick<Window, 'requestAnimationFrame'>): Promise<void> {
  await settle();
  await new Promise<void>(resolve => w.requestAnimationFrame(() => resolve()));
  await settle();
}

export async function boot(events: SessionEvent[], selectExisting = true, pausedHelpers: Array<{ id: string; sourceSessionId: string }> = [], projects: LocalProject[] = [], options: { origin?: SessionSummary["origin"]; developerMode?: boolean; followOutput?: boolean; sessions?: SessionSummary[]; reserveOpenings?: boolean; handoff?: Handoff | null; deferProcessStop?: boolean } = {}) {
  const html = await readRendererMarkup(process.cwd());
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.assign(globalThis, {
    window: w,
    Event: w.Event,
    document: w.document,
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

  const config = {
    roots: [{ name: 'repo', path: 'C:\\repo' }],
    readOnly: true,
    capabilities: {
      browse: true, search: true, read: true, metadata: true,
      create: false, edit: false, move: false, deleteFile: false, command: false,
      screen: false, control: false, clipboardRead: false, clipboardWrite: false
    },
    commandAllowlist: { enabled: false, mode: 'allow' as const, rules: [] as string[] },
    ui: { minimizeToTray: true, privacyScreenshots: false, theme: 'light', developerMode: options.developerMode ?? false, ...(options.followOutput === undefined ? {} : { followOutput: options.followOutput }) },
    sessions: { record: true, retainDays: 30, advisoryTokens: 300000, limitTokens: 400000 },
    compaction: { auto: true, autoTokens: 300000 },
    multiAgent: { enabled: false, maxWorkers: 2, allowUnattributedCalls: false, recoverAgentTabs: true },
    goal: { enabled: false, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' as const, prompt: DEFAULT_GOAL_SYSTEM_PROMPT },
    providers: { api: { kind: 'openrouter' as const, baseUrl: '' } }
  };
  const state = {
    config,
    hasApiKey: false,
    hasGoalKey: false,
    bridge: { running: true, port: 8765, paired: false, present: false, lastSeenAt: null, extensionVersion: null },
    update: { current: '2.0.3', latest: null, stage: 'idle', error: null, checkedAt: null }
  };
  const ok = (data: any) => Promise.resolve({ ok: true, data });
  const live = { events: [...events], inputs: [] as InputEntry[], sent: [] as InputArgs[], automation: 'off', controlCalls: [] as Array<{ id: string; action: string }>, compacting: false, finishHeld: true };
  let sessionListener: (change?: unknown) => void = () => undefined;
  let writeSessionListener: (id: string) => void = () => undefined;
  let backgroundProcessListener: () => void = () => undefined;
  let backgroundProcesses: Array<{ processId: number; incarnation: number; command: string; startedAt: number; tty: boolean }> = [];
  let resolveBackgroundStop: (() => void) | null = null;
  const taskProgressListeners = new Set<(progress: any) => void>();
  const api: any = new Proxy(
    {
      getState: () => ok(state),
      getSessionControls: (id: string) => ok({ sessionId: id, conversationId: 'chat-a', automation: live.automation, activeTurnId: 'held-turn', finishHeld: live.finishHeld, blocked: '', job: live.compacting ? { busy: true } : null }),
      releaseSessionFinish: (id: string, turn: string) => { live.controlCalls.push({ id, action: `release:${turn}` }); live.finishHeld = false; return ok({}); },
      setSessionAutomation: (id: string, action: string) => { live.controlCalls.push({ id, action }); live.automation = action; return ok({}); },
      compactSession: (id: string) => { live.controlCalls.push({ id, action: 'compact' }); live.compacting = true; return ok({}); },
      cancelSessionCompaction: (id: string) => { live.controlCalls.push({ id, action: 'cancel' }); live.compacting = false; return ok({}); },
      getLog: () => ok([]),
      getSwarm: () => ok({ running: false, runId: null, agents: [], maxWorkers: 2, pendingReports: 0 }),
      onStateChanged: () => () => undefined,
      onTaskProgress: (listener: (progress: any) => void) => { taskProgressListeners.add(listener); return () => taskProgressListeners.delete(listener); },
      draftGoalOpening: (text: string) => ok({ reply: `Start: ${text}`, model: 'fixture' }),
      onLogEntry: () => () => undefined,
      onSwarmChanged: () => () => undefined,
      onSessionChanged: (fn: any) => {
        sessionListener = fn;
        return () => undefined;
      },
      onWriteSession: (fn: (id: string) => void) => {
        writeSessionListener = fn;
        return () => undefined;
      },
      listSessions: () => {
        const sessions = options.sessions ?? [{ ...summary(live.events), ...(options.origin ? { origin: options.origin } : {}), ...(projects[0] ? { projectId: projects[0].id } : {}) }];
        const known = new Set(sessions.map(row => row.id));
        const openings = live.inputs.filter(row => row.opening && row.sessionId && !known.has(row.sessionId)).map(row => ({
          ...summary(live.events), id: row.sessionId!, title: row.text, conversationId: null, chatIds: []
        }));
        return ok({ sessions: [...openings, ...sessions], activeId: summary(live.events).id, pressure: [] });
      },
      listProjects: () => ok(projects),
      // IPC snapshots cannot share the backend's mutable array with the renderer.
      listInputs: () => ok(structuredClone(live.inputs)),
      cancelInput: vi.fn((id: string) => {
        const entry = live.inputs.find(row => row.id === id);
        if (!entry) return ok(false);
        entry.state = 'cancelled'; entry.cancelledByUser = true;
        return ok(true);
      }),
      runningTools: () => ok([]),
      runningProcesses: () => ok(structuredClone(backgroundProcesses)),
      stopProcess: vi.fn(async (_sessionId: string, processId: number, incarnation: number) => {
        if (options.deferProcessStop) await new Promise<void>(resolve => { resolveBackgroundStop = resolve; });
        backgroundProcesses = backgroundProcesses.filter(row => row.processId !== processId || row.incarnation !== incarnation);
        backgroundProcessListener();
        return { ok: true, data: true };
      }),
      onBackgroundProcessesChanged: (listener: () => void) => {
        backgroundProcessListener = listener;
        return () => undefined;
      },
      listPausedHelpers: () => ok(pausedHelpers),
      retryHelper: (id: string, sourceSessionId: string) => {
        live.controlCalls.push({ id: sourceSessionId, action: `retry:${id}` });
        pausedHelpers = pausedHelpers.filter(row => row.id !== id);
        return ok(true);
      },
      sendInput: (input: InputArgs) => {
        live.sent.push(input);
        const row: InputEntry = { ...input, state: 'queued', owner: null, createdAt: Date.now(), conversationId: null };
        if (options.reserveOpenings && input.sessionId === null) Object.assign(row, {
          opening: true, requestedSessionId: null, sessionId: input.id
        });
        if (input.mode === 'finish' && input.stages) {
          row.stagesApplied = true;
          live.inputs.push(row, ...input.stages.map((text, index) => ({ ...row, id: `${input.id}-${index}`, text, stages: undefined })));
          return ok(row);
        }
        live.inputs.push(row);
        return ok(row);
      },
      getSession: (_id: string, options?: { from?: number; before?: number; after?: number; limit?: number }) => {
        const from = options?.from ?? 0;
        const eligible = live.events.filter((event) => event.seq >= from &&
          (options?.before === undefined || positionOf(event) < options.before) &&
          (options?.after === undefined || positionOf(event) > options.after))
          .sort((a, b) => options?.from !== undefined ? a.seq - b.seq : positionOf(a) - positionOf(b));
        const limit = options?.limit ?? 30;
        const page = options?.after !== undefined || options?.from !== undefined
          ? eligible.slice(0, limit) : eligible.slice(-limit);
        const opening = live.inputs.find(row => row.opening && row.sessionId === _id);
        return ok({
          summary: opening ? { ...summary(live.events), id: _id, title: opening.text, conversationId: null, chatIds: [] } : summary(live.events),
          events: page,
          total: live.events.length,
          nextFrom: page.reduce((max, e) => Math.max(max, e.seq + 1), from)
        });
      },
      getHandoff: (sessionId: string, handoffId: string) => ok(options.handoff?.sessionId === sessionId && options.handoff.id === handoffId ? options.handoff : null)
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return (..._args: any[]) => ok(null);
      }
    }
  );
  Object.defineProperty(w, 'api', { value: api, configurable: true });

  await import("../../frontend/main.js");
  await settle();
  if (selectExisting) {
    (w.document.querySelector('#sessionList [data-id]') as HTMLElement).click();
    await settle();
  }

  return {
    w,
    live,
    // This fixture serves one shared `live.events` for every session id, so a recorder write changes every transcript it can show. Payload-less pushes are catalog/control only.
    notifySession: () => sessionListener({ allTranscripts: true }),
    writeSession: (id: string) => writeSessionListener(id),
    progress: (value: any) => { for (const listener of taskProgressListeners) listener(value); },
    resolveBackgroundStop: () => { const resolve = resolveBackgroundStop; resolveBackgroundStop = null; resolve?.(); },
    async publishBackgroundProcesses(rows: Array<{ processId: number; incarnation: number; command: string; startedAt: number; tty: boolean }>) {
      backgroundProcesses = structuredClone(rows);
      backgroundProcessListener();
      await settle();
    },
    async append(more: SessionEvent[]) {
      live.events.push(...more);
      sessionListener({ allTranscripts: true });
      await settle(500);
    }
  };
}

export /** Opens a project's "⋯" menu; its items live in the document body, outside the repainted sidebar. */
function projectMenu(w: any, id: string): HTMLButtonElement {
  const button = w.document.querySelector(`.project-group[data-project-id="${id}"] .project-menu`) as HTMLButtonElement;
  button.click();
  return button;
}

export const menuItem = (w: any, action: string): HTMLButtonElement => w.document.querySelector(`.row-menu [data-row-action="${action}"]`) as HTMLButtonElement;

export /** Opens the project's Color submenu and returns the choice for `color` ('none' clears it). */
function colorChoice(w: any, id: string, color: string): HTMLButtonElement {
  projectMenu(w, id);
  menuItem(w, 'color').click();
  return menuItem(w, `color-${color}`);
}

export /** A page_tool event, and how a test reads the group title and the latest call's own title. */
const nativeStep = (seq: number, label: string): SessionEvent => ({ seq, time: T0 + seq * 1000, source: 'extension', kind: 'page_tool', messageId: `note-${seq}`, label });

export const groupTitle = (document: Document) => document.querySelector('#timeline details.tool-group .activity-title')!.textContent;

export const latestCallTitle = (document: Document) => {
  const tool = [...document.querySelectorAll<HTMLElement>('#timeline .ev-tool_call')].at(-1)!;
  return tool.querySelector('.tool > summary b')?.textContent ?? tool.querySelector('.tool > summary span')?.textContent;
};
