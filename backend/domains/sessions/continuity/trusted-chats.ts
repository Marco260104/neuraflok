import { readDurable, writeDurableNow, writeDurableSoon } from '../../../persistence/durable.js';

const MAX_TRUSTED_CHATS = 200;
const TRUSTED_STATE = 'trusted-chats';
const TRUSTED_STATE_VERSION = 1;

interface PersistedTrustedChats {
  version: number;
  entries: string[];
}

type RegistryState = {
  entries: Set<string>;
  loaded: boolean;
  restore: Promise<void> | null;
  writes: Promise<void>;
};

const registry: RegistryState = {
  entries: new Set(),
  loaded: false,
  restore: null,
  writes: Promise.resolve()
};

function validConversationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{8,64}$/i.test(value);
}

function snapshot(entries: ReadonlySet<string>): PersistedTrustedChats {
  return { version: TRUSTED_STATE_VERSION, entries: [...entries] };
}

function restoreEntries(saved: PersistedTrustedChats | null): Set<string> {
  const entries = new Set<string>();
  if (!saved || saved.version !== TRUSTED_STATE_VERSION || !Array.isArray(saved.entries)) return entries;
  for (const id of saved.entries.slice(0, MAX_TRUSTED_CHATS)) {
    if (validConversationId(id)) entries.add(id);
  }
  return entries;
}

export function restoreTrustedChats(): Promise<void> {
  if (registry.loaded) return Promise.resolve();
  if (registry.restore) return registry.restore;
  const reading = (async () => {
    const entries = restoreEntries(await readDurable<PersistedTrustedChats>(TRUSTED_STATE));
    registry.entries = entries;
    registry.loaded = true;
  })();
  const shared = reading.finally(() => {
    if (registry.restore === shared) registry.restore = null;
  });
  registry.restore = shared;
  return shared;
}

export function isChatTrusted(conversationId: string | null | undefined): boolean {
  return Boolean(conversationId && registry.entries.has(conversationId));
}

export function trustedChatIds(): string[] {
  return [...registry.entries];
}

export function setChatsTrusted(conversationIds: readonly string[], next: boolean): Promise<void> {
  const ids = [...new Set(conversationIds)];
  if (ids.length === 0 || ids.some(id => !validConversationId(id))) throw new Error('Invalid conversation ID');
  const operation = registry.writes.then(async () => {
    await restoreTrustedChats();
    const updated = new Set(registry.entries);
    if (next) {
      const additions = ids.filter(id => !updated.has(id));
      if (updated.size + additions.length > MAX_TRUSTED_CHATS) {
        throw new Error(`Too many trusted chats (${MAX_TRUSTED_CHATS}). Untrust one before trusting another.`);
      }
      for (const id of additions) updated.add(id);
    } else {
      for (const id of ids) updated.delete(id);
    }
    if (updated.size === registry.entries.size && [...updated].every(id => registry.entries.has(id))) return;
    try {
      await writeDurableNow(TRUSTED_STATE, snapshot(updated));
    } catch (error) {
      writeDurableSoon(TRUSTED_STATE, snapshot(registry.entries));
      throw error;
    }
    registry.entries = updated;
  });
  registry.writes = operation.then(() => undefined, () => undefined);
  return operation;
}

export function setChatTrusted(conversationId: string, next: boolean): Promise<void> {
  return setChatsTrusted([conversationId], next);
}

export function resetTrustedChatsForTests(): void {
  registry.entries.clear();
  registry.loaded = false;
  registry.restore = null;
  registry.writes = Promise.resolve();
}
