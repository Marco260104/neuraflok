// The control API's action routes over real loopback HTTP and the real outbox: what is refused and why, that sending and cancelling go through the app's own outbox and nothing else, and that what a message row proves about delivery is read from the row and never guessed.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import type { ToolCallRecord } from '../contracts/session.js';
import { isWebProviderConversationId, webProviderConversationId } from '../contracts/web-providers.js';
import type { WebProviderPresenceMap } from '../contracts/web-providers.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const gate = vi.hoisted(() => ({ actions: true, enabled: true }));
const providerBrowser = vi.hoisted(() => ({
  presence: {
    deepseek: { open: true, signedIn: true, tabId: 1, lastSeenAt: 1 },
    kimi: { open: true, signedIn: true, tabId: 2, lastSeenAt: 1 },
    qwen: { open: true, signedIn: true, tabId: 3, lastSeenAt: 1 },
    glm: { open: true, signedIn: true, tabId: 4, lastSeenAt: 1 }
  } as WebProviderPresenceMap,
  openProvider: vi.fn(async () => undefined),
  run: vi.fn(async () => null)
}));

vi.mock('electron', () => ({
  app: { on: vi.fn(), getPath: () => '', getVersion: vi.fn(() => '0.0.0'), getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  BrowserWindow: class {},
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  nativeTheme: { themeSource: 'system' }
}));

// The two switches are read from config on every request; this suite flips the second one.
vi.mock('../backend/infrastructure/settings/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend/infrastructure/settings/config.js')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), controlApi: { enabled: gate.enabled, allowActions: gate.actions } }) };
});
// Only the effects that would leave the process are replaced: the bridge listener and browser.
vi.mock('../backend/domains/browser/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend/domains/browser/bridge.js')>();
  return {
    ...actual,
    startBridge: vi.fn(async () => true),
    browserWakeConnected: () => true,
    webProvidersStatus: () => providerBrowser.presence
  };
});
vi.mock('../backend/domains/browser/browser-wake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend/domains/browser/browser-wake.js')>();
  return { ...actual, wakeBrowserWork: () => {
    const lastSeenAt = Date.now();
    for (const presence of Object.values(providerBrowser.presence)) presence.lastSeenAt = lastSeenAt;
  } };
});
vi.mock('../backend/domains/browser/embedded/selection.js', () => ({
  loadIntegratedBrowser: async () => ({ openProvider: providerBrowser.openProvider })
}));
vi.mock('../backend/domains/providers/browser-chat.js', () => ({
  webProviderFlightTurnId: () => undefined,
  runWebProviderInput: providerBrowser.run
}));
vi.mock('../backend/domains/browser/browser-startup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backend/domains/browser/browser-startup.js')>();
  return { ...actual, wakeBrowserUrl: vi.fn(async () => undefined) };
});

export const { initConfigPath } = await import('../backend/infrastructure/settings/config.js');
export const { initSecretsPath } = await import('../backend/infrastructure/settings/secrets.js');
export const { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } = await import('../backend/persistence/durable.js');
export const { appendEvent, createSession, initSessionStore, observeSessionModel, resetSessionStoreForTests } = await import('../backend/domains/sessions/history/store.js');
export const input = await import('../backend/domains/sessions/input/input.js');
export const startInput = await import('../backend/domains/sessions/input/start-input.js');
export const bridge = await import('../backend/domains/browser/bridge.js');
export const startup = await import('../backend/domains/browser/browser-startup.js');
export const { setChatBlocked } = await import('../backend/domains/sessions/continuity/blocked-chats.js');
export const controlActions = await import('../backend/infrastructure/local-api/control-actions.js');
export const controlApi = await import('../backend/infrastructure/local-api/control-api.js');
export const { listInputs, resetInputForTests } = input;

export let dir: string;
export let port = 0;
export let token = '';
export let chatSession = '';
export const CHAT = webProviderConversationId('deepseek', '11111111-1111-4111-8111-111111111111');

export async function restart(): Promise<void> {
  // A fresh listener also starts with a fresh action budget and a fresh token.
  await controlApi.stopControlApi();
  await controlApi.startControlApi();
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  port = endpoint.port;
  token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
}

export interface Reply {
  status: number;
  body: any;
  raw: string;
  headers: http.IncomingHttpHeaders;
  continued: boolean;
  // The server closed the connection before a whole answer arrived.
  reset: boolean;
}

// The server ended the connection before reading the whole request: a reset, or EPIPE on macOS.
export function closedByServer(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  return code.startsWith('ECONN') || code === 'EPIPE';
}

