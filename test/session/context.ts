import { afterAll, beforeAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { positionOf } from '../../contracts/chronology.js';
import sharp from 'sharp';
import { defaultConfig, initConfigPath, saveConfig } from '../../backend/infrastructure/settings/config.js';
import { lineDelta, formatDelta } from '../../backend/domains/workspace/diffstat.js';
import { emptyEvidence } from '../../backend/infrastructure/tool-gateway/protocol/call-context.js';
import { getLog } from '../../backend/infrastructure/settings/logger.js';
import { userTitle } from '../../backend/domains/sessions/history/title.js';
import {
  closeConversation,
  liveConversations,
  noteChatOrigin,
  recordChatObservations,
  recordToolCall,
  repairDeterministicAttribution,
  rebindConversation,
  resetRecorderForTests,
  sessionForConversation,
} from '../../backend/domains/sessions/history/recorder.js';
import {
  appendEvent,
  autoCompactionReady,
  observeSessionModel,
  recordWorkerAssignment,
  createSession,
  deleteSession,
  endSession,
  flushSessions,
  findSessionByConversation,
  getSession,
  initSessionStore,
  latestHandoff,
  listSessions,
  MAX_ASSET_BYTES,
  pruneSessions,
  readAsset,
  readEvents,
  readActivityEvents,
  readRecentEvents,
  readToolEditReview,
  readLatestUserMessage,
  turnHasMcpCall,
  conversationHasMcpCallSince,
  readHandoff,
  rebindSession,
  renameSession,
  clearSessionName,
  reopenSession,
  resetSessionStoreForTests,
  rewriteUnattributedToolCalls,
  saveHandoff,
  sessionsRoot,
  unsetSessionRootForTests,
  upsertMessageEvent,
  writeAsset
} from '../../backend/domains/sessions/history/store.js';
import { summarizeToolCall } from '../../backend/domains/sessions/history/summarize.js';
import { nativeHandoffPrompt } from '../../backend/domains/sessions/continuity/handoff-prompt.js';
import { DEFAULT_HANDOFF_PROMPT } from '../../contracts/sessions/continuity-brief.js';
import {
  CHAT_ACTIVE_MS,
  CHAT_SILENCE_MS,
  estimateTokens,
  eventTokens,
  foldProgress,
  originTitle,
  tokenPressure,
  type SessionEvent,
  type SessionOrigin,
  type ToolOutcome
} from '../../contracts/session.js';
import { makeTempDir, removeTempDir } from '../helpers.js';
export {
  CHAT_ACTIVE_MS,
  CHAT_SILENCE_MS,
  DEFAULT_HANDOFF_PROMPT,
  MAX_ASSET_BYTES,
  appendEvent,
  autoCompactionReady,
  clearSessionName,
  closeConversation,
  conversationHasMcpCallSince,
  createHash,
  createSession,
  defaultConfig,
  deleteSession,
  emptyEvidence,
  endSession,
  estimateTokens,
  eventTokens,
  findSessionByConversation,
  flushSessions,
  foldProgress,
  formatDelta,
  fs,
  getLog,
  getSession,
  initConfigPath,
  initSessionStore,
  latestHandoff,
  lineDelta,
  listSessions,
  liveConversations,
  makeTempDir,
  nativeHandoffPrompt,
  noteChatOrigin,
  observeSessionModel,
  originTitle,
  path,
  positionOf,
  pruneSessions,
  readActivityEvents,
  readAsset,
  readEvents,
  readHandoff,
  readLatestUserMessage,
  readRecentEvents,
  readToolEditReview,
  rebindConversation,
  rebindSession,
  recordChatObservations,
  recordToolCall,
  recordWorkerAssignment,
  removeTempDir,
  renameSession,
  reopenSession,
  repairDeterministicAttribution,
  resetRecorderForTests,
  resetSessionStoreForTests,
  rewriteUnattributedToolCalls,
  saveConfig,
  saveHandoff,
  sessionForConversation,
  sessionsRoot,
  sharp,
  summarizeToolCall,
  tokenPressure,
  turnHasMcpCall,
  unsetSessionRootForTests,
  upsertMessageEvent,
  userTitle,
  writeAsset,
};
export type {
  SessionEvent,
  SessionOrigin,
  ToolOutcome,
};

export let dir: string;

export async function enableRecording(record = true): Promise<void> {
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-session-');
  initConfigPath(dir);
  initSessionStore(dir);
  await enableRecording();
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetRecorderForTests();
  resetSessionStoreForTests();
});

export const evidence = (patch: Partial<ReturnType<typeof emptyEvidence>> = {}) => ({ ...emptyEvidence(), ...patch });
