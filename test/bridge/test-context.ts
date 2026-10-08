/** The local bridge, over real HTTP. This server is the one thing in the app a web page could try to reach, and it holds the credential the extension authenticates with, so the tests here are mostly about what it refuses: a page origin, a missing token, a superseded token. The happy paths matter too, but they are the cheap half. */

import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION, BRIDGE_PROTOCOL } from "../../backend/infrastructure/settings/version.js";
import { type SessionEvent } from "../../contracts/session.js";
import type { ContinuationSnapshot } from "../../backend/domains/sessions/continuity/continuation.js";
import type { SwarmSnapshot } from "../../backend/domains/automation/agents.js";
import type { Config } from "../../contracts/types.js";

const recoveryBrowserWake = vi.hoisted(() => vi.fn(async (_url: string, _retry?: boolean, _background?: boolean,
  _authority?: { current(): boolean | Promise<boolean> }) => {}));
vi.mock("../../backend/domains/browser/browser-startup.js", () => ({ wakeBrowserUrl: recoveryBrowserWake }));

async function recordFinalForTest(conversationId: string, turnId: string): Promise<void> {
  await request('POST', '/events', { body: { conversationId, events: [{ kind: 'assistant_message', time: Date.now(),
    turnId, messageId: `final-${turnId}`, text: 'The requested turn is finished.', state: 'final', final: true }] } });
}

// safeStorage only exists inside a running Electron main process. The bridge stores its bearer token through it, so the test provides the same interface, unencrypted.
vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: vi.fn(() => 'unknown'),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value, 'utf8')),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false }))
  },
  clipboard: {},
  shell: {}
}));
const { safeStorage } = await import('electron');

const { defaultConfig, getConfig, initConfigPath, saveConfig } = await import("../../backend/infrastructure/settings/config.js");
const { initSecretsPath, resetSecretsCacheForTests, setSecret } = await import("../../backend/infrastructure/settings/secrets.js");
const {
  bridgePort,
  bridgeStatus,
  companionDiagnostics,
  sessionControlsFor,
  cancelAssistantRecovery,
  onBridgeChange,
  compactSession,
  setSessionObjective,
  unattributedRepairEta,
  cancelResume,
  chatUrl,
  commandUrl,
  pendingCommands,
  queueResume,
  resetBridgeForTests,
  unattributedIncidentsSettledForTests,
  restoreCommands,
  resumeJobFor,
  setBrowserOpener,
  shutdownBridge,
  STALE_SWARM_MS,
  CHAT_SILENCE_MS,
  GOAL_QUIET_MS,
  PRO_SILENCE_MS,
  DELIBERATE_SILENCE_MS,
  PRO_ACTIVITY_MS,
  COMMAND_DEADLINE_MS,
  REVIVAL_ACTIVITY_MS,
  REVIVAL_DEADLINE_MS,
  WORKER_BOOTSTRAP_LIMIT_MS,
  WORKER_REDEEM_MS,
  BROWSER_RECOVERY_COOLDOWN_MS,
  DEFAULT_PORTS,
  revealChatInBrowser,
  startBridge,
  stopBridge,
  sweepStaleSwarm,
  unpair
} = await import("../../backend/domains/browser/bridge.js");
const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import("../../backend/persistence/durable.js");
const { setStuckNotifier } = await import("../../backend/infrastructure/desktop-shell/stuck-notice.js");
const {
  GOAL_OBJECTIVES_STATE,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  goalDrivingMode,
  goalObjectiveFor,
  goalDraftBusy,
  goalPendingReplyFor,
  acceptGoalReplyNow,
  setGoalReplyActiveNow,
  goalSwitchFor,
  resetGoalStateForTests,
  setGoalObjective
} = await import("../../backend/domains/automation/goal.js");
const { completeProcessCall, createSession, deleteSession, findSessionByConversation, getSession,
  initSessionStore, readEvents, recordProcessCall, resetSessionStoreForTests } = await import(
  "../../backend/domains/sessions/history/store.js"
);
const sessionStoreModule = await import("../../backend/domains/sessions/history/store.js");
const { closeConversation, liveConversations, noteChatOrigin, recordChatObservations, recordProgress, recordToolCall, REQUEST_ID_GRACE_MS, resetRecorderForTests } = await import("../../backend/domains/sessions/history/recorder.js");
const { requestCorrelation, resetCorrelationRegistryForTests, restoreRequestCorrelations } = await import("../../backend/domains/sessions/history/correlation.js");
const { resetBlockedChatsForTests, setChatBlocked } = await import("../../backend/domains/sessions/continuity/blocked-chats.js");
const {
  CONTINUATIONS_STATE,
  abortContinuation,
  attachSummary,
  claimContinuationNow,
  commitContinuation,
  continuationByToken,
  continuationForSession,
  openContinuationNow,
  setContinuationRecoveryHooks,
  restoreContinuations
} = await import("../../backend/domains/sessions/continuity/continuation.js");
const {
  acknowledgeOffers,
  agentInfoForOwnedConversation,
  PRIME_ID,
  beginPrimeTransfer,
  commitPrimeTransfer,
  bindConversation,
  cancelPrimeTransfer,
  finishAgent,
  currentRunId,
  WORKER_SILENCE_MS,
  noteAgentAlive,
  noteAgentContextTokens,
  noteWorkerRevived,
  offerMessages,
  pendingWorkerRevivals,
  repairPrimeConversationAfterRecovery,
  requestWorkerBootstraps,
  requestWorkerRevivals,
  spawn,
  stageMessages,
  pendingWorkerSpawns,
  releaseQuiescentRun,
  onSwarmPersistNow,
  persistCriticalSwarmNow,
  retiredWorkerForConversation,
  resetSwarm,
  restoreSwarm,
  snapshotSwarm,
  swarmState,
  swarmStateForCaller,
  WORKER_CONTEXT_CEILING_TOKENS,
  workerConversationGone
} = await import(
  "../../backend/domains/automation/agents.js"
);
const { makeTempDir, removeTempDir, SAMPLE_BRIEF, faultGate } = await import('../helpers.js');
const { resumeBootstrapText } = await import("../../backend/domains/sessions/continuity/handoff.js");
const { getLog } = await import("../../backend/infrastructure/settings/logger.js");
const { setShippedExtensionBuildForTest } = await import("../../backend/domains/browser/extension-path.js");
const { requestProviderPageComplete, resetProviderPageForTests } = await import("../../backend/domains/providers/provider-page.js");

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
/** The chat that spawns the swarm in these tests: only a proven conversation can. */
const PRIME_CHAT = 'c-prime-bridge';
/** The chat a worker lands in when its bootstrap ACK is lost and `/events` binds it instead. */
const LOST_ACK_CHAT = 'bcbcbcbc-1111-2222-3333-444444444444';