export function call(
  method: string,
  route: string,
  options: { headers?: Record<string, string>; body?: string | Buffer; auth?: boolean } = {}
): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.auth === false ? {} : { authorization: 'Bearer ' + token }) };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(options.body));
  }
  Object.assign(headers, options.headers);
  for (const key of Object.keys(headers)) if (headers[key] === '') delete headers[key];
  return new Promise((resolve, reject) => {
    let continued = false;
    const expectsContinue = /100-continue/i.test(headers['expect'] ?? '');
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers, continued, reset: false });
      });
    });
    // A refused request may be cut off before its body is read. That is an answer too, and it has to settle this promise: an ECONNRESET closes the socket, so the idle timeout below never fires.
    req.on('error', (error) => {
      if (closedByServer(error)) resolve({ status: 0, body: null, raw: '', headers: {}, continued, reset: true });
      else reject(error);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('the test request timed out')));
    if (expectsContinue) {
      req.on('continue', () => { continued = true; req.end(options.body); });
      req.flushHeaders();
    } else {
      req.end(options.body);
    }
  });
}

export const post = (route: string, body?: unknown, headers?: Record<string, string>) =>
  call('POST', route, { headers, body: body === undefined ? undefined : JSON.stringify(body) });

export const outbox = () => listInputs();
export const text = (value: string) => ({ text: value, truncated: false, chars: value.length });
export const toolCall = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  callId: 'call-1', tool: 'exec_command', attribution: 'request_id', requestId: 'req-1', conversationId: null, attributionMethod: 'request_id',
  args: text('{}'), result: text('ok'), outcome: 'ok', durationMs: 5, summary: { title: 'Ran a command', tone: 'neutral', kind: 'run' }, ...over
});
export const sendBody = (over: object = {}) => ({ id: randomUUID(), sessionId: chatSession, text: 'Keep going', ...over });

// A chat that is writing an answer right now, as the outbox recognises one that a send would stop.
export async function answeringSession(title: string, conversationId: string, turnId: string): Promise<string> {
  const providerConversation = validConversationId(conversationId);
  const id = await makeSession(title, providerConversation);
  await observeSessionModel(id, providerConversation, 'deepseek-chat', Date.now());
  await appendEvent(id, { kind: 'turn_start', source: 'extension', time: Date.now(), turnId });
  return id;
}

export async function makeSession(title: string, conversationId: string | null, origin?: object) {
  return (await createSession({ title, conversationId: conversationId ? validConversationId(conversationId) : null,
    ...(origin ? { origin: origin as never } : {}) })).id;
}

export function validConversationId(value: string): string {
  return isWebProviderConversationId(value) ? value : webProviderConversationId('deepseek', randomUUID());
}

// A row as the outbox stores it. Seeding the durable state is how a test gets a row in a state the running app reaches only through a browser page, without pretending to be one.
export const row = (over: object = {}) => ({
  id: randomUUID(), sessionId: chatSession, text: 'hello', mode: 'auto', dueAt: 1, model: null, reasoningEffort: null,
  state: 'queued', owner: null, createdAt: Date.now(), conversationId: null, ...over
});

export async function seed(rows: object[]): Promise<void> {
  // Windows can refuse the rename of a state file that a scanner is holding for a moment.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await writeDurableNow('session-input', rows);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  resetInputForTests();
}

export const wake = () => vi.mocked(startup.wakeBrowserUrl);

beforeAll(async () => {
  dir = await makeTempDir('clf-control-actions-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  controlApi.initControlApiPath(dir);
  chatSession = await makeSession('Chat one', CHAT);
});

beforeEach(async () => {
  gate.actions = true;
  gate.enabled = true;
  providerBrowser.presence.deepseek = { open: true, signedIn: true, tabId: 1, lastSeenAt: 1 };
  providerBrowser.presence.kimi = { open: true, signedIn: true, tabId: 2, lastSeenAt: 1 };
  providerBrowser.presence.qwen = { open: true, signedIn: true, tabId: 3, lastSeenAt: 1 };
  providerBrowser.presence.glm = { open: true, signedIn: true, tabId: 4, lastSeenAt: 1 };
  providerBrowser.openProvider.mockReset().mockResolvedValue(undefined);
  providerBrowser.run.mockReset().mockResolvedValue(null);
  await seed([]);
  wake().mockClear();
  controlApi.setActionLimitsForTests({});
  await restart();
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  startInput.resetInputStartupForTests();
  await flushDurable();
  resetInputForTests();
  resetDurableForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});


export const actionGate = gate;
export const providerBrowserState = providerBrowser;

export type { ToolCallRecord, WebProviderPresenceMap };
