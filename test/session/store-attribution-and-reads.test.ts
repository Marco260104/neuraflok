import {
  appendEvent,
  conversationHasMcpCallSince,
  createHash,
  createSession,
  deleteSession,
  evidence,
  findSessionByConversation,
  flushSessions,
  fs,
  getLog,
  getSession,
  path,
  positionOf,
  readActivityEvents,
  readEvents,
  readRecentEvents,
  readToolEditReview,
  recordToolCall,
  resetRecorderForTests,
  resetSessionStoreForTests,
  rewriteUnattributedToolCalls,
  sessionForConversation,
  sessionsRoot,
  turnHasMcpCall,
  upsertMessageEvent,
} from './context.js';
import type {
  SessionEvent,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------------- store
describe('session store', () => {
  it('keeps an exact tool edit review after later edits, but never invents one for failed or oversized calls', async () => {
      const conversationId = 'conv-exact-edit-review';
      const sessionId = await sessionForConversation(conversationId);
      const changed = evidence({
        changes: [{ path: '/project/src/main.ts', added: 1, removed: 1, approximate: false }],
        reviews: [{ changeIndex: 0, before: 'one\n', after: 'two\n' }]
      });
      const first = await recordToolCall({ tool: 'apply_patch', args: { patch: 'first' },
        content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now(),
        conversationId, sessionId, evidence: changed });
      expect(first?.changes?.[0]?.reviewAssetId).toMatch(/^[a-f0-9]{32}\.txt$/);
      const second = await recordToolCall({ tool: 'apply_patch', args: { patch: 'second' },
        content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now() + 1,
        conversationId, sessionId, evidence: evidence({
          changes: [{ path: '/project/src/main.ts', added: 1, removed: 1, approximate: false }],
          reviews: [{ changeIndex: 0, before: 'two\n', after: 'three\n' }]
        }) });
      expect(await readToolEditReview(sessionId!, first!.callId, 0)).toMatchObject({ baseText: 'one\n', currentText: 'two\n' });
      expect(await readToolEditReview(sessionId!, second!.callId, 0)).toMatchObject({ baseText: 'two\n', currentText: 'three\n' });
      expect(await readToolEditReview(sessionId!, first!.callId, 1)).toBeNull();
      const failed = await recordToolCall({ tool: 'apply_patch', args: { patch: 'failed' },
        content: [{ type: 'text', text: 'failed' }], outcome: 'tool_execution_error', durationMs: 1, startedAt: Date.now() + 2,
        conversationId, sessionId, evidence: changed });
      expect(failed?.changes?.[0]?.reviewAssetId).toBeUndefined();
      const huge = await recordToolCall({ tool: 'apply_patch', args: { patch: 'huge' },
        content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now() + 3,
        conversationId, sessionId, evidence: evidence({
          changes: [{ path: '/project/src/huge.ts', added: 1, removed: 0, approximate: false }],
          reviews: [{ changeIndex: 0, before: '', after: 'x'.repeat(512 * 1024) }]
        }) });
      expect(huge?.changes?.[0]?.reviewAssetId).toBeUndefined();
      expect(huge?.changes?.[0]?.reviewUnavailable).toBe('too-large');
      expect(first?.changes?.[0]?.reviewUnavailable).toBeUndefined();
    });

  it('keeps reviews for every file of a larger patch and says why one was not kept (#563)', async () => {
      const conversationId = 'conv-many-file-review';
      const sessionId = await sessionForConversation(conversationId);
      const files = Array.from({ length: 10 }, (_, index) => `/project/src/file-${index}.ts`);
      const many = await recordToolCall({ tool: 'apply_patch', args: { patch: 'many' },
        content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now(),
        conversationId, sessionId, evidence: evidence({
          changes: files.map(path => ({ path, added: 1, removed: 1, approximate: false })),
          reviews: files.map((_, changeIndex) => ({ changeIndex, before: `a${changeIndex}\n`, after: `b${changeIndex}\n` }))
        }) });
      // Before, only the first 8 files of a patch could ever be reviewed.
      expect(many?.changes?.every(change => change.reviewAssetId && !change.reviewUnavailable)).toBe(true);
      expect(await readToolEditReview(sessionId!, many!.callId, 9)).toMatchObject({ baseText: 'a9\n', currentText: 'b9\n' });
      const budget = await recordToolCall({ tool: 'apply_patch', args: { patch: 'budget' },
        content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now() + 1,
        conversationId, sessionId, evidence: evidence({
          changes: [0, 1, 2, 3, 4].map(index => ({ path: `/project/big-${index}.txt`, added: 1, removed: 0, approximate: false })),
          reviews: [0, 1, 2, 3, 4].map(changeIndex => ({ changeIndex, before: '', after: 'x'.repeat(480 * 1024) }))
        }) });
      expect(budget?.changes?.slice(0, 4).every(change => change.reviewAssetId)).toBe(true);
      expect(budget?.changes?.[4]).toMatchObject({ reviewUnavailable: 'not-kept' });
      expect(budget?.changes?.[4]?.reviewAssetId).toBeUndefined();
    });

  it('uses original call time and exact conversation for late attribution health proof', async () => {
      const conversationId = 'health-current';
      const session = await createSession({ title: 'attribution health', conversationId });
      let index = 0;
      const append = (time: number, owner: string, turnId?: string, exact = true, source: 'mcp' | 'extension' = 'mcp') =>
        appendEvent(session.id, { time, source, kind: 'tool_call', turnId,
          call: { callId: `health-${++index}`, tool: 'read', requestId: `health-request-${index}`,
            conversationId: owner, attribution: exact ? 'request_id' : 'unattributed',
            attributionMethod: exact ? 'request_id' : 'unattributed',
            args: { text: '{}', truncated: false, chars: 2 }, result: { text: 'ok', truncated: false, chars: 2 },
            outcome: 'ok', durationMs: 1, summary: { title: 'read', tone: 'neutral', kind: 'read' } } });
      await append(999, conversationId); // Stored now, but started before the incident.
      await append(1_100, 'health-retired-source');
      await append(1_100, conversationId, 'older-turn');
      await append(1_100, conversationId, 'current-turn', false);
      await append(1_100, conversationId, 'current-turn', true, 'extension');
      expect(await conversationHasMcpCallSince(session.id, conversationId, 1_000, 'current-turn')).toBe(false);
      // Exact repaired work can have no local turn id, and need not be the newest append.
      await append(1_001, conversationId);
      await append(1_200, 'health-retired-source');
      expect(await conversationHasMcpCallSince(session.id, conversationId, 1_000, 'current-turn')).toBe(true);
      expect(await conversationHasMcpCallSince(session.id, conversationId, 1_002, 'current-turn')).toBe(false);
    });

  it('retains exact turn execution proof behind paginated historical attribution repairs', async () => {
      const conversationId = 'mcp-proof-conversation';
      const session = await createSession({ title: 'turn execution proof', conversationId });
      let callIndex = 0;
      const appendCall = (turnId: string | undefined, owner = conversationId, exact = true, source: 'mcp' | 'extension' = 'mcp') =>
        appendEvent(session.id, {
          time: 1_000, source, kind: 'tool_call', turnId,
          call: {
            callId: `proof-${++callIndex}`, tool: 'read', requestId: 'request-proof',
            conversationId: owner, attribution: exact ? 'request_id' : 'unattributed',
            attributionMethod: exact ? 'request_id' : 'unattributed',
            args: { text: '{}', truncated: false, chars: 2 },
            result: { text: 'ok', truncated: false, chars: 2 },
            outcome: 'ok', durationMs: 1,
            summary: { title: 'read', tone: 'neutral', kind: 'read' }
          }
        });
      await appendCall('older-turn');
      expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(false);
      await appendCall('source-turn', 'foreign-conversation');
      await appendCall('source-turn', conversationId, false);
      await appendCall('source-turn', conversationId, true, 'extension');
      expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(false);
      await appendCall('source-turn');
      // More than one presentation page of repairs must neither hide proof nor restart scans.
      for (let index = 0; index < 105; index++) await appendCall(undefined);
      expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(true);
      await appendCall('newer-turn', 'foreign-conversation');
      expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(true);
      const openFile = vi.spyOn(fs, 'open');
      try {
        expect(await turnHasMcpCall(session.id, conversationId, 'newer-turn')).toBe(false);
        expect(openFile.mock.calls.filter(([file]) => String(file).endsWith('events.jsonl'))).toHaveLength(1);
      } finally {
        openFile.mockRestore();
      }
      await fs.appendFile(path.join(sessionsRoot(), session.id, 'events.jsonl'),
        JSON.stringify({ seq: 9999, time: 1000, kind: 'tool_call', source: 'mcp', turnId: 'source-turn' }) + '\n');
      expect(await turnHasMcpCall(session.id, conversationId, 'source-turn')).toBe(true);
    });

  it('preserves tool calls appended after an unattributed repair snapshot', async () => {
      const summary = await createSession({ title: 'Unattributed activity', conversationId: null });
      const call = (callId: string, time: number) => ({
        time,
        source: 'mcp' as const,
        kind: 'tool_call' as const,
        call: {
          callId,
          tool: 'read',
          attribution: 'unattributed' as const,
          requestId: null,
          conversationId: null,
          attributionMethod: 'unattributed' as const,
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok' as const,
          durationMs: 1,
          summary: { title: callId, tone: 'neutral' as const, kind: 'read' as const }
        }
      });

      await appendEvent(summary.id, call('keep-old-unknown', 1));
      await appendEvent(summary.id, call('remove-old-repaired', 2));
      const snapshot = await readEvents(summary.id);
      const scannedThroughSeq = Math.max(...snapshot.map((event) => event.seq));
      const keptFromSnapshot = snapshot.filter(
        (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
          event.kind === 'tool_call' && event.call.callId === 'keep-old-unknown'
      );

      // This append lands after the repair decided its old keep/remove set, but before the rewrite is enqueued. It used to be silently discarded when the old snapshot replaced events.jsonl.
      await appendEvent(summary.id, call('keep-concurrent-new', 3));
      await rewriteUnattributedToolCalls(summary.id, keptFromSnapshot, scannedThroughSeq);

      const callIds = (await readEvents(summary.id))
        .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
        .map((event) => event.call.callId);
      expect(callIds).toEqual(['keep-old-unknown', 'keep-concurrent-new']);

      // The rewrite re-sequences its retained snapshot. A subsequent append must continue after it rather than reusing the concurrent row's sequence number.
      await appendEvent(summary.id, call('keep-after-rewrite', 4));
      const after = (await readEvents(summary.id)).filter((event) => event.kind === 'tool_call');
      expect(after.map((event) => event.call.callId)).toEqual([
        'keep-old-unknown',
        'keep-concurrent-new',
        'keep-after-rewrite'
      ]);
      expect(new Set(after.map((event) => event.seq)).size).toBe(3);
    });

  it('synchronizes reads only with their target session instead of flushing every open session', async () => {
      const first = await createSession({ title: 'read target' });
      const other = await createSession({ title: 'unrelated writer' });
      await appendEvent(first.id, { time: 1000, source: 'app', kind: 'note', message: { text: 'a', truncated: false, chars: 1 } });
      await appendEvent(other.id, { time: 1001, source: 'app', kind: 'note', message: { text: 'b', truncated: false, chars: 1 } });

      await readEvents(first.id);
      const otherMetaAfterFullRead = JSON.parse(
        await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
      ) as { events: number };
      expect(otherMetaAfterFullRead.events).toBe(0);

      await flushSessions();
      const otherMetaAfterExplicitFlush = JSON.parse(
        await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
      ) as { events: number };
      expect(otherMetaAfterExplicitFlush.events).toBe(1);

      await appendEvent(first.id, { time: 1002, source: 'app', kind: 'note', message: { text: 'c', truncated: false, chars: 1 } });
      await appendEvent(other.id, { time: 1003, source: 'app', kind: 'note', message: { text: 'd', truncated: false, chars: 1 } });
      await readRecentEvents(first.id, 10);
      const otherMetaAfterRecentRead = JSON.parse(
        await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
      ) as { events: number };
      expect(otherMetaAfterRecentRead.events).toBe(1);
    });

  it('pages backwards over journal and canonical messages without overlapping sequence boundaries', async () => {
      const session = await createSession({ title: 'backward history' });
      for (let i = 0; i < 12; i++) await appendEvent(session.id, {
        time: 1000 + i, source: 'extension', kind: 'user_message', messageId: `back-${i}`,
        message: { text: `message ${i}`, truncated: false, chars: 10 }
      } as never);
      const seen = new Set<number>();
      let before: number | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await readRecentEvents(session.id, 3, { before });
        if (!page.length) break;
        expect(page.length).toBeLessThanOrEqual(3);
        for (const event of page) { expect(seen.has(event.seq)).toBe(false); seen.add(event.seq); }
        before = Math.min(...page.map(event => event.seq));
      }
      expect(seen.size).toBeGreaterThanOrEqual(12);
    });

  it('pages revised long answers by origin in both directions while live deltas still use revision sequence', async () => {
      const session = await createSession({ title: 'Origin paging' });
      const body = { text: 'Detailed review. '.repeat(1200), truncated: false, chars: 19200 };
      const revisedBody = { text: 'Detailed review revised.', truncated: false, chars: 24 };
      const answer = { kind: 'assistant_message' as const, source: 'extension' as const,
        time: 100, messageId: 'long-review', message: body, final: true };
      const first = await upsertMessageEvent(session.id, answer);
      for (let i = 0; i < 12; i++) await appendEvent(session.id, {
        time: 200 + i, source: 'app', kind: 'note', message: { text: `later ${i}`, truncated: false, chars: 8 }
      });
      const revised = await upsertMessageEvent(session.id, { ...answer, message: revisedBody });
      expect(revised.event.seq).toBeGreaterThan(first.event.seq);
      const all = await readEvents(session.id);
      const expected = all.map(positionOf).sort((a, b) => a - b);
      const backwards: number[] = [];
      let before: number | undefined;
      for (;;) {
        const page = await readRecentEvents(session.id, 3, { before, orderByOrigin: true });
        if (!page.length) break;
        backwards.push(...page.map(positionOf));
        before = Math.min(...page.map(positionOf));
      }
      expect(backwards.sort((a, b) => a - b)).toEqual(expected);
      const forwards: number[] = [];
      let after = 0;
      for (;;) {
        const page = await readRecentEvents(session.id, 3, { after, orderByOrigin: true });
        if (!page.length) break;
        forwards.push(...page.map(positionOf));
        after = Math.max(...page.map(positionOf));
      }
      expect(forwards).toEqual(expected);
      expect((await readEvents(session.id, { from: revised.event.seq })).find(e => e.kind === 'assistant_message')).toMatchObject({
        seq: revised.event.seq, origin: first.event.seq, message: revisedBody
      });
    });

  it('counts stable legacy message revisions once when building a recent presentation window', async () => {
      const summary = await createSession({ title: 'legacy recent dedupe' });
      await appendEvent(summary.id, {
        time: 1_000,
        source: 'extension',
        kind: 'user_message',
        messageId: 'legacy-user-1',
        message: { text: 'original user request', truncated: false, chars: 21 }
      } as never);
      // Pre-canonical recordings could append every streaming snapshot of one stable ChatGPT message to events.jsonl. The recent reader used those revisions as separate rows, so a long answer could fill Goal Mode's entire recent window with copies of itself and hide the user turn it was answering. Newest-first scanning should keep the latest revision for a stable message id, but keep walking until it has the requested number of logical messages.
      for (let index = 0; index < 8; index++) {
        await appendEvent(summary.id, {
          time: 1_001 + index,
          source: 'extension',
          kind: 'assistant_message',
          messageId: 'legacy-assistant-1',
          message: { text: `answer revision ${index}`, truncated: false, chars: 17 },
          final: index === 7
        } as never);
      }

      const recent = await readRecentEvents(summary.id, 2, {
        kinds: ['user_message', 'assistant_message']
      });
      expect(recent).toHaveLength(2);
      expect(recent.map((event) => event.kind)).toEqual(['user_message', 'assistant_message']);
      expect(recent[1]?.kind === 'assistant_message' ? recent[1].message.text : '').toBe('answer revision 7');
    });

  it('negative-caches unknown current conversation lookups until that exact attachment can be created', async () => {
      const conversationId = `conv-missing-${Date.now()}`;
      const readdir = vi.spyOn(fs, 'readdir');
      const rootPath = sessionsRoot();
      const rootReads = (): number => readdir.mock.calls.filter(([target]) => String(target) === rootPath).length;

      // Restored in `finally`, like every other readdir spy in this file. Restoring on the success path alone turns one failure here into a file-wide cascade: the spy survives the failing test, the next test binds `realReaddir` to that leaked spy and installs its own delegating to it, and the pair recurses until "Maximum call stack size exceeded" — which is what the failure then reads as, in a different test, with the real one buried.
      try {
        expect(await findSessionByConversation(conversationId)).toBeNull();
        expect(rootReads()).toBe(1);
        expect(await findSessionByConversation(conversationId)).toBeNull();
        expect(rootReads()).toBe(1);

        const created = await createSession({ conversationId, title: 'now attached' });
        expect((await findSessionByConversation(conversationId))?.id).toBe(created.id);
        // The durable create updates the derived attachment catalog directly. No second global metadata scan is needed merely to discover the session this process just committed.
        expect(rootReads()).toBe(1);
      } finally {
        readdir.mockRestore();
      }
    });

  it('invalidates a cached miss before an in-flight session creation can be hidden by it', async () => {
      const conversationId = `conv-creating-${Date.now()}`;
      expect(await findSessionByConversation(conversationId)).toBeNull();

      const realWriteFile = fs.writeFile.bind(fs);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const creationVisible = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let paused = false;
      const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(
        (async (target: Parameters<typeof fs.writeFile>[0], ...args: unknown[]) => {
          if (!paused && String(target).endsWith('messages.json')) {
            paused = true;
            reached();
            await gate;
          }
          return (realWriteFile as (...callArgs: unknown[]) => ReturnType<typeof fs.writeFile>)(target, ...args);
        }) as typeof fs.writeFile
      );

      try {
        const creating = createSession({ conversationId, title: 'in flight' });
        await creationVisible;
        const visible = await findSessionByConversation(conversationId);
        expect(visible?.conversationId).toBe(conversationId);
        release();
        expect((await creating).id).toBe(visible?.id);
      } finally {
        release();
        writeSpy.mockRestore();
      }
    });

  it('finds an attachment beyond the 5,000-session maintenance scan cap', async () => {
      const seed = await createSession({ title: 'catalog seed', conversationId: null });
      await flushSessions();
      // Clone an actual persisted checkpoint, including its private version/watermark fields. A public summary is a legacy fixture and causes 5,001 real migrations.
      const seedSummary = JSON.parse(await fs.readFile(path.join(sessionsRoot(), seed.id, 'meta.json'), 'utf8'));
      const seedStat = await fs.stat(path.join(sessionsRoot(), seed.id, 'meta.json'));
      // Force the next lookup to rebuild from the durable catalog rather than the live seed.
      resetSessionStoreForTests();

      const conversationId = `conv-deep-catalog-${Date.now()}`;
      const names = Array.from({ length: 5001 }, (_, index) => `catalog-${String(index).padStart(5, '0')}`);
      const targetId = names[names.length - 1] as string;
      const realReaddir = fs.readdir.bind(fs);
      const realReadFile = fs.readFile.bind(fs);
      const realStat = fs.stat.bind(fs);
      const rootPath = sessionsRoot();
      const virtualNames = new Set(names);
      const virtualId = (file: string): string | null => {
        const parts = path.relative(rootPath, file).split(path.sep);
        return parts.length === 2 && virtualNames.has(parts[0]!) ? parts[0]! : null;
      };
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(
        (async (target: Parameters<typeof fs.stat>[0], ...args: unknown[]) => {
          const file = String(target);
          if (virtualId(file)) {
            if (path.basename(file) === 'meta.json') return seedStat;
            throw Object.assign(new Error('synthetic catalog has no message history'), { code: 'ENOENT' });
          }
          return (realStat as (...callArgs: unknown[]) => ReturnType<typeof fs.stat>)(target, ...args);
        }) as typeof fs.stat
      );
      const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
        (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
          if (String(target) === rootPath) return names;
          return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
        }) as typeof fs.readdir
      );
      const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
        (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
          const file = String(target);
          const id = virtualId(file);
          if (path.basename(file) === 'meta.json' && id) {
            return JSON.stringify({
              ...seedSummary,
              id,
              title: id,
              conversationId: id === targetId ? conversationId : null,
              chatIds: id === targetId ? [conversationId] : []
            });
          }
          return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
        }) as typeof fs.readFile
      );

      try {
        expect((await findSessionByConversation(conversationId, { requireUnique: true }))?.id).toBe(targetId);
        expect((await realReaddir(rootPath)).some(name => virtualNames.has(name))).toBe(false);
      } finally {
        readSpy.mockRestore();
        readdirSpy.mockRestore();
        statSpy.mockRestore();
        resetSessionStoreForTests();
        await deleteSession(seed.id);
      }
    }, 90_000);

  it('does not cache a transient root scan failure as an authoritative empty attachment catalog', async () => {
      const conversationId = `conv-transient-catalog-${Date.now()}`;
      const created = await createSession({ conversationId, title: 'durable attachment' });
      await flushSessions();
      resetSessionStoreForTests();

      const rootPath = sessionsRoot();
      const realReaddir = fs.readdir.bind(fs);
      let failedOnce = false;
      const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
        (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
          if (!failedOnce && String(target) === rootPath) {
            failedOnce = true;
            throw Object.assign(new Error('transient session-root read failure'), { code: 'EBUSY' });
          }
          return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
        }) as typeof fs.readdir
      );

      try {
        await expect(findSessionByConversation(conversationId, { requireUnique: true })).rejects.toMatchObject({
          code: 'EBUSY'
        });
        expect((await findSessionByConversation(conversationId, { requireUnique: true }))?.id).toBe(created.id);
      } finally {
        readdirSpy.mockRestore();
      }
    });

  it('numbers events in append order and reads them back unchanged', async () => {
      const summary = await createSession({ title: 'ordering', conversationId: null });
      const kinds: SessionEvent['kind'][] = ['user_message', 'turn_start', 'progress', 'turn_end'];
      await appendEvent(summary.id, {
        time: 1000,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'do the thing', truncated: false, chars: 12 }
      });
      await appendEvent(summary.id, { time: 1001, source: 'extension', kind: 'turn_start' });
      await appendEvent(summary.id, {
        time: 1002,
        source: 'extension',
        kind: 'progress',
        message: { text: 'reading files', truncated: false, chars: 13 }
      });
      await appendEvent(summary.id, { time: 1003, source: 'extension', kind: 'turn_end', outcome: 'completed' });

      const events = await readEvents(summary.id);
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(events.map((event) => event.kind)).toEqual(kinds);
    });

  /** A file that cannot be read right now is not a file that holds nothing. Reported as #393 from Windows 11: thirteen `no valid metadata projection` warnings inside thirteen milliseconds across several sessions — one catalog sweep, which reads sixty-four folders at a time — and from then on the app behaved as if those chats did not exist. Genuine corruption does not arrive in every session at the same instant; a share lock or an exhausted descriptor table does. Every read path here used to answer such a failure with the value that means "empty", and the empty answer is the destructive one: an unread journal is reported as sequence zero, and the projection is then stamped over a full session. */
    it('answers a locked journal with a failure instead of stamping the session empty', async () => {
      const session = await createSession({ title: 'locked journal', conversationId: 'locked-journal' });
      await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'work' });
      await appendEvent(session.id, { time: 200, source: 'extension', kind: 'turn_end', turnId: 'work', outcome: 'completed' });
      await flushSessions();
      const folder = path.join(sessionsRoot(), session.id);
      const metaBefore = await fs.readFile(path.join(folder, 'meta.json'), 'utf8');
      const journalBefore = await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8');
      resetRecorderForTests();
      resetSessionStoreForTests();

      const stat = fs.stat.bind(fs);
      const spy = vi.spyOn(fs, 'stat').mockImplementation((async (target, ...args) => {
        if (String(target) === path.join(folder, 'events.jsonl')) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
        return stat(target, ...args);
      }) as typeof fs.stat);
      try {
        await expect(getSession(session.id)).rejects.toThrow(/locked/);
      } finally {
        spy.mockRestore();
      }

      // Nothing was rewritten while the answer was unknown, so the session is simply itself again.
      expect(await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8')).toBe(journalBefore);
      expect(await fs.readFile(path.join(folder, 'meta.json'), 'utf8')).toBe(metaBefore);
      resetSessionStoreForTests();
      expect((await readEvents(session.id)).map(event => event.seq)).toEqual([1, 2]);
      expect((await getSession(session.id))?.timelineTurns?.work).toMatchObject({ time: 100 });
    });

  /** An empty folder is not a session, and does not get a warning about one. `refusing to treat it as an empty session` was written for metadata that went missing under a session that still has its history. A folder with nothing in it says the same sentence, and it reached two bug reports that way: measured from a reporter's log on 2026-09-25, the same pair of warnings every few minutes for hours, both files simply absent, nothing lost and nothing for anybody to do about it. */
    it('says nothing about a session folder that holds nothing, and still reports one that lost its metadata', async () => {
      const empty = path.join(sessionsRoot(), '2026-09-25-0000beef');
      await fs.mkdir(empty, { recursive: true });
      const log = vi.spyOn(console, 'warn');
      try {
        resetSessionStoreForTests();
        expect(await getSession('2026-09-25-0000beef')).toBeNull();
        const lines = getLog().filter(entry => entry.message.includes('2026-09-25-0000beef')).map(entry => entry.message);
        expect(lines, `an empty folder was reported as a session: ${lines.join(' | ')}`).toHaveLength(0);

        // The same folder with history and no metadata is the case the sentence was written for.
        await fs.writeFile(path.join(empty, 'events.jsonl'),
          `${JSON.stringify({ seq: 1, kind: 'note', time: 1, source: 'app', message: { text: 'kept', chars: 4, truncated: false } })}\n`);
        resetSessionStoreForTests();
        await getSession('2026-09-25-0000beef');
        expect(getLog().some(entry => entry.message.includes('2026-09-25-0000beef') && /meta\.json absent/.test(entry.message))).toBe(true);
      } finally {
        log.mockRestore();
        await fs.rm(empty, { recursive: true, force: true });
      }
    });

  /** A file where a session folder should be is an answer, not a refusal. Anything with a session-shaped name in the history folder is read as a session — a stray file somebody dropped there, a leftover from a copy. Opening `<that file>/meta.json` fails with ENOTDIR, which is not a filesystem refusing to cooperate: there is no projection under a file and never was. Reporting it as unreadable would stop the catalog from being cached for the life of the process because of one thing that is not a session at all. */
    it('reads a file sitting where a session folder would be as simply absent', async () => {
      const present = await createSession({ title: 'real session', conversationId: 'stray-neighbour' });
      await flushSessions();
      const stray = path.join(sessionsRoot(), '2026-09-25-deadbeef');
      await fs.writeFile(stray, 'not a session');
      try {
        resetRecorderForTests();
        resetSessionStoreForTests();
        expect((await findSessionByConversation('stray-neighbour', { requireUnique: true }))?.id).toBe(present.id);
        expect(await getSession('2026-09-25-deadbeef')).toBeNull();
      } finally {
        await fs.rm(stray, { force: true });
      }
    });

  /** The three answers metadata can give, told apart. `refusing to treat it as an empty session` named neither the file's state nor whether the validated checkpoint beside it was usable, so #393 could not be read as either "your meta.json was truncated" or "this machine would not let the app read it" — which are a restore and a lock, and nothing a reader does about one helps the other. */
    it('recovers a damaged projection from its checkpoint and refuses an unreadable one', async () => {
      const session = await createSession({ title: 'damaged projection', conversationId: 'damaged-projection' });
      await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'work' });
      await flushSessions();
      await appendEvent(session.id, { time: 200, source: 'extension', kind: 'turn_end', turnId: 'work', outcome: 'completed' });
      await flushSessions();
      const folder = path.join(sessionsRoot(), session.id);
      expect((await fs.stat(path.join(folder, 'meta.backup.json'))).size).toBeGreaterThan(0);

      // Truncated bytes are the session's own damage, and the checkpoint is what it is for.
      await fs.writeFile(path.join(folder, 'meta.json'), '{"id":"damaged-pro');
      resetRecorderForTests();
      resetSessionStoreForTests();
      expect((await getSession(session.id))?.title).toBe('damaged projection');

      // A refusal to read is not damage, and may not be answered as "no such session".
      resetSessionStoreForTests();
      const readFile = fs.readFile.bind(fs);
      const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        if (String(target).startsWith(path.join(folder, 'meta'))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return (readFile as (...input: unknown[]) => Promise<unknown>)(target, ...args);
      }) as unknown as typeof fs.readFile);
      try {
        await expect(getSession(session.id)).rejects.toThrow(/EACCES/);
      } finally {
        spy.mockRestore();
      }
    });

  /** One unreadable folder may not outlive the moment it was unreadable. The catalog is built once and kept for the life of the process — it answers ownership, retention and the newest resumable handoff — so a folder dropped from one sweep used to be missing from every later answer too. That is the shape #393 reports: the chats came back after a restart, because only the restart rebuilt the catalog. */
    it('does not keep a catalog that lost a folder to a read failure', async () => {
      const present = await createSession({ title: 'readable', conversationId: 'catalog-readable' });
      const blocked = await createSession({ title: 'blocked', conversationId: 'catalog-blocked' });
      await flushSessions();
      resetRecorderForTests();
      resetSessionStoreForTests();

      const folder = path.join(sessionsRoot(), blocked.id);
      const readFile = fs.readFile.bind(fs);
      const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        if (String(target).startsWith(path.join(folder, 'meta'))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return (readFile as (...input: unknown[]) => Promise<unknown>)(target, ...args);
      }) as unknown as typeof fs.readFile);
      try {
        expect(await findSessionByConversation('catalog-readable', { requireUnique: true })).not.toBeNull();
        expect(await findSessionByConversation('catalog-blocked', { requireUnique: true })).toBeNull();
      } finally {
        spy.mockRestore();
      }

      // The lock is gone, and so is the belief that the session was not there.
      expect((await findSessionByConversation('catalog-blocked', { requireUnique: true }))?.id).toBe(blocked.id);
      expect((await findSessionByConversation('catalog-readable', { requireUnique: true }))?.id).toBe(present.id);
    });

  /** The publishing rename may not outrun the bytes it publishes. `writeFile` then `rename` makes the *name* change atomically and says nothing about the contents: the entry can be in place while the data is still in the page cache, so an unclean shutdown in that window leaves a meta.json that exists and is empty — which is exactly the damage the recovery path above cannot undo, since a zero-length projection is no longer a projection of anything. Both the summary and the checkpoint it rotates are flushed first. */
    it('flushes a summary and its checkpoint before the rename that publishes them', async () => {
      const steps: string[] = [];
      const label = (file: unknown): string =>
        String(file).includes('meta.backup.json') ? 'checkpoint' : String(file).includes('meta.json') ? 'summary' : '';
      const open = fs.open.bind(fs);
      const rename = fs.rename.bind(fs);
      const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (file, ...args) => {
        const handle = await open(file as string, ...args as []);
        const named = label(file);
        if (named) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { steps.push(`flush ${named}`); return sync(); };
        }
        return handle;
      }) as typeof fs.open);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((async (from, to) => {
        if (label(to)) steps.push(`publish ${label(to)}`);
        return rename(from as string, to as string);
      }) as typeof fs.rename);
      try {
        const session = await createSession({ title: 'durable summary' });
        await appendEvent(session.id, { time: 100, source: 'extension', kind: 'turn_start', turnId: 'work' });
        await flushSessions();
      } finally {
        openSpy.mockRestore();
        renameSpy.mockRestore();
      }
      // The first write has no valid predecessor to keep; the second rotates one.
      expect(steps.slice(0, 2)).toEqual(['flush summary', 'publish summary']);
      expect(steps).toContain('flush checkpoint');
      for (let i = 0; i < steps.length; i++) {
        if (steps[i]!.startsWith('publish')) {
          expect(steps.slice(0, i), `${steps[i]} was published unflushed`)
            .toContain(`flush ${steps[i]!.slice('publish '.length)}`);
        }
      }
    });

  it.each([false, true])('keeps recovered replies in their original turn across bounded reads and legacy restart (%s)', async restart => {
      const session = await createSession({ title: 'paged turn boundaries', conversationId: 'timeline-boundaries' });
      const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
      await upsertMessageEvent(session.id, { kind: 'user_message', messageId: 'first-question', time: 90, source: 'extension', message: text('First question') });
      const start = await appendEvent(session.id, { kind: 'turn_start', turnId: 'first', time: 100, source: 'extension' });
      await appendEvent(session.id, { kind: 'progress', turnId: 'first', time: 120, source: 'app', message: text('First work') });
      await appendEvent(session.id, { kind: 'turn_end', turnId: 'first', time: 180, source: 'extension', outcome: 'completed' });
      await upsertMessageEvent(session.id, { kind: 'user_message', messageId: 'second-question', time: 200, source: 'extension', message: text('Second question') });
      await appendEvent(session.id, { kind: 'turn_start', turnId: 'second', time: 210, source: 'extension' });
      const work = await appendEvent(session.id, { kind: 'progress', turnId: 'second', time: 230, source: 'app', message: text('Second work') });
      const recovered = await upsertMessageEvent(session.id, { kind: 'assistant_message', turnId: 'first', time: 290,
        authoredAt: 150, messageId: 'first-reply', source: 'extension', message: text('Recovered first answer'), final: true });
      await upsertMessageEvent(session.id, { kind: 'assistant_message', turnId: 'second', time: 280,
        messageId: 'second-reply', source: 'extension', message: text('Second answer'), final: true });
      await appendEvent(session.id, { kind: 'turn_end', turnId: 'second', time: 300, source: 'extension', outcome: 'completed' });
      await flushSessions();
      const folder = path.join(sessionsRoot(), session.id);
      const journal = await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8');
      const before = await readEvents(session.id);
      const coordinates = (event: SessionEvent) => ({ seq: event.seq, position: positionOf(event), time: event.time, turnId: event.turnId });
      const original = before.map(coordinates);
      if (restart) {
        resetRecorderForTests(); resetSessionStoreForTests();
        for (const name of ['meta.json', 'meta.backup.json']) {
          const file = path.join(folder, name);
          const metadata = JSON.parse(await fs.readFile(file, 'utf8'));
          delete metadata.timelineTurns;
          await fs.writeFile(file, JSON.stringify(metadata));
        }
      }
      const page = await readRecentEvents(session.id, 4, { orderByOrigin: true });
      expect(page[0]).toMatchObject({ kind: 'assistant_message', messageId: 'first-reply',
        seq: recovered.event.seq, origin: recovered.event.origin, time: 290, authoredAt: 150, turnId: 'first', turnOrigin: start.seq });
      expect(page[1]?.seq).toBe(work.seq);
      const full = await readEvents(session.id);
      expect(full.map(coordinates)).toEqual(original);
      for (const row of full) {
        const older = await readRecentEvents(session.id, 3, { before: positionOf(row) + 1, orderByOrigin: true });
        const keys = new Set(older.map(event => event.seq));
        expect(older.map(event => event.seq)).toEqual(full.filter(event => keys.has(event.seq)).map(event => event.seq));
      }
      expect((await getSession(session.id))?.activeTurnId).toBeNull();
      expect((await getSession(session.id))?.timelineTurns?.first).toEqual({ origin: start.seq, time: 100,
        endTime: 180, endOrigin: 4, questionId: 'first-question' });
      expect(await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8')).toBe(journal);
    });

  it.each([false, true])('keeps reloaded interim prose before later tools across every read path and restart (%s)', async restart => {
      const session = await createSession({ title: 'native interim ordering', conversationId: 'interim-order' });
      const working = '11111111-1111-4111-8111-111111111111';
      const exchange = '22222222-2222-4222-8222-222222222222';
      const parent = '33333333-3333-4333-8333-333333333333';
      const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
      const start = await appendEvent(session.id, { kind: 'turn_start', source: 'extension', time: 100, turnId: 'working' });
      await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: 110,
        messageId: `assistant:${parent}:${working}:${exchange}`, turnId: 'working', message: text('First update'), final: false });
      const later = await appendEvent(session.id, { kind: 'tool_call', source: 'mcp', time: 150, turnId: 'working',
        call: { callId: 'later-tool', tool: 'read', requestId: 'interim-request', conversationId: 'interim-order',
          attribution: 'request_id', attributionMethod: 'request_id', args: text('{}'), result: text('ok'), outcome: 'ok', durationMs: 1,
          summary: { kind: 'read', title: 'Later tool', tone: 'neutral' } } });
      const interim = await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', time: 140,
        messageId: `assistant:${exchange}:${working}:${exchange}`, message: text('Second update'), final: false });
      await flushSessions();
      const folder = path.join(sessionsRoot(), session.id);
      const journal = await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8');
      const shardName = createHash('sha256').update(`assistant_message\u0000${interim.event.messageId}`).digest('hex') + '.json';
      const shard = await fs.readFile(path.join(folder, 'messages', shardName), 'utf8');
      if (restart) resetSessionStoreForTests();
      const full = await readEvents(session.id);
      expect(full.map(row => row.seq)).toEqual([start.seq, 2, interim.event.seq, later.seq]);
      for (const page of [
        await readRecentEvents(session.id, 2, { orderByOrigin: true }),
        await readRecentEvents(session.id, 2, { after: 2, orderByOrigin: true }),
        await readEvents(session.id, { from: 3, limit: 2 }),
        (await readActivityEvents(session.id, 3, 2)).events
      ]) {
        expect(page.map(row => row.seq)).toEqual([interim.event.seq, later.seq]);
        expect(page[0]).toMatchObject({ origin: interim.event.origin, time: 140, turnOrigin: start.seq });
        expect(page[0]?.turnId).toBeUndefined();
      }
      const summary = await getSession(session.id);
      expect(summary?.activeTurnId).toBe('working');
      expect(summary?.lastAssistantFinalAt).toBeNull();
      expect(await fs.readFile(path.join(folder, 'events.jsonl'), 'utf8')).toBe(journal);
      expect(await fs.readFile(path.join(folder, 'messages', shardName), 'utf8')).toBe(shard);
    });
});
