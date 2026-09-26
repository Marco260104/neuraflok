// Blocks one exact conversation from local tool access until the user releases it.

import { readDurable, writeDurableSoon } from '../../../persistence/durable.js';

/** A hand-curated list, so the ceiling only exists to keep a corrupt or hostile state file from growing without bound. Reaching it is a real error the user sees, never a silent eviction: evicting the oldest entry would quietly unblock a chat the user stopped on purpose. */
const MAX_BLOCKED_CHATS = 200;
const BLOCKED_STATE = 'blocked-chats';
const BLOCKED_STATE_VERSION = 1;

interface PersistedBlocks {
  version: number;
  entries: Array<{ conversationId: string; blockedAt: number }>;
}

type BlockRegistryState = {
  entries: Map<string, number>;
  restored: boolean;
  restore: Promise<void> | null;
};

const registry: BlockRegistryState = {
  entries: new Map(),
  restored: false,
  restore: null
};

/** The one thing a blocked chat's model is told, on every tool it tries. Written as an instruction rather than a diagnosis because the model is the only party that can end the turn: it names the state, forbids the retry loop a bare failure invites, and asks for the one action that finishes — a final answer. `CHAT_BLOCKED:` matches the prefix convention the other kernel refusals use. */
export const BLOCKED_CHAT_REFUSAL =
  'CHAT_BLOCKED: the user blocked this conversation from using local tools, and no tool was run. ' +
  'This session went rogue. Stop right now: abandon the task, make no further tool calls of any ' +
  'kind, and reply to the user immediately with your final answer. The user explicitly asked for this.';

function snapshot(): PersistedBlocks {
  return {
    version: BLOCKED_STATE_VERSION,
    entries: [...registry.entries].map(([conversationId, blockedAt]) => ({ conversationId, blockedAt }))
  };
}

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{8,64}$/i.test(value);
}

/** Loads the blocked set before the MCP endpoint can accept a call. A block that arrives one call late is a block the rogue turn got one more tool out of, so this runs alongside the correlation restore rather than lazily on first use. */
export function restoreBlockedChats(): Promise<void> {
  if (registry.restored) return Promise.resolve();
  if (registry.restore) return registry.restore;
  const reading = (async () => {
    const saved = await readDurable<PersistedBlocks>(BLOCKED_STATE);
    if (saved?.version === BLOCKED_STATE_VERSION && Array.isArray(saved.entries)) {
      for (const entry of saved.entries.slice(0, MAX_BLOCKED_CHATS)) {
        if (!entry || typeof entry !== 'object') continue;
        const { conversationId, blockedAt } = entry as { conversationId?: unknown; blockedAt?: unknown };
        if (!validConversationId(conversationId) || registry.entries.has(conversationId)) continue;
        registry.entries.set(conversationId, typeof blockedAt === 'number' && Number.isFinite(blockedAt) ? blockedAt : Date.now());
      }
    }
    registry.restored = true;
  })();
  const shared = reading.finally(() => {
    if (registry.restore === shared) registry.restore = null;
  });
  registry.restore = shared;
  return shared;
}

/** Whether any block exists at all. The kernel's cheap way to ask whether it is worth resolving a call's identity before deciding — see the block gate in kernel.ts. An install with no blocked chat pays one map read per call and never waits on the browser for this. */
export function anyChatBlocked(): boolean {
  return registry.entries.size > 0;
}

/** Exact lookup. An unproven caller has no conversation and is therefore never blocked. */
export function isChatBlocked(conversationId: string | null | undefined): boolean {
  return conversationId !== null && conversationId !== undefined && registry.entries.has(conversationId);
}

/** Every blocked conversation, so one renderer paint can mark all of its rows at once. */
export function blockedChatIds(): string[] {
  return [...registry.entries.keys()];
}

/** The user's existing durable block time, for retiring its browser page after a quiet grace. */
export function chatBlockedAt(conversationId: string): number | null {
  return registry.entries.get(conversationId) ?? null;
}

/** Blocks or releases one conversation. Idempotent in both directions: the user pressing the button twice must not move a block's timestamp or resurrect a released one. */
export function setChatsBlocked(conversationIds: readonly string[], next: boolean): void {
  const ids = [...new Set(conversationIds)];
  if (ids.length === 0 || ids.some((conversationId) => !validConversationId(conversationId))) {
    throw new Error('Invalid conversation ID');
  }
  const additions = next ? ids.filter((conversationId) => !registry.entries.has(conversationId)) : [];
  if (next && registry.entries.size + additions.length > MAX_BLOCKED_CHATS) {
    throw new Error(`Too many blocked chats (${MAX_BLOCKED_CHATS}). Release one before blocking another.`);
  }
  const changed = next ? additions.length > 0 : ids.some((conversationId) => registry.entries.has(conversationId));
  if (!changed) return;
  if (next) {
    const blockedAt = Date.now();
    for (const conversationId of additions) registry.entries.set(conversationId, blockedAt);
  } else {
    for (const conversationId of ids) registry.entries.delete(conversationId);
  }
  writeDurableSoon(BLOCKED_STATE, snapshot());
}

export function setChatBlocked(conversationId: string, next: boolean): void {
  setChatsBlocked([conversationId], next);
}

export function resetBlockedChatsForTests(): void {
  registry.entries.clear();
  registry.restored = false;
  registry.restore = null;
}
