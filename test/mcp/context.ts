import { afterAll, beforeAll, beforeEach } from 'vitest';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { effectiveCapabilities, defaultConfig, getConfig } from '../../backend/infrastructure/settings/config.js';
import { startMcpServer, type McpEndpoint } from '../support/mcp-server.js';
import { lastToolCallAt, type ToolContext } from '../support/mcp-tools.js';
import { friendlyError } from '../../backend/infrastructure/tool-gateway/protocol/kernel.js';
import { SURFACE_LIST, surfaceDefinition, type SurfaceId } from '../../backend/infrastructure/tool-gateway/protocol/surfaces.js';
import {
  createSession,
  initSessionStore,
  readRecentEvents,
  rebindSession,
  readSessionPlan
} from '../../backend/domains/sessions/history/store.js';
import {
  bindConversation,
  onSpawnRequest,
  onSwarmPersistNow,
  resetAgentsForTests,
  spawn
} from '../../backend/domains/automation/agents.js';
import { resetWorkspaces, setWorkspaceFor } from '../../backend/domains/workspace/workspace.js';
import { DEFAULT_CAPABILITIES, type Capabilities, type Root } from '../../contracts/types.js';
import { foldProgress, type ToolOutcome } from '../../contracts/session.js';
import { emptyEvidence, noteExec, noteOutcome, runInCallContext, type CallContext } from '../../backend/infrastructure/tool-gateway/protocol/call-context.js';
import { observeRequestCorrelation } from '../../backend/domains/sessions/history/correlation.js';
import { WINDOWS_COMPUTER_METHODS, WINDOWS_COMPUTER_READ_METHODS } from '../../contracts/windows-computer/operation-policy.js';
import { BROWSER_TOOLS, BROWSER_READ_TOOLS } from '../../contracts/browser/control-policy.js';
import { resetBlockedChatsForTests, setChatBlocked } from '../../backend/domains/sessions/continuity/blocked-chats.js';
import { resetTrustedChatsForTests, setChatTrusted } from '../../backend/domains/sessions/continuity/trusted-chats.js';
import {
  abortContinuation,
  attachSummary,
  dispatchContinuationSourceSendNow,
  beginContinuationSourceSendNow,
  claimContinuationNow,
  commitContinuation,
  openContinuationNow,
  resetContinuationsForTests
} from '../../backend/domains/sessions/continuity/continuation.js';
import {
  backdateExecAttendanceForTests,
  backgroundExecObligations,
  execOwner,
  MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION,
  noteExecOwner,
  forgetExecOwner,
  resetExecOwnershipForTests,
  UNATTENDED_EXEC_NOTICE_MS
} from '../../backend/domains/workspace/execution/ownership.js';
import { unifiedExecManager } from '../../backend/domains/workspace/execution/manager.js';
import * as execHints from '../../backend/domains/workspace/exec-hints.js';
import { locateRipgrep } from '../../backend/infrastructure/binaries/ripgrep.js';
import { IS_WINDOWS, makeTempDir, removeTempDir, writeTree } from '../helpers.js';
export {
  BROWSER_READ_TOOLS,
  BROWSER_TOOLS,
  DEFAULT_CAPABILITIES,
  IS_WINDOWS,
  MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION,
  SURFACE_LIST,
  UNATTENDED_EXEC_NOTICE_MS,
  WINDOWS_COMPUTER_METHODS,
  WINDOWS_COMPUTER_READ_METHODS,
  abortContinuation,
  attachSummary,
  backdateExecAttendanceForTests,
  backgroundExecObligations,
  beginContinuationSourceSendNow,
  bindConversation,
  claimContinuationNow,
  commitContinuation,
  createSession,
  defaultConfig,
  dispatchContinuationSourceSendNow,
  effectiveCapabilities,
  emptyEvidence,
  execHints,
  execOwner,
  foldProgress,
  forgetExecOwner,
  friendlyError,
  fs,
  getConfig,
  http,
  initSessionStore,
  lastToolCallAt,
  locateRipgrep,
  makeTempDir,
  noteExec,
  noteExecOwner,
  noteOutcome,
  observeRequestCorrelation,
  onSpawnRequest,
  onSwarmPersistNow,
  openContinuationNow,
  os,
  path,
  randomBytes,
  readRecentEvents,
  readSessionPlan,
  rebindSession,
  removeTempDir,
  resetAgentsForTests,
  resetBlockedChatsForTests,
  resetContinuationsForTests,
  resetExecOwnershipForTests,
  resetTrustedChatsForTests,
  resetWorkspaces,
  runInCallContext,
  setChatBlocked,
  setChatTrusted,
  setWorkspaceFor,
  sharp,
  spawn,
  startMcpServer,
  surfaceDefinition,
  unifiedExecManager,
  writeTree,
};
export type {
  CallContext,
  Capabilities,
  McpEndpoint,
  Root,
  SurfaceId,
  ToolContext,
  ToolOutcome,
};
export const mcpHarness: { nextId: number; base: string; approved: string; outside: string; endpoint: McpEndpoint; ctx: ToolContext } = { nextId: 1, base: '', approved: '', outside: '', endpoint: undefined as unknown as McpEndpoint, ctx: undefined as unknown as ToolContext };

// ---------------------------------------------------------------- transport

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

