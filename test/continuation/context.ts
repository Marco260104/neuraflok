import { promises as fs } from 'node:fs';

import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

export { fs, path };

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  },
  clipboard: { readText: () => '', writeText: () => undefined },
  shell: { openExternal: async () => undefined }
}));

export const { defaultConfig, initConfigPath, saveConfig } = await import('../../backend/infrastructure/settings/config.js');

export const {
  beginPrimeTransfer,
  bindConversation,
  cancelPrimeTransfer,
  commitPrimeTransfer,
  finishAgent,
  freezePrimeTransfer,
  noteAgentContextTokens,
  pendingWorkerRevivals,
  primeConversation,
  primeConversationGone,
  releaseQuiescentRun,
  repairPrimeConversationAfterRecovery,
  resetAgentsForTests,
  sendMessage,
  snapshotSwarm,
  restoreSwarm,
  spawn,
  swarmRunning,
  swarmStateForCaller,
  thawPrimeTransfer,
  WORKER_CONTEXT_CEILING_TOKENS
} = await import('../../backend/domains/automation/agents.js');

export const {
  AUTOMATIC_HANDOVER_TTL_MS,
  CONTINUATION_PRO_WRITING_TTL_MS,
  CONTINUATION_TTL_MS,
  CONTINUATION_WRITING_TTL_MS,
  abortContinuation,
  abortContinuationNow,
  abortContinuationSourceBeforeSendNow,
  attachSummary,
  beginContinuationDestinationSendNow,
  beginContinuationSourceSendNow,
  bindContinuationSourceMessageNow,
  bindContinuationDestinationMessageNow,
  claimContinuationNow,
  commitContinuation,
  compactingConversation,
  continuationByToken,
  continuationForSession,
  dispatchContinuationDestinationSendNow,
  dispatchContinuationSourceSendNow,
  openContinuationNow,
  releaseContinuationDestinationSendNow,
  repairPrimeFromResumeShadow,
  resetContinuationsForTests,
  restoreContinuations,
  setContinuationRecoveryHooks,
  snapshotContinuations,
  supersededSourceConversations
} = await import('../../backend/domains/sessions/continuity/continuation.js');

export const { REPLACEMENT_CHAT_CLAIM_WINDOW_MS, hasPendingReplacementChat } = await import('../../backend/domains/sessions/continuity/replacement-chat-gate.js');

export const { briefShortfall, handoffContinuationId, prepareHandoff, resumeBootstrapText } = await import('../../backend/domains/sessions/continuity/handoff.js');

export const { createSession, getSession, initSessionStore, resetSessionStoreForTests, sessionsRoot } = await import(
  '../../backend/domains/sessions/history/store.js'
);

export const store = await import('../../backend/domains/sessions/history/store.js');

export const { recordChatObservations, resetRecorderForTests, sessionForConversation } = await import('../../backend/domains/sessions/history/recorder.js');

export const { resetWorkspaces, setWorkspaceFor, workspaceEntries } = await import('../../backend/domains/workspace/workspace.js');

export const {
  goalObjectiveFor,
  goalPendingReplyFor,
  goalSwitchFor,
  restoreGoalReplies,
  setGoalSwitchNow,
  resetGoalStateForTests,
  setGoalObjective
} = await import('../../backend/domains/automation/goal.js');

export const { makeTempDir, removeTempDir, SAMPLE_BRIEF } = await import('../helpers.js');

export let dir: string;

export async function attachedChat(sessionId: string): Promise<string | null> {
  return (await getSession(sessionId))?.conversationId ?? null;
}

export async function handoffCount(sessionId: string): Promise<number> {
  try {
    return (await fs.readdir(path.join(sessionsRoot(), sessionId, 'handoffs'))).length;
  } catch {
    return 0;
  }
}

export const CHAT_A = 'chat-a';

export const CHAT_B = 'chat-b';

export const CHAT_C = 'chat-c';

beforeAll(async () => {
  dir = await makeTempDir('clf-continuation-');
  initConfigPath(dir);
  initSessionStore(dir);
  const config = defaultConfig();
  await saveConfig({ ...config, multiAgent: { ...config.multiAgent, enabled: true, maxWorkers: 3 } });
});

afterAll(async () => {
  await removeTempDir(dir);
});

beforeEach(async () => {
  resetContinuationsForTests();
  resetAgentsForTests();
  resetRecorderForTests();
  resetWorkspaces();
  resetGoalStateForTests();
  await resetSessionStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

export async function readyContinuation(): Promise<{ sessionId: string; token: string }> {
  const summary = await createSession({ title: 'work', conversationId: CHAT_A });
  const opened = await openContinuationNow(summary.id, CHAT_A);
  await attachSummary(opened.token, SAMPLE_BRIEF);
  return { sessionId: summary.id, token: opened.token };
}
