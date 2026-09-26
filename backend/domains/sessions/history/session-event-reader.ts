import { promises as fs } from 'node:fs';
import { workSequence, type SessionEvent, type SessionSummary } from '../../../../contracts/session.js';
import { chronological, positionOf, projectTimeline } from '../../../../contracts/chronology.js';
import type { CanonicalEvent } from './store.js';

// Reads canonical events from the bounded journal and stable message shards.
export interface ReadOptions {
  from?: number;
  limit?: number;
  kinds?: readonly SessionEvent['kind'][];
  agent?: string;
}

interface OpenSessionReadView {
  summary: SessionSummary;
  nextSeq: number;
  tail: SessionEvent[];
  tailFrom: number;
  messages: Map<string, CanonicalEvent>;
}

interface Runtime {
  assertSessionId(sessionId: string): void;
  eventFile(sessionId: string): string;
  flushSession(sessionId: string): Promise<void>;
  getOpenSession(sessionId: string): OpenSessionReadView | null;
  maxEventTail: number;
  maxLineBytes: number;
  messageKey(event: SessionEvent): string | null;
  readCanonicalMessages(sessionId: string): Promise<Map<string, CanonicalEvent>>;
  readDurableSummary(sessionId: string): Promise<SessionSummary | null>;
  warn(message: string): void;
}

const MAX_RECENT_READ_BYTES = 8 * 1024 * 1024;

export function createSessionEventReader(runtime: Runtime) {
  const {
    assertSessionId,
    eventFile,
    flushSession,
    getOpenSession,
    maxEventTail,
    maxLineBytes,
    messageKey: messageKeyOf,
    readCanonicalMessages,
    readDurableSummary,
    warn
  } = runtime;
async function readEvents(sessionId: string, options: ReadOptions = {}): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const from = options.from ?? 0;
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  // /activity is an incremental feed. Canonical messages use their latest revision seq for the cursor while preserving their first-appearance time/origin for chronology.
  const active = getOpenSession(sessionId);
  const timeline = active?.summary ?? await readDurableSummary(sessionId);
  if (options.from !== undefined && active) {
    if (from >= active.nextSeq) return [];
    const cacheFloor = active.tailFrom;
    if (from >= cacheFloor) {
      const cached: SessionEvent[] = [...active.tail, ...active.messages.values()].filter((parsed) => {
        if (parsed.seq < from) return false;
        if (options.kinds && !options.kinds.includes(parsed.kind)) return false;
        if (options.agent && parsed.agent !== options.agent) return false;
        return true;
      });
      // `from` is a sequence cursor. Page in sequence order first and only then apply the presentation chronology inside that bounded page; otherwise chronology may move a later row ahead of an earlier seq at the slice boundary and advancing the cursor would skip it.
      const page = cached.sort((left, right) => left.seq - right.seq).slice(0, limit);
      return chronological(projectTimeline(page, timeline?.timelineTurns, timeline?.requestTurns, active.messages.values()));
    }
  }
  const journal: SessionEvent[] = [];
  let damaged = 0;
  const oversized = await scanJournalLines(sessionId, line => {
    if (!line.trim()) return;
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line) as SessionEvent;
    } catch {
      damaged++;
      return;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged++;
      return;
    }
    if (parsed.seq < from) return;
    if (options.kinds && !options.kinds.includes(parsed.kind)) return;
    if (options.agent && parsed.agent !== options.agent) return;
    journal.push(parsed);
  });
  damaged += oversized;
  // Read the canonical overlay after the asynchronous scan, just as after the old whole-file read. A message revised while the journal is read must still replace its legacy snapshots.
  const messages = active?.messages ?? (await readCanonicalMessages(sessionId));
  const canonicalKeys = new Set(messages.keys());
  const out = journal.filter(parsed => {
    // A canonical provider message replaces older append-only journal snapshots with the same identity.
    if (messageKeyOf(parsed) && canonicalKeys.has(messageKeyOf(parsed)!)) {
      return false;
    }
    return true;
  });
  for (const message of messages.values()) {
    if (message.seq < from) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    out.push(message);
  }
  if (damaged > 0) warn(`session ${sessionId}: skipped ${damaged} unreadable event line(s)`);
  // `seq` is the immutable cursor domain; logical chronology is only allowed to reorder a bounded turn whose `turn_start` is present in this read window. Global time sorting used to move unrelated/replayed page history across turn boundaries and disagreed with the extension renderer, which already used the shared rule. One function now defines the transcript order everywhere.
  if (options.from !== undefined) {
    const page = out.sort((left, right) => left.seq - right.seq).slice(0, limit);
    return chronological(projectTimeline(page, timeline?.timelineTurns, timeline?.requestTurns, messages.values()));
  }
  return chronological(projectTimeline(out, timeline?.timelineTurns, timeline?.requestTurns, messages.values())).slice(0, limit);
}

