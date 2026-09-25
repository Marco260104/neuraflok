import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionEvent } from '../../../../contracts/session.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';

export type MessageEvent = Extract<SessionEvent, { kind: 'user_message' | 'assistant_message' }>;
export type NativeImageEvent = Extract<SessionEvent, { kind: 'native_image' }>;
export type CanonicalEvent = MessageEvent | NativeImageEvent | Extract<SessionEvent, { kind: 'tool_call' }>;
export type NewMessageEvent = MessageEvent extends infer Event
  ? Event extends MessageEvent
    ? Omit<Event, 'seq'>
    : never
  : never;
export type NewNativeImageEvent = Omit<NativeImageEvent, 'seq' | 'origin'>;

interface Runtime {
  sessionDir: (id: string) => string;
  messageKey: (event: CanonicalEvent) => string | null;
}

const CANONICAL_SHARD_READ_CONCURRENCY = 8;
const MAX_CANONICAL_MESSAGE_BYTES = 1024 * 1024;

export function createSessionCanonicalMessages(runtime: Runtime) {
  const { sessionDir, messageKey } = runtime;
  /** Canonical message snapshot file. Unknown/legacy shapes are ignored, never guessed. */
  async function readCanonicalMessages(id: string, aliasesCollapsed?: () => void): Promise<Map<string, CanonicalEvent>> {
    const out = new Map<string, CanonicalEvent>();
    try {
      const raw = await fs.readFile(path.join(sessionDir(id), 'messages.json'), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        const event = value as CanonicalEvent;
        if ((event.kind !== 'user_message' && event.kind !== 'assistant_message' && event.kind !== 'native_image' && event.kind !== 'tool_call') || typeof event.seq !== 'number') continue;
        const expected = messageKey(event);
        if (!expected || expected !== key) continue;
        out.set(key, event);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn(`session ${id}: canonical message file unreadable; legacy event log remains available`);
      }
    }
    // Incremental shards overlay the legacy whole-map snapshot. This makes migration lazy: the first post-upgrade revision writes only its own logical message, while untouched history remains readable from messages.json.
    const shards = path.join(sessionDir(id), 'messages');
    try {
      const names = (await fs.readdir(shards)).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
      // Reading thousands of tiny shards serially made the one-time correlation migration spend tens of seconds in Windows filesystem latency. Eight bounded reads overlap that latency without opening every shard file at once or changing validation/publication order.
      for (let offset = 0; offset < names.length; offset += CANONICAL_SHARD_READ_CONCURRENCY) {
        const batch = await Promise.all(names.slice(offset, offset + CANONICAL_SHARD_READ_CONCURRENCY).map(async name => {
          try {
            const raw = await fs.readFile(path.join(shards, name), 'utf8');
            if (Buffer.byteLength(raw, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) return null;
            const event = JSON.parse(raw) as CanonicalEvent;
            const key = messageKey(event);
            if (!key) return null;
            const expectedName = `${createHash('sha256').update(key).digest('hex')}.json`;
            return expectedName === name ? [key, event] as const : null;
          } catch {
            logWarn(`session ${id}: ignored unreadable canonical message shard ${name}`);
            return null;
          }
        }));
        for (const entry of batch) {
          if (entry) out.set(entry[0], entry[1]);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logWarn(`session ${id}: canonical message shards unreadable`);
    }
    // Older builds persisted reload timestamp aliases as separate shards. Project those exact provider UUIDs as one message without deleting forensic history. First observation owns chronology; the latest terminal revision owns content.
    const providers = new Map<string, Array<[string, Extract<MessageEvent, { kind: 'assistant_message' }>]>>();
    for (const [key, event] of [...out].sort(([, a], [, b]) => (a.origin ?? a.seq) - (b.origin ?? b.seq))) {
      if (event.kind !== 'assistant_message' || !event.providerMessageId) continue;
      const group = providers.get(event.providerMessageId) ?? [];
      group.push([key, event]);
      providers.set(event.providerMessageId, group);
    }
    for (const group of providers.values()) {
      if (group.length < 2) continue;
      aliasesCollapsed?.();
      const [firstKey, first] = group[0]!;
      // Keep the winning content's own seq intact until selection finishes: a later streaming alias advances the read cursor but must not outrank a terminal revision.
      let latest = first, seq = first.seq;
      for (const [key, event] of group) {
        const latestFinal = latest.final === true || latest.state === 'final';
        const eventFinal = event.final === true || event.state === 'final';
        if (latestFinal !== eventFinal ? eventFinal : event.seq > latest.seq) latest = event;
        seq = Math.max(seq, event.seq);
        out.delete(key);
      }
      out.set(firstKey, { ...latest, messageId: first.messageId, origin: first.origin ?? first.seq,
        time: first.time, seq, turnId: group.find(([, event]) => event.turnId)?.[1].turnId,
        ...(group.some(([, event]) => event.goalEligible === true) ? { goalEligible: true } : {}) });
    }
    return out;
  }

  async function writeCanonicalMessage(id: string, key: string, event: CanonicalEvent): Promise<void> {
    const dir = path.join(sessionDir(id), 'messages');
    await fs.mkdir(dir, { recursive: true });
    const name = `${createHash('sha256').update(key).digest('hex')}.json`;
    const target = path.join(dir, name);
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const text = JSON.stringify(event);
    if (Buffer.byteLength(text, 'utf8') > MAX_CANONICAL_MESSAGE_BYTES) {
      throw new Error('Canonical message is too large');
    }
    try {
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, target);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  return { readCanonicalMessages, writeCanonicalMessage };
}