/** A continuation that has already been given its brief, ready to be queued. `queueResume` takes the transaction's one-time token, not a handoff id: the brief the fresh chat is typed lives in the transaction, and the command carries only the right to claim it. So a queued resume in these tests has to be a real one. */
async function readyContinuation(sessionId: string, brief: string, from = 'c-compacted'): Promise<string> {
  const opened = await openContinuationNow(sessionId, from);
  // The caller's line is what its assertions look for; the rest is there because the app refuses a brief too short to have carried a session across. See SAMPLE_BRIEF.
  const stored = await attachSummary(opened.token, `${brief}

${SAMPLE_BRIEF}`);
  expect(stored, 'the brief was not stored, so there is no resume to queue').not.toBeNull();
  return opened.token;
}

/** A session really attached to a chat, compacted, with its brief already written. The commit rebinds the session from chat A to chat B, so chat A has to be a chat this session is actually in — a bare `createSession` has no conversation to move away from and every commit against it is refused. */
async function compactedSession(from: string, brief: string): Promise<{ sessionId: string; token: string }> {
  const reply = await request('POST', '/events', {
    body: {
      conversationId: from,
      events: [{ kind: 'user_message', time: Date.now(), text: 'do the work', messageId: `m-${from}` }]
    }
  });
  const sessionId = reply.body.sessionId as string;
  expect(sessionId, 'the chat was not recorded, so there is no session to compact').toBeTruthy();
  return { sessionId, token: await readyContinuation(sessionId, brief, from) };
}

/** The same, but the ticket the app files for itself rather than one the user asked for. Automatic tickets take a different failure path: a manual resume that never reports back is aborted, an automatic one keeps its ticket for a later pickup. Only the automatic one can reach the state this file's claim test is about. */
async function automaticCompactedSession(from: string, brief: string): Promise<{ sessionId: string; token: string }> {
  const reply = await request('POST', '/events', {
    body: {
      conversationId: from,
      events: [{ kind: 'user_message', time: Date.now(), text: 'do the work', messageId: `m-${from}` }]
    }
  });
  const sessionId = reply.body.sessionId as string;
  expect(sessionId, 'the chat was not recorded, so there is no session to compact').toBeTruthy();
  const ticket = await openContinuationNow(sessionId, from, true);
  const stored = await attachSummary(ticket.token, `${brief}

${SAMPLE_BRIEF}`);
  expect(stored, 'the brief was not stored, so there is no resume to queue').not.toBeNull();
  return { sessionId, token: ticket.token };
}

/** Every URL the app asked the OS to open, in order. Stands in for Electron's shell. */
const opened: string[] = [];

let dir: string;
const bridgeState: { base: string; token: string | null; anonymousRedeemIndex: number } = { base: '', token: null, anonymousRedeemIndex: 0 };


interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
}