/** A bounded line scan, including torn/oversized legacy lines and UTF-8 split across blocks. */
async function scanJournalLines(sessionId: string, accept: (line: string) => void): Promise<number> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(eventFile(sessionId), 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  const block = Buffer.alloc(256 * 1024);
  const empty = Buffer.alloc(0);
  let carry = empty, skipping = false, damaged = 0, position = 0;
  try {
    const { size } = await handle.stat();
    // A live recorder may append during the scan. Read the captured journal extent once, rather than chasing a moving EOF or borrowing a later generation's events.
    while (position < size) {
      const { bytesRead } = await handle.read(block, 0, Math.min(block.length, size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      const bytes = block.subarray(0, bytesRead);
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(0x0a, start);
        const part = bytes.subarray(start, newline < 0 ? bytes.length : newline);
        if (!skipping) {
          if (carry.length + part.length > maxLineBytes) { skipping = true; carry = empty; }
          else if (newline >= 0) accept((carry.length ? Buffer.concat([carry, part]) : part).toString('utf8'));
          else carry = carry.length ? Buffer.concat([carry, part]) : Buffer.from(part);
        }
        if (newline < 0) break;
        if (skipping) { damaged++; skipping = false; }
        carry = empty;
        start = newline + 1;
      }
    }
    if (skipping) damaged++;
    else if (carry.length) accept(carry.toString('utf8'));
    return damaged;
  } finally { await handle.close(); }
}

// Reads only the newest matching presentation window without materialising the whole JSONL journal. This exists for UI/default-history tails. Full-text search, call expansion and explicit old cursors still use `readEvents()` because they genuinely need older rows. The scan walks the journal backwards and stops once it has enough matching rows (or reaches the bounded byte budget), so `limit: 1` cannot turn into a 40 MB read. Tool status revisions retain their invocation position; they cannot displace newer model work from a limit-one read.
async function readRecentEvents(
  sessionId: string,
  limit: number,
  options: Pick<ReadOptions, 'kinds' | 'agent'> & { maxBytes?: number; before?: number; after?: number; orderByOrigin?: boolean } = {}
): Promise<SessionEvent[]> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  return readRecentEventsFromDisk(sessionId, limit, options);
}