export function rawPost(
  urlStr: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

export function rawGet(urlStr: string): Promise<RawResponse> {
  const url = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Streamable HTTP may answer as JSON or as a one-shot SSE stream. Accept both. */
export function decode(res: RawResponse): any {
  const text = res.text.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  const datas = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? '');
  const last = datas.at(-1);
  if (last !== undefined) {
    try {
      return JSON.parse(last);
    } catch {
      return text;
    }
  }
  return text;
}

/** A 2025-era request to one surface: a plain JSON-RPC body with no _meta envelope. Every request names its surface, because "which server answered" is the property most of this file is about. There is no default-surface helper on purpose. */
export async function call(surface: SurfaceId, method: string, params: unknown = {}): Promise<any> {
  const res = await rawPost(
    mcpHarness.endpoint.urls[surface],
    JSON.stringify({ jsonrpc: '2.0', id: mcpHarness.nextId++, method, params })
  );
  return { status: res.status, body: decode(res) };
}

export const core = (method: string, params: unknown = {}): Promise<any> => call('core', method, params);

export const desktop = (method: string, params: unknown = {}): Promise<any> => call('desktop', method, params);

export const { REASONING_EFFORTS } = await import('../../contracts/session.js');

export const PROTOCOL_2026 = '2026-07-28';

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

export const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

/** A 2026-07-28 request: the per-request _meta envelope plus the SEP-2243 standard headers the spec requires the client to mirror the body with. */
export async function modern(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {}
): Promise<any> {
  const body = {
    jsonrpc: '2.0',
    id: mcpHarness.nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL_2026,
        [META_CAPABILITIES]: {}
      }
    }
  };
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': PROTOCOL_2026,
    'Mcp-Method': method,
    ...extraHeaders
  };
  if (method === 'tools/call' && typeof params['name'] === 'string' && !('Mcp-Name' in headers)) {
    headers['Mcp-Name'] = params['name'];
  }
  const res = await rawPost(mcpHarness.endpoint.urls.core, JSON.stringify(body), headers);
  return { status: res.status, headers: res.headers, body: decode(res) };
}

export const toolNames = (reply: any): string[] =>
  ((reply.body?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name).sort();

export const toolList = (reply: any): Array<Record<string, any>> => (reply.body?.result?.tools ?? []) as Array<Record<string, any>>;

export const textOf = (reply: any): string =>
  ((reply.body?.result?.content ?? []) as Array<{ text?: string }>)
    .map((c) => c.text ?? '')
    .join('\n');

export const failed = (reply: any): boolean => reply.body?.error !== undefined || reply.body?.result?.isError === true;

/** A patch that only adds one file, which is the cheapest way to prove apply_patch ran. */
export const addPatch = (virtualPath: string, lines: string[]): string =>
  ['*** Begin Patch', `*** Add File: ${virtualPath}`, ...lines.map((line) => `+${line}`), '*** End Patch'].join('\n');

export function withCaps(overrides: Partial<Capabilities>): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...overrides };
}

/** Everything the user could possibly switch on, which is the worst case for discovery. */
export function allCaps(): Capabilities {
  const caps = { ...DEFAULT_CAPABILITIES };
  for (const key of Object.keys(caps) as Array<keyof Capabilities>) caps[key] = true;
  return caps;
}

beforeAll(async () => {
  mcpHarness.base = await makeTempDir('clf-mcp-');
  // This suite calls real tools, and calling a tool records it. Recording is on by default now, so without a directory of its own the recorder wrote session folders into the process's working directory — which for a test run is the repository.
  initSessionStore(mcpHarness.base);
  mcpHarness.approved = path.join(mcpHarness.base, 'workspace');
  mcpHarness.outside = path.join(mcpHarness.base, 'private');
  await writeTree(mcpHarness.approved, {
    'notes.txt': Array.from({ length: 50 }, (_, i) => `note line ${i + 1}`).join('\n') + '\n',
    'src/app.ts': 'export const name = "app";\n',
    'src/lib/util.ts': 'export const helper = 1;\n',
    'node_modules/pkg/noise.js': 'generated dependency noise\n'
  });
  await writeTree(mcpHarness.outside, { 'passwords.txt': 'hunter2' });
  await fs.writeFile(
    path.join(mcpHarness.approved, 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  );

  mcpHarness.ctx = {
    roots: [{ name: 'workspace', path: mcpHarness.approved }] as Root[],
    caps: withCaps({}),
    readOnly: true,
    // Stated rather than inherited from the saved config. These two are whole features with their own defaults — recording now starts on — and a capability-gating test that silently changes meaning when a product default moves is not testing gating. The tools they add are covered by their own suites.
    sessionTools: false,
    agentTools: false
  };
});

afterAll(async () => {
  if (mcpHarness.endpoint) await mcpHarness.endpoint.stop();
  // Every live exec test uses UnifiedExecProcessManager. The old teardown still stopped the retired connector-native process manager, which meant it looked like this suite protected the fixture from leaked shells while production sessions were completely untouched.
  await unifiedExecManager.terminateAllProcesses();
  await removeTempDir(mcpHarness.base);
});

beforeEach(async () => {
  if (mcpHarness.endpoint) await mcpHarness.endpoint.stop();
  resetWorkspaces();
  mcpHarness.ctx.caps = withCaps({});
  mcpHarness.ctx.readOnly = true;
  mcpHarness.ctx.roots = [{ name: 'workspace', path: mcpHarness.approved }];
  mcpHarness.ctx.sessionTools = false;
  mcpHarness.ctx.agentTools = false;
  getConfig().multiAgent.strictChatAllowlist = false;
  resetTrustedChatsForTests();
  // A fresh endpoint gives every test a new client snapshot while exercising live permission changes.
  mcpHarness.endpoint = await startMcpServer(() => mcpHarness.ctx);
});
