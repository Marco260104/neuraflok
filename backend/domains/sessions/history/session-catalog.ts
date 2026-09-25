import { promises as fs } from 'node:fs';
import type { SessionSummary } from '../../../../contracts/session.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import type { sessionCatalogRuntime } from './store.js';

type Runtime = typeof sessionCatalogRuntime;

interface AttachmentCatalog {
  summaries: Map<string, SessionSummary>;
  orderedIds: string[];
  current: Map<string, Set<string>>;
  historical: Map<string, Set<string>>;
  complete: boolean;
}

export interface SessionListCursor {
  updatedAt: number;
  id: string;
}

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
  nextCursor: SessionListCursor | null;
}

const MAX_LISTED_SESSIONS = 200;
const MAX_SCANNED_SESSIONS = 5_000;
const READ_CONCURRENCY = 64;
const MAX_MISSING_CONVERSATION_CACHE = 1024;

export function createSessionCatalog(runtime: Runtime) {
  let catalog: AttachmentCatalog | null = null;
  let catalogLoading: Promise<AttachmentCatalog> | null = null;
  let epoch = 0;
  const missingCurrentConversations = new Set<string>();

  function rememberMissingCurrentConversation(conversationId: string): void {
    missingCurrentConversations.add(conversationId);
    if (missingCurrentConversations.size <= MAX_MISSING_CONVERSATION_CACHE) return;
    const oldest = missingCurrentConversations.values().next().value as string | undefined;
    if (oldest) missingCurrentConversations.delete(oldest);
  }

  function clearMissingCurrentConversation(conversationId: string): void {
    if (conversationId) missingCurrentConversations.delete(conversationId);
  }

  function reset(): void {
    missingCurrentConversations.clear();
    catalog = null;
    catalogLoading = null;
    epoch = 0;
  }

  function isActive(): boolean {
    return catalog !== null || catalogLoading !== null;
  }

  function addAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
    if (!conversationId) return;
    const ids = map.get(conversationId) ?? new Set<string>();
    ids.add(sessionId);
    map.set(conversationId, ids);
  }

  function removeAttachment(map: Map<string, Set<string>>, conversationId: string, sessionId: string): void {
    if (!conversationId) return;
    const ids = map.get(conversationId);
    if (!ids) return;
    ids.delete(sessionId);
    if (ids.size === 0) map.delete(conversationId);
  }

  function indexSummary(target: AttachmentCatalog, summary: SessionSummary): void {
    target.summaries.set(summary.id, { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
    if (summary.conversationId) addAttachment(target.current, summary.conversationId, summary.id);
    for (const chatId of summary.chatIds) addAttachment(target.historical, chatId, summary.id);
  }

  function unindexSummary(target: AttachmentCatalog, summary: SessionSummary): void {
    target.summaries.delete(summary.id);
    const orderedAt = target.orderedIds.indexOf(summary.id);
    if (orderedAt >= 0) target.orderedIds.splice(orderedAt, 1);
    if (summary.conversationId) removeAttachment(target.current, summary.conversationId, summary.id);
    for (const chatId of summary.chatIds) removeAttachment(target.historical, chatId, summary.id);
  }

  function compareSummariesNewestFirst(left: SessionSummary, right: SessionSummary): number {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  }

  function insertSummaryOrder(target: AttachmentCatalog, summary: SessionSummary): void {
    let low = 0;
    let high = target.orderedIds.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = target.summaries.get(target.orderedIds[middle]!);
      if (!other || compareSummariesNewestFirst(summary, other) < 0) high = middle;
      else low = middle + 1;
    }
    target.orderedIds.splice(low, 0, summary.id);
  }

  function publishCachedSummary(summary: SessionSummary, reorder: boolean): void {
    const current = catalog;
    if (!current) return;
    const clone = { ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] };
    current.summaries.set(summary.id, clone);
    if (!reorder) return;
    const orderedAt = current.orderedIds.indexOf(summary.id);
    if (orderedAt >= 0) current.orderedIds.splice(orderedAt, 1);
    insertSummaryOrder(current, clone);
  }

  function publishAttachmentSummary(summary: SessionSummary): void {
    epoch += 1;
    clearMissingCurrentConversation(summary.conversationId ?? '');
    const current = catalog;
    if (!current) return;
    const previous = current.summaries.get(summary.id);
    if (previous) unindexSummary(current, previous);
    indexSummary(current, summary);
    insertSummaryOrder(current, current.summaries.get(summary.id)!);
  }

  function publishAttachmentRemoval(sessionId: string): void {
    epoch += 1;
    const current = catalog;
    if (!current) return;
    const previous = current.summaries.get(sessionId);
    if (previous) unindexSummary(current, previous);
  }

  function publishClosedSummary(summary: SessionSummary): void {
    epoch += 1;
    publishCachedSummary(summary, true);
  }

  function newCatalog(): AttachmentCatalog {
    return { summaries: new Map(), orderedIds: [], current: new Map(), historical: new Map(), complete: true };
  }

  async function ensureCatalog(): Promise<AttachmentCatalog> {
    if (catalog) return catalog;
    if (catalogLoading) return catalogLoading;
    const loading = (async () => {
      const startedAt = Date.now();
      for (;;) {
        runtime.assertReady();
        const startingEpoch = epoch;
        let names: string[];
        try {
          names = await fs.readdir(runtime.getRoot());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
          else throw error;
        }
        const current = newCatalog();
        const candidates = names.filter(name => /^[0-9a-z-]{8,64}$/i.test(name));
        let unread = 0;
        for (let offset = 0; offset < candidates.length; offset += READ_CONCURRENCY) {
          const summaries = await Promise.all(candidates.slice(offset, offset + READ_CONCURRENCY).map(async name => {
            const live = runtime.openSummary(name);
            if (live) return live;
            try {
              return await runtime.readCatalogSummary(name);
            } catch (error) {
              unread += 1;
              logWarn(`session catalog: ${name} could not be read this pass: ${(error as Error).message}`);
              return null;
            }
          }));
          for (const summary of summaries) if (summary) indexSummary(current, summary);
        }
        current.orderedIds = [...current.summaries.values()].sort(compareSummariesNewestFirst).map(summary => summary.id);
        if (epoch !== startingEpoch) continue;
        if (unread > 0) {
          logWarn(`session catalog: ${unread} of ${candidates.length} folders unreadable; not caching this pass`);
          current.complete = false;
          return current;
        }
        catalog = current;
        logInfo(`session catalog ready: ${current.summaries.size} sessions in ${Date.now() - startedAt} ms`);
        return current;
      }
    })();
    catalogLoading = loading;
    try {
      return await loading;
    } finally {
      if (catalogLoading === loading) catalogLoading = null;
    }
  }

  async function readAllSummaries(): Promise<SessionSummary[]> {
    runtime.assertReady();
    let names: string[];
    try {
      names = await fs.readdir(runtime.getRoot());
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    const candidates = names.filter(name => /^[0-9a-z-]{8,64}$/i.test(name));
    if (candidates.length > MAX_SCANNED_SESSIONS)
      logWarn(`session store: more than ${MAX_SCANNED_SESSIONS} session folders; older ones were not scanned`);
    for (let offset = 0; offset < Math.min(candidates.length, MAX_SCANNED_SESSIONS); offset += READ_CONCURRENCY) {
      const rows = await Promise.all(candidates.slice(offset, Math.min(offset + READ_CONCURRENCY, MAX_SCANNED_SESSIONS))
        .map(async name => runtime.openSummary(name) ?? await runtime.readMeta(name)));
      for (const summary of rows) if (summary) summaries.push({ ...summary });
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  async function readEverySummary(): Promise<SessionSummary[]> {
    const current = await ensureCatalog();
    const summaries = new Map<string, SessionSummary>();
    for (const summary of current.summaries.values()) summaries.set(summary.id, summary);
    for (const summary of runtime.openSummaries()) summaries.set(summary.id, summary);
    return [...summaries.values()].map(summary => ({ ...summary })).sort(compareSummariesNewestFirst);
  }

  function comesAfterCursor(summary: SessionSummary, cursor: SessionListCursor): boolean {
    return summary.updatedAt < cursor.updatedAt || (summary.updatedAt === cursor.updatedAt && summary.id < cursor.id);
  }

  async function listSessionPage(options: { limit?: number; cursor?: SessionListCursor } = {}): Promise<SessionPage> {
    const current = await ensureCatalog();
    const limit = Math.max(1, Math.min(MAX_LISTED_SESSIONS, Math.floor(options.limit ?? MAX_LISTED_SESSIONS)));
    const openSummaries = runtime.openSummaries();
    const openIds = new Set(openSummaries.map(summary => summary.id));
    const candidates: SessionSummary[] = [];
    for (const summary of openSummaries) {
      if (summary.origin?.kind === 'helper') continue;
      if (options.cursor && !comesAfterCursor(summary, options.cursor)) continue;
      candidates.push({ ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
    }
    let durableEligible = 0;
    let durableHasMore = false;
    for (const id of current.orderedIds) {
      if (openIds.has(id)) continue;
      const summary = current.summaries.get(id);
      if (!summary || summary.origin?.kind === 'helper' || (options.cursor && !comesAfterCursor(summary, options.cursor))) continue;
      if (durableEligible > limit) {
        durableHasMore = true;
        break;
      }
      candidates.push({ ...summary, chatIds: [...summary.chatIds], agents: [...summary.agents] });
      durableEligible += 1;
    }
    candidates.sort(compareSummariesNewestFirst);
    const sessions = candidates.slice(0, limit);
    const last = sessions.at(-1);
    const hasMore = durableHasMore || candidates.length > sessions.length;
    const nextCursor = hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null;
    let total = 0;
    for (const summary of current.summaries.values()) {
      if (!openIds.has(summary.id) && summary.origin?.kind !== 'helper') total += 1;
    }
    for (const summary of openSummaries) if (summary.origin?.kind !== 'helper') total += 1;
    return { sessions, total, nextCursor };
  }

  async function listSessions(): Promise<SessionSummary[]> {
    return (await listSessionPage({ limit: MAX_LISTED_SESSIONS })).sessions;
  }

  async function listUsageSessions(): Promise<SessionSummary[]> {
    return readEverySummary();
  }

  async function listAllSessions(): Promise<SessionSummary[]> {
    return readAllSummaries();
  }

  async function indexedSessions(): Promise<SessionSummary[]> {
    return readEverySummary();
  }

  async function findSessionByConversation(
    conversationId: string,
    options: { includeHistorical?: boolean; requireUnique?: boolean } = {}
  ): Promise<SessionSummary | null> {
    if (!conversationId) return null;
    if (options.includeHistorical !== true && missingCurrentConversations.has(conversationId)) return null;
    const current = await ensureCatalog();
    let unreadable = !current.complete;
    const answer = async (id: string): Promise<SessionSummary | null> => {
      try {
        return await runtime.getSession(id);
      } catch {
        unreadable = true;
        return null;
      }
    };
    const currentIds = new Set(current.current.get(conversationId) ?? []);
    for (const summary of runtime.openSummaries()) {
      if (summary.conversationId === conversationId) currentIds.add(summary.id);
    }
    const currentOwners = (await Promise.all([...currentIds].map(answer)))
      .filter((summary): summary is SessionSummary => summary?.conversationId === conversationId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (currentOwners.length === 1) return currentOwners[0] ?? null;
    if (currentOwners.length > 1) {
      if (options.requireUnique === true) {
        logWarn(`session store: conversation ${conversationId} is current on ${currentOwners.length} sessions; refusing safety-sensitive lookup`);
        return null;
      }
      return currentOwners[0] ?? null;
    }
    if (options.includeHistorical !== true) {
      if (!unreadable) rememberMissingCurrentConversation(conversationId);
      return null;
    }
    const historicalIds = new Set(current.historical.get(conversationId) ?? []);
    for (const summary of runtime.openSummaries()) {
      if (summary.chatIds.includes(conversationId)) historicalIds.add(summary.id);
    }
    const historicalOwners = (await Promise.all([...historicalIds].map(answer)))
      .filter((summary): summary is SessionSummary => summary?.chatIds.includes(conversationId) === true)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (historicalOwners.length === 1) return historicalOwners[0] ?? null;
    if (historicalOwners.length > 1)
      logWarn(`session store: conversation ${conversationId} appears in ${historicalOwners.length} session lineages; refusing to guess`);
    return null;
  }

  async function conversationWasSuperseded(conversationId: string): Promise<boolean> {
    if (!conversationId) return false;
    const current = await ensureCatalog();
    const sessionIds = new Set(current.historical.get(conversationId) ?? []);
    for (const summary of runtime.openSummaries()) {
      if (summary.chatIds.includes(conversationId)) sessionIds.add(summary.id);
    }
    for (const id of sessionIds) {
      const summary = runtime.openSummary(id) ?? current.summaries.get(id) ?? null;
      if (summary?.chatIds.includes(conversationId) && summary.conversationId !== conversationId) return true;
    }
    return false;
  }

  async function conversationAttachment(
    conversationId: string,
    sessionId: string | null = null
  ): Promise<'current' | 'superseded' | 'unknown'> {
    if (!conversationId) return 'unknown';
    if (sessionId) {
      const exact = await runtime.getSession(sessionId);
      if (!exact || !exact.chatIds.includes(conversationId)) return 'unknown';
      return exact.conversationId === conversationId ? 'current' : 'superseded';
    }
    const current = await findSessionByConversation(conversationId, { requireUnique: true });
    if (current) return 'current';
    return (await conversationWasSuperseded(conversationId)) ? 'superseded' : 'unknown';
  }

  return {
    clearMissingCurrentConversation,
    conversationAttachment,
    conversationWasSuperseded,
    findSessionByConversation,
    indexedSessions,
    isActive,
    listAllSessions,
    listSessionPage,
    listSessions,
    listUsageSessions,
    publishAttachmentRemoval,
    publishAttachmentSummary,
    publishCachedSummary,
    publishClosedSummary,
    readEverySummary,
    reset,
  };
}
