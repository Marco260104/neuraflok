import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionEvent, SessionOrigin, SessionSummary } from '../../../../contracts/session.js';
import type { CanonicalEvent } from './session-canonical-messages.js';
import type { DurableSessionSnapshot } from './session-durable-snapshot.js';
import { emptySummary } from './session-summary-projection.js';

export interface OpenSession {
  summary: SessionSummary;
  nextSeq: number;
  historySeq: number;
  tail: SessionEvent[];
  tailFrom: number;
  activityHydrated: boolean;
  queue: Promise<void>;
  messages: Map<string, CanonicalEvent>;
  metaDirty: boolean;
  metaTimer: NodeJS.Timeout | null;
}

type SessionCreateOptions = {
  reservedId?: string;
  title?: string;
  titleSource?: SessionSummary['titleSource'];
  conversationId?: string | null;
  origin?: SessionOrigin | null;
};

type Runtime = {
  assertSessionId(id: string): void;
  sessionDirectory(id: string): string;
  getSession(id: string): Promise<SessionSummary | null>;
  clearMissingCurrentConversation(conversationId: string): void;
  readDurableSnapshot(id: string): Promise<DurableSessionSnapshot | null>;
  sealTornTail(id: string): Promise<void>;
  isSessionCatalogActive(): boolean;
  publishAttachmentSummary(summary: SessionSummary): void;
  publishCachedSummary(summary: SessionSummary, reorder: boolean): void;
  writeSummary(summary: SessionSummary, historySeq: number): Promise<void>;
  error(message: string): void;
};

export function createSessionStoreLiveState(runtime: Runtime) {
  const open = new Map<string, OpenSession>();
  const opening = new Map<string, Promise<OpenSession>>();

  async function writeMeta(entry: OpenSession): Promise<void> {
    await runtime.writeSummary(entry.summary, entry.historySeq);
    runtime.publishCachedSummary(entry.summary, false);
    entry.metaDirty = false;
  }

  function enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T> {
    const work = entry.queue.then(operation);
    entry.queue = work.then(
      () => undefined,
      (err: Error) => runtime.error(`session ${label} failed: ${err.message}`)
    );
    return work;
  }

  function scheduleMeta(entry: OpenSession): void {
    entry.metaDirty = true;
    if (entry.metaTimer) return;
    entry.metaTimer = setTimeout(() => {
      entry.metaTimer = null;
      void enqueueSessionOperation(entry, 'meta write', async () => {
        if (entry.metaDirty) await writeMeta(entry);
      });
    }, 1500);
    entry.metaTimer.unref?.();
  }

  async function flushSessionEntry(entry: OpenSession): Promise<void> {
    if (entry.metaTimer) {
      clearTimeout(entry.metaTimer);
      entry.metaTimer = null;
    }
    await enqueueSessionOperation(entry, 'meta flush', async () => {
      if (entry.metaDirty) await writeMeta(entry);
    }).catch(() => undefined);
  }

  async function flushSessions(): Promise<void> {
    for (const entry of open.values()) await flushSessionEntry(entry);
  }

  async function flushSession(sessionId: string): Promise<void> {
    let entry = open.get(sessionId);
    if (!entry) {
      const reconstructing = opening.get(sessionId);
      if (reconstructing) entry = await reconstructing;
    }
    if (entry) await flushSessionEntry(entry);
  }

  async function createSession(options: SessionCreateOptions): Promise<SessionSummary> {
    const id = options.reservedId ?? `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    runtime.assertSessionId(id);
    if (options.reservedId) {
      const existing = await runtime.getSession(id);
      if (existing) {
        if (existing.origin?.kind !== 'desktop') throw new Error('Reserved opening session belongs to different work');
        return existing;
      }
    }
    const summary = emptySummary(id, options.title?.trim() || 'New chat', options.conversationId ?? null);
    summary.origin = options.origin ?? null;
    if (options.titleSource) summary.titleSource = options.titleSource;
    if (options.origin?.fromSessionId) {
      const source = await runtime.getSession(options.origin.fromSessionId);
      if (source?.projectId) summary.projectId = source.projectId;
    }
    runtime.clearMissingCurrentConversation(summary.conversationId ?? '');
    const entry: OpenSession = {
      summary,
      nextSeq: 1,
      historySeq: 0,
      tail: [],
      tailFrom: 1,
      activityHydrated: true,
      queue: Promise.resolve(),
      messages: new Map(),
      metaDirty: false,
      metaTimer: null
    };
    open.set(id, entry);
    try {
      await fs.mkdir(runtime.sessionDirectory(id), { recursive: true });
      await fs.writeFile(path.join(runtime.sessionDirectory(id), 'events.jsonl'), '', { flag: 'a' });
      await fs.writeFile(path.join(runtime.sessionDirectory(id), 'messages.json'), '{}', { flag: 'wx' }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      await writeMeta(entry);
      runtime.publishAttachmentSummary(entry.summary);
    } catch (error) {
      if (open.get(id) === entry) open.delete(id);
      throw error;
    }
    return { ...summary };
  }

  async function ensureOpen(id: string): Promise<OpenSession> {
    runtime.assertSessionId(id);
    const existing = open.get(id);
    if (existing) return existing;
    const inFlight = opening.get(id);
    if (inFlight) return inFlight;
    const reconstruction = (async () => {
      await runtime.sealTornTail(id);
      const snapshot = await runtime.readDurableSnapshot(id);
      if (!snapshot) throw new Error(`Session ${id} has no recoverable metadata or history`);
      const entry: OpenSession = {
        summary: snapshot.summary,
        nextSeq: snapshot.historySeq + 1,
        historySeq: snapshot.historySeq,
        tail: [],
        tailFrom: snapshot.historySeq + 1,
        activityHydrated: false,
        queue: Promise.resolve(),
        messages: snapshot.messages,
        metaDirty: false,
        metaTimer: null
      };
      open.set(id, entry);
      if (snapshot.reconciled && runtime.isSessionCatalogActive()) {
        runtime.publishAttachmentSummary(entry.summary);
      }
      return entry;
    })();
    opening.set(id, reconstruction);
    try {
      return await reconstruction;
    } finally {
      if (opening.get(id) === reconstruction) opening.delete(id);
    }
  }

  function reset(): void {
    for (const entry of open.values()) if (entry.metaTimer) clearTimeout(entry.metaTimer);
    open.clear();
    opening.clear();
  }

  return {
    createSession,
    deleteOpenSession: (id: string, expected?: OpenSession) => {
      if (expected === undefined || open.get(id) === expected) open.delete(id);
    },
    enqueueSessionOperation,
    ensureOpen,
    flushSession,
    flushSessions,
    getOpenEntries: () => [...open.values()],
    getOpenSession: (id: string) => open.get(id),
    getOpeningSession: (id: string) => opening.get(id),
    hasLiveSession: (id: string) => open.has(id) || opening.has(id),
    isCurrentOpenSession: (id: string, entry: OpenSession) => open.get(id) === entry,
    reset,
    scheduleMeta,
    setOpenSession: (id: string, entry: OpenSession) => open.set(id, entry),
    setOpeningSession: (id: string, pending: Promise<OpenSession>) => opening.set(id, pending),
    writeMeta
  };
}