async function readRecentEventsFromDisk(
  sessionId: string,
  limit: number,
  options: Pick<ReadOptions, 'kinds' | 'agent'> & {
    maxBytes?: number; before?: number; after?: number; acceptEvent?: (event: SessionEvent) => boolean; orderByOrigin?: boolean
  } = {}
): Promise<SessionEvent[]> {
  const cap = Math.max(1, Math.min(maxEventTail, Math.floor(limit)));
  const active = getOpenSession(sessionId);
  const needsMessages =
    !options.kinds || options.kinds.includes('user_message') || options.kinds.includes('assistant_message') ||
    options.kinds.includes('native_image') || options.kinds.includes('tool_call');
  const messages = needsMessages ? active?.messages ?? (await readCanonicalMessages(sessionId)) : new Map<string, CanonicalEvent>();
  const canonicalKeys = new Set(messages.keys());
  // Pre-canonical sessions could append every streaming revision of one stable website message to events.jsonl. This reader builds a *presentation* tail, so those revisions are one logical row here just as a canonical message is one row today. Because the journal is scanned newest-first, the first key seen is the latest revision; duplicates must not spend the row cap or a long old answer can hide every earlier user turn from Goal/history tails.
  const legacyMessageKeys = new Set<string>();
  const rawTail: SessionEvent[] = [];
  const sequence = options.orderByOrigin ? positionOf : workSequence;
  const forward = options.after !== undefined;
  let replaced = 0;
  let reachedStart = false;
  const scanning = () => !reachedStart;
  let damaged = 0;
  // Explicit history navigation may seek beyond the recent-tail budget. It streams backwards in fixed chunks and retains only this page, never materializing the complete journal.
  const readBudget = options.before === undefined && !forward ? Math.max(64 * 1024, Math.min(MAX_RECENT_READ_BYTES, options.maxBytes ?? MAX_RECENT_READ_BYTES)) : Number.POSITIVE_INFINITY;

  const accept = (line: Buffer): void => {
    if (!scanning() || line.length === 0) return;
    if (line.length > maxLineBytes) {
      damaged += 1;
      return;
    }
    let parsed: SessionEvent;
    try {
      parsed = JSON.parse(line.toString('utf8')) as SessionEvent;
    } catch {
      damaged += 1;
      return;
    }
    if (typeof parsed?.seq !== 'number' || typeof parsed?.kind !== 'string') {
      damaged += 1;
      return;
    }
    // A late label/status revision can have an old work sequence. Filling the row cap with it is not proof that we reached the newest actual work.
    const oldest = !forward && rawTail.length === cap
      ? rawTail.reduce((a, b) => sequence(a) < sequence(b) ? a : b) : undefined;
    if (oldest && parsed.seq < sequence(oldest)) { reachedStart = true; return; }
    // Journal sequence is append ordered. Canonical revisions are joined below; crossing the forward origin boundary retires this backwards scan.
    if (forward && parsed.seq <= options.after!) { reachedStart = true; return; }
    if (options.before !== undefined && sequence(parsed) >= options.before) return;
    if (forward && sequence(parsed) <= options.after!) return;
    if (options.kinds && !options.kinds.includes(parsed.kind)) return;
    if (options.agent && parsed.agent !== options.agent) return;
    if (options.acceptEvent && !options.acceptEvent(parsed)) return;
    if (messageKeyOf(parsed)) {
      const key = messageKeyOf(parsed);
      if (key) {
        if (canonicalKeys.has(key) || legacyMessageKeys.has(key)) return;
        legacyMessageKeys.add(key);
      }
    }
    if (rawTail.length < cap) rawTail.push(parsed);
    else if (forward) rawTail[replaced++ % cap] = parsed;
    else if (oldest && sequence(parsed) > sequence(oldest)) rawTail[rawTail.indexOf(oldest)] = parsed;
  };

  const file = eventFile(sessionId);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    let cursor = (await handle.stat()).size;
    let bytes = 0;
    let carry = Buffer.alloc(0);
    while (cursor > 0 && scanning() && bytes < readBudget) {
      const wanted = Math.min(64 * 1024, cursor, readBudget - bytes);
      if (wanted <= 0) break;
      cursor -= wanted;
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, cursor);
      const joined = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
      bytes += bytesRead;
      const firstNewline = joined.indexOf(0x0a);
      if (firstNewline < 0) {
        // A corrupt/no-newline tail used to repeatedly copy the complete 8 MiB budget: 64 KiB + 128 KiB + ... . Retain only one maximum event while seeking a boundary.
        if (joined.length > maxLineBytes + 1) damaged += 1;
        carry = joined.subarray(0, Math.min(joined.length, maxLineBytes + 1));
        continue;
      }
      carry = joined.subarray(0, firstNewline);
      const complete = joined.subarray(firstNewline + 1);
      let endAt = complete.length;
      for (let at = complete.length - 1; at >= 0 && scanning(); at--) {
        if (complete[at] !== 0x0a) continue;
        const line = complete.subarray(at + 1, endAt);
        if (line.length > 0) accept(line);
        endAt = at;
      }
      if (scanning() && endAt > 0) accept(complete.subarray(0, endAt));
    }
    if (cursor === 0 && scanning() && carry.length > 0) accept(carry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const candidates: SessionEvent[] = [...rawTail];
  for (const message of messages.values()) {
    if (options.before !== undefined && sequence(message) >= options.before) continue;
    if (forward && sequence(message) <= options.after!) continue;
    if (options.kinds && !options.kinds.includes(message.kind)) continue;
    if (options.agent && message.agent !== options.agent) continue;
    if (options.acceptEvent && !options.acceptEvent(message)) continue;
    candidates.push(message);
  }
  candidates.sort((left, right) => sequence(left) - sequence(right));
  const selected = forward ? candidates.slice(0, cap) : candidates.slice(Math.max(0, candidates.length - cap));
  if (damaged > 0) warn(`session ${sessionId}: skipped ${damaged} unreadable recent event line(s)`);
  const timeline = active?.summary ?? await readDurableSummary(sessionId);
  return chronological(projectTimeline(selected, timeline?.timelineTurns, timeline?.requestTurns, messages.values()));
}


  return { readEvents, readRecentEvents, readRecentEventsFromDisk };
}
