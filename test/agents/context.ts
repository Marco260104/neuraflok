import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Caller } from '../../backend/domains/automation/agents.js';
import type { ToolContext } from '../../backend/infrastructure/tool-gateway/protocol/kernel.js';
export { http, fs, path };
export type { Caller, ToolContext };

export const { defaultConfig, initConfigPath, saveConfig } = await import('../../backend/infrastructure/settings/config.js');

export const {
  AgentError,
  archiveWorkerAssignments,
  PRIME_ID,
  acknowledgeOffers,
  acknowledgeOffersForConversation,
  bindConversation,
  closableWorkerConversations,
  clearAgent,
  claimWorkerRevival,
  currentRunId,
  dormantWorkerNotice,
  reactivateDormantRunForConversation,
  recoverSilentCeilingWorker,
  silentCeilingRecoveryAuthority,
  silentCeilingRecoveryTurn,
  failAgent,
  finishAgent,
  finishWorkerConversation,
  identify,
  offerMessages,
  offerMessagesForConversation,
  onSpawnRequest,
  onSwarmEnd,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingCount,
  pendingWorkerSpawns,
  pauseSwarmForDisable,
  WORKER_SILENCE_MS,
  PAGE_GENERATING_FRESH_MS,
  WORKER_THINKING_MAX_MS,
  notePageGenerating,
  endedWorkerNotice,
  sleepSilentWorkers,
  sleepWorker,
  noteAgentAlive,
  noteAgentContextTokens,
  failWorkerRevival,
  isWorkerConversation,
  WAKE_FAILURES_BEFORE_GIVING_UP,
  noteWorkerRevived,
  onReviveRequest,
  pendingWorkerRevivals,
  primeConversationGone,
  primeForOwnedConversation,
  WORKER_CONTEXT_CEILING_TOKENS,
  freeWorkerSlots,
  releaseQuiescentRun,
  repairPrimeConversationAfterRecovery,
  retiredWorkerForConversation,
  restoreRetiredWorkers,
  rollbackWorkerRevivalClaim,
  persistCriticalSwarmNow,
  resetAgentsForTests,
  resetSwarm,
  restoreSwarm,
  sendMessage,
  stageQueuedWorkerRevivals,
  stageFinishAgent,
  stageWorkerConversationFinish,
  stageMessages,
  stagePrimeMessage,
  stageSpawn,
  snapshotSwarm,
  spawn,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
  statusForCaller,
  waitingForSubAgents,
  workerPrimeOwner,
  workerConversationGone,
  workerRevivalClaimed
} = await import('../../backend/domains/automation/agents.js');

export const { startMcpServer } = await import('../support/mcp-server.js');

export const { runningToolCalls } = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');

export const { flushDurable, initDurableStore, readDurable, writeDurableNow, writeDurableSoon } = await import('../../backend/persistence/durable.js');

export const { createSession, getSession, findSessionByConversation, initSessionStore, readRecentEvents, requestTurnOwnershipCutoff, resetSessionStoreForTests } = await import(
  '../../backend/domains/sessions/history/store.js'
);

export const { recordChatObservations, resetRecorderForTests } = await import('../../backend/domains/sessions/history/recorder.js');

export const { resetWorkspaces, setWorkspaceFor, workspaceForChat } = await import('../../backend/domains/workspace/workspace.js');

export const { DEFAULT_CAPABILITIES } = await import('../../contracts/types.js');

export const { makeTempDir, removeTempDir } = await import('../helpers.js');

export let dir: string;

export async function setEnabled(
  enabled: boolean,
  maxWorkers = 3,
  allowUnattributedCalls = false,
  globalMaxWorkers = 0
): Promise<void> {
  const base = defaultConfig();
  await saveConfig({
    ...base,
    multiAgent: { ...base.multiAgent, enabled, maxWorkers, allowUnattributedCalls, globalMaxWorkers }
  });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-agents-');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
  await setEnabled(true);
});

afterAll(async () => {
  resetAgentsForTests();
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetAgentsForTests();
  resetRecorderForTests();
  resetWorkspaces();
  // The real app wires the broker's immediate persistence sink during startup. MCP endpoint tests exercise that production contract rather than an intentionally half-wired broker; durability-specific cases below replace this no-op sink with controlled writers.
  onSwarmPersistNow(async () => undefined);
});

export const PRIME_CHAT = 'c-prime';

export const prime: Caller = { conversationId: PRIME_CHAT };

/** A read of `/anything` that actually reached the sandbox and was refused on roots. The wording is platform-shaped and both spellings have to be here. On Windows `/anything` is a virtual path whose first segment names no approved root, so `sandbox.ts` answers `Unknown root "/anything"`. On macOS and Linux the same string is a native absolute path, which takes the containment branch instead and answers that it is not inside an approved folder. Matching only the Windows half asserts the host, not the behaviour — the point of these assertions is that the call ran and failed honestly about roots rather than being stopped at the identity fence. */
export const REFUSED_ON_ROOTS = /unknown root|not found|not inside an approved folder/i;

export interface StartedSwarm {
  prime: Caller;
  spawned: Array<{ id: string; task: string }>;
}

/** Prime + n workers, without opening any browser tabs. */
export function startSwarm(count = 2, caller: Caller = prime): StartedSwarm {
  const spawned: Array<{ id: string; task: string }> = [];
  onSpawnRequest((workers) => spawned.push(...workers));
  const result = spawn({
    workers: Array.from({ length: count }, (_, i) => ({ label: `Worker ${i + 1}`, task: `task ${i + 1}` })),
    caller
  });
  expect(result.becamePrime).toBe(true);
  return { prime: caller, spawned };
}

/** A worker started the way the app makes it happen: the extension reports the chat it opened, and that binding is the whole of it. No join, no key, nothing typed by a model. */
export function startWorker(id: string, conversationId = `c-${id}`): { caller: Caller } {
  expect(bindConversation(id, conversationId)).toBe(true);
  return { caller: { conversationId } };
}

/** Fills a worker's chat past the context ceiling. The one thing that makes a worker's next stop permanent, and the only way a test reaches a genuinely terminal worker now that reporting means sleeping. Measured from the app's own session record in production; here the same broker entry point is called directly. */
export function fillContext(conversationId: string): void {
  noteAgentContextTokens(conversationId, WORKER_CONTEXT_CEILING_TOKENS);
}

