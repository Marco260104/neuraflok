// The control API's read routes over real loopback HTTP and the real session store: what they return, what they refuse, and that a projection publishes only the fields it names.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';
import type { ResumeJobView, SessionControlsView } from '../backend/domains/browser/bridge.js';
import type { SessionEvent, ToolCallRecord } from '../contracts/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

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

export const { initConfigPath } = await import('../backend/infrastructure/settings/config.js');
export const { initSecretsPath } = await import('../backend/infrastructure/settings/secrets.js');
export const { initDurableStore, flushDurable } = await import('../backend/persistence/durable.js');
export const { appendEvent, createSession, initSessionStore, resetSessionStoreForTests, upsertMessageEvent } = await import('../backend/domains/sessions/history/store.js');
export const { cancelInput, deliveryProof, enqueueInput } = await import('../backend/domains/sessions/input/input.js');
export const { logInfo, logWarn, logError } = await import('../backend/infrastructure/settings/logger.js');
export const { redactSecretText } = await import('../backend/infrastructure/settings/redaction.js');
export const { prependUserPrompt } = await import('../contracts/messaging/provider-message-envelope.js');
export const controlApi = await import('../backend/infrastructure/local-api/control-api.js');
export const bridgeModule = await import('../backend/domains/browser/bridge.js');
export const inputModule = await import('../backend/domains/sessions/input/input.js');
export const readModelModule = await import('../backend/domains/sessions/history/read-model.js');
export const reads = await import('../backend/infrastructure/local-api/control-reads.js');
export const agentsModule = await import('../backend/domains/automation/agents.js');

export let dir: string;
export let port = 0;
export let auth: Record<string, string> = {};

// Built at run time so no secret-shaped literal sits in the source.
export const apiKey = `sk-proj-${randomBytes(24).toString('hex')}`;
export const text = (value: string) => ({ text: value, truncated: false, chars: value.length });

export function call(route: string, headers: Record<string, string> = auth): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = raw;
        try { body = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export const toolCall = (over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  callId: 'call-1',
  tool: 'exec_command',
  attribution: 'request_id',
  requestId: 'req-1',
  conversationId: null,
  attributionMethod: 'request_id',
  args: text(JSON.stringify({ cmd: `curl -H "Authorization: ${apiKey}" https://example.test` })),
  result: text('ok'),
  outcome: 'ok',
  durationMs: 12,
  summary: { title: 'Ran curl', tone: 'neutral', kind: 'run' },
  changes: [{ path: 'src/a.ts', added: 3, removed: 1, approximate: false, reviewAssetId: 'asset-secret' }],
  ...over
});

export let sessionId: string;
export let liveSessionId: string;
export let firstAssistantSeq = 0;
export let revisionSeq = 0;
export const allIds: string[] = [];

beforeAll(async () => {
  dir = await makeTempDir('clf-control-reads-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  controlApi.initControlApiPath(dir);

  const session = await createSession({ title: `Audit me ${apiKey}` });
  sessionId = session.id;
  await appendEvent(sessionId, { kind: 'user_message', source: 'extension', time: 10, message: text('Please run the checks') });
  const assistant = { kind: 'assistant_message' as const, source: 'extension' as const, time: 20, messageId: 'm1', message: text('x'.repeat(9_000)), final: true };
  firstAssistantSeq = (await upsertMessageEvent(sessionId, assistant)).event.seq;
  await appendEvent(sessionId, { kind: 'tool_call', source: 'mcp', time: 30, call: toolCall() });
  await appendEvent(sessionId, { kind: 'note', source: 'app', time: 40, message: text('A note') });
  await appendEvent(sessionId, { kind: 'turn_end', source: 'extension', time: 50, outcome: 'completed', turnId: 'turn-1' });
  // A revision keeps the message's first position but takes the newest seq.
  revisionSeq = (await upsertMessageEvent(sessionId, { ...assistant, message: text('x'.repeat(9_000) + ' updated') })).event.seq;

  const others = [await createSession({ title: 'Second' }), await createSession({ title: 'Third' })];
  liveSessionId = (await createSession({ title: 'Has a chat', conversationId: 'chat-live-1' })).id;
  allIds.push(sessionId, ...others.map((row) => row.id), liveSessionId);

  await controlApi.startControlApi();
  const endpoint = JSON.parse(await fs.readFile(path.join(dir, 'control-api', 'endpoint.json'), 'utf8'));
  const token = (await fs.readFile(path.join(dir, 'control-api', 'token'), 'utf8')).trim();
  port = endpoint.port;
  auth = { authorization: `Bearer ${token}` };
});

afterAll(async () => {
  await controlApi.shutdownControlApi();
  await flushDurable();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});


export type { ResumeJobView, SessionControlsView, SessionEvent, ToolCallRecord };