function request(
  method: string,
  path: string,
  options: { body?: unknown; origin?: string | null; auth?: string | null; raw?: string; extensionVersion?: string; protocol?: number; extensionBuild?: string; browser?: string; host?: string } = {}
): Promise<Reply> {
  const url = new URL(path, bridgeState.base);
  const payload = options.raw ?? (options.body === undefined ? null : JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  // Every extension request carries its protocol generation. Pairing must fail closed across incompatible app/extension builds instead of provisioning a token that can only produce confusing downstream failures.
  headers['x-extension-version'] = options.extensionVersion ?? APP_VERSION;
  headers['x-extension-protocol'] = String(options.protocol ?? BRIDGE_PROTOCOL);
  if (options.extensionBuild) headers['x-extension-build'] = options.extensionBuild;
  if (options.browser) headers['x-extension-browser'] = options.browser;
  if (options.host) headers['x-extension-host'] = options.host;
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  // `origin: null` means "send no Origin header", which is what Chrome does for an extension fetch to a host it already holds permission for.
  if (options.origin !== null) headers['origin'] = options.origin ?? EXTENSION_ORIGIN;
  const auth = options.auth === undefined ? bridgeState.token : options.auth;
  if (auth) headers['authorization'] = `Bearer ${auth}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: any = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            // Leave it as text; a non-JSON body is itself a finding.
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Sends from the prime exactly the way the `agents` tool does. A message crosses its durable barrier first and is published second; only then may the browser be asked to reopen anybody's chat. Doing those two steps in this order here is what makes these tests exercise the real wake path rather than a shortcut into it. */
function wake(items: ReadonlyArray<{ to: string; text: string }>): void {
  const staged = stageMessages({ conversationId: PRIME_CHAT }, items);
  staged.commit();
  if (staged.waking.length > 0) requestWorkerRevivals(staged.waking);
}

async function waitForOpened(count = 1): Promise<void> {
  await vi.waitFor(() => expect(opened).toHaveLength(count));
}

async function waitForRevival(): Promise<{ id: string; conversationId: string }> {
  let revival: { id: string; conversationId: string } | null = null;
  await vi.waitFor(async () => {
    const status = await request('GET', '/status');
    revival = status.body.revival ?? null;
    expect(revival).toMatchObject({ id: expect.any(String), conversationId: expect.any(String) });
  });
  return revival!;
}

/** The one page the app opened, redeeming the one command it was opened for. The only way a bootstrap reaches a browser now. There is no listing route and no poll: a command is delivered to the page holding its marker, or it is not delivered at all. */
async function redeem(id?: string, client = 'tab-1'): Promise<any> {
  if (!id) {
    const index = bridgeState.anonymousRedeemIndex++;
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(index));
    id = new URL(opened[index]!).searchParams.get('neuraflok-command')!;
  }
  const reply = await request('POST', '/commands/redeem', { body: { id, client } });
  expect(reply.status, `redeem ${id} failed: ${JSON.stringify(reply.body)}`).toBe(200);
  return reply.body.command;
}

/** Connects the way the extension does, and remembers the token for later requests. */
/** The configuration every test starts from; see beforeAll. */
let suiteConfig: Config;

async function pair(): Promise<string> {
  const reply = await request('POST', '/pair', { auth: null });
  expect(reply.status).toBe(200);
  const pairedToken = reply.body.token as string;
  bridgeState.token = pairedToken;
  return pairedToken;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-bridge-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
  const baseConfig = defaultConfig();
  suiteConfig = {
    ...baseConfig,
    sessions: { ...baseConfig.sessions, record: true },
    // Isolate legacy tab/Goal recovery; automatic Continue is covered by input integration.
    ui: { ...baseConfig.ui, autoContinue: false },
    multiAgent: { ...baseConfig.multiAgent, enabled: true, recoverAgentTabs: true }
  };
  await saveConfig(suiteConfig);
  const port = await startBridge();
  expect(port, 'no loopback port in 8765-8769 was free').not.toBeNull();
  bridgeState.base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await stopBridge();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  recoveryBrowserWake.mockClear();
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  // A test that writes its own config is not allowed to leak it into the next one.
  await saveConfig(suiteConfig);
  // The swarm goes first: ending a run queues stop notices into the chats of any workers still live, and those would otherwise be dropped into the queue the bridge reset had just emptied — the previous test's cleanup showing up as the next test's first command.
  resetSwarm();
  resetBridgeForTests();
  opened.length = 0;
  bridgeState.anonymousRedeemIndex = 0;
  // The app opens the chat itself, always: there is no queue for a tab to come and ask. Tests that need the open to fail replace this with their own opener.
  setBrowserOpener(async (url) => {
    opened.push(url);
  });
  resetRecorderForTests();
  writeDurableSoon('bridge-commands', null);
  await flushDurable();
  await setSecret('bridgeToken', '');
  bridgeState.token = null;
});

// ------------------------------------------------------------------ origin



export {
  abortContinuation,
  acceptGoalReplyNow,
  acknowledgeOffers,
  afterAll,
  afterEach,
  agentInfoForOwnedConversation,
  attachSummary,
  automaticCompactedSession,
  beforeAll,
  beforeEach,
  beginPrimeTransfer,
  bindConversation,
  bridgePort,
  bridgeState,
  bridgeStatus,
  BROWSER_RECOVERY_COOLDOWN_MS,
  cancelAssistantRecovery,
  cancelPrimeTransfer,
  cancelResume,
  CHAT_SILENCE_MS,
  chatUrl,
  claimContinuationNow,
  closeConversation,
  COMMAND_DEADLINE_MS,
  commandUrl,
  commitContinuation,
  commitPrimeTransfer,
  compactedSession,
  compactSession,
  companionDiagnostics,
  completeProcessCall,
  continuationByToken,
  continuationForSession,
  CONTINUATIONS_STATE,
  createSession,
  currentRunId,
  DEFAULT_PORTS,
  defaultConfig,
  deleteSession,
  DELIBERATE_SILENCE_MS,
  describe,
  dir,
  expect,
  EXTENSION_ORIGIN,
  faultGate,
  findSessionByConversation,
  finishAgent,
  flushDurable,
  getConfig,
  getLog,
  getSession,
  GOAL_OBJECTIVES_STATE,
  GOAL_QUIET_MS,
  GOAL_REPLIES_STATE,
  GOAL_SWITCHES_STATE,
  goalDraftBusy,
  goalDrivingMode,
  goalObjectiveFor,
  goalPendingReplyFor,
  goalSwitchFor,
  initConfigPath,
  initDurableStore,
  initSecretsPath,
  initSessionStore,
  it,
  liveConversations,
  LOST_ACK_CHAT,
  makeTempDir,
  noteAgentAlive,
  noteAgentContextTokens,
  noteChatOrigin,
  noteWorkerRevived,
  offerMessages,
  onBridgeChange,
  onSwarmPersistNow,
  openContinuationNow,
  opened,
  pair,
  pendingCommands,
  pendingWorkerRevivals,
  pendingWorkerSpawns,
  persistCriticalSwarmNow,
  PRIME_CHAT,
  PRIME_ID,
  PRO_ACTIVITY_MS,
  PRO_SILENCE_MS,
  queueResume,
  readDurable,
  readEvents,
  readyContinuation,
  recordChatObservations,
  recordFinalForTest,
  recordProcessCall,
  recordProgress,
  recordToolCall,
  recoveryBrowserWake,
  redeem,
  releaseQuiescentRun,
  removeTempDir,
  repairPrimeConversationAfterRecovery,
  request,
  REQUEST_ID_GRACE_MS,
  requestCorrelation,
  requestProviderPageComplete,
  requestWorkerBootstraps,
  requestWorkerRevivals,
  resetBlockedChatsForTests,
  resetBridgeForTests,
  resetCorrelationRegistryForTests,
  resetGoalStateForTests,
  resetProviderPageForTests,
  resetRecorderForTests,
  resetSecretsCacheForTests,
  resetSessionStoreForTests,
  resetSwarm,
  restoreCommands,
  restoreContinuations,
  restoreRequestCorrelations,
  restoreSwarm,
  resumeBootstrapText,
  resumeJobFor,
  retiredWorkerForConversation,
  revealChatInBrowser,
  REVIVAL_ACTIVITY_MS,
  REVIVAL_DEADLINE_MS,
  safeStorage,
  SAMPLE_BRIEF,
  saveConfig,
  sessionControlsFor,
  sessionStoreModule,
  setBrowserOpener,
  setChatBlocked,
  setContinuationRecoveryHooks,
  setGoalObjective,
  setGoalReplyActiveNow,
  setSecret,
  setSessionObjective,
  setShippedExtensionBuildForTest,
  setStuckNotifier,
  shutdownBridge,
  snapshotSwarm,
  spawn,
  stageMessages,
  STALE_SWARM_MS,
  startBridge,
  stopBridge,
  suiteConfig,
  swarmState,
  swarmStateForCaller,
  sweepStaleSwarm,
  unattributedIncidentsSettledForTests,
  unattributedRepairEta,
  unpair,
  vi,
  waitForOpened,
  waitForRevival,
  wake,
  WORKER_BOOTSTRAP_LIMIT_MS,
  WORKER_CONTEXT_CEILING_TOKENS,
  WORKER_REDEEM_MS,
  WORKER_SILENCE_MS,
  workerConversationGone,
  writeDurableNow,
  writeDurableSoon
};
export type { Config, ContinuationSnapshot, Reply, SessionEvent, SwarmSnapshot };
