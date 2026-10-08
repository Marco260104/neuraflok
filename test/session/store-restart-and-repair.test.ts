import {
  appendEvent,
  createSession,
  eventTokens,
  flushSessions,
  fs,
  getSession,
  listSessions,
  path,
  readEvents,
  rebindSession,
  resetSessionStoreForTests,
  saveHandoff,
  sessionsRoot,
  upsertMessageEvent,
} from './context.js';
import type {
  SessionEvent,
  ToolOutcome,
} from './context.js';
import { describe, expect, it } from 'vitest';

describe('session store', () => {
  it('shares one disk reconstruction across concurrent callers after a restart', async () => {
      const summary = await createSession({ title: 'concurrent reopen' });
      resetSessionStoreForTests();

      const written = await Promise.all([
        appendEvent(summary.id, {
          time: 20,
          source: 'app',
          kind: 'note',
          message: { text: 'first concurrent writer', truncated: false, chars: 23 }
        }),
        appendEvent(summary.id, {
          time: 21,
          source: 'app',
          kind: 'note',
          message: { text: 'second concurrent writer', truncated: false, chars: 24 }
        })
      ]);

      expect(written.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2]);
      expect((await readEvents(summary.id)).map((event) => event.seq)).toEqual([1, 2]);
    });

  it('skips a torn final line and keeps appending after it', async () => {
      const summary = await createSession({ title: 'recovery' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'first', truncated: false, chars: 5 }
      });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'second', truncated: false, chars: 6 }
      });

      // Exactly what a crash mid-append leaves behind: a line with no closing brace.
      const file = path.join(sessionsRoot(), summary.id, 'events.jsonl');
      await fs.appendFile(file, '{"seq":3,"kind":"user_mess', 'utf8');
      resetSessionStoreForTests();

      const recovered = await readEvents(summary.id);
      expect(recovered).toHaveLength(2);

      await appendEvent(summary.id, {
        time: 4,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'third', truncated: false, chars: 5 }
      });
      const all = await readEvents(summary.id);
      expect(all).toHaveLength(3);
      // The number after a torn line must not collide with one already used.
      expect(new Set(all.map((event) => event.seq)).size).toBe(3);
      expect(all[2]!.seq).toBeGreaterThan(all[1]!.seq);
    });

  it('recovers the prior sequence behind a near-limit torn final line', async () => {
      const summary = await createSession({ title: 'large torn tail recovery' });
      const prior = await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'chat_error',
        message: { text: 'durable predecessor', truncated: false, chars: 19 }
      });
      const file = path.join(sessionsRoot(), summary.id, 'events.jsonl');
      // Larger than the historical 128 KiB restart window, but still within the maximum amount a crash can leave from one otherwise legal event line.
      await fs.appendFile(file, `{"seq":${prior.seq + 1},"kind":"chat_error","padding":"${'x'.repeat(400 * 1024)}`, 'utf8');
      resetSessionStoreForTests();

      const next = await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'chat_error',
        message: { text: 'after restart', truncated: false, chars: 13 }
      });

      expect(next.seq).toBe(prior.seq + 1);
      expect((await readEvents(summary.id)).map((event) => event.seq)).toEqual([prior.seq, next.seq]);
    });

  it('recovers a session whose meta.json is gone', async () => {
      const summary = await createSession({ title: 'no meta' });
      await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start' });
      resetSessionStoreForTests();
      await fs.rm(path.join(sessionsRoot(), summary.id, 'meta.json'), { force: true });

      await appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_end', outcome: 'completed' });
      const events = await readEvents(summary.id);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
    });

  it('reconciles durable journal state when a crash loses the debounced metadata write', async () => {
      const summary = await createSession({ title: 'stale meta journal recovery' });
      const handoffId = '2026-08-25-crash001';
      await appendEvent(summary.id, { time: 10, source: 'extension', kind: 'turn_start', turnId: 'turn-crash' });
      await appendEvent(summary.id, {
        time: 11,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'durable before the crash', truncated: false, chars: 24 }
      });
      await appendEvent(summary.id, {
        time: 12,
        source: 'extension',
        kind: 'chat_error',
        message: { text: 'also durable', truncated: false, chars: 12 }
      });
      await saveHandoff({
        id: handoffId,
        sessionId: summary.id,
        createdAt: 13,
        text: 'TASK — recover this durable handoff',
        sourceEvents: 3,
        sourceTokens: 10,
        notes: []
      });
      await appendEvent(summary.id, {
        time: 13,
        source: 'app',
        kind: 'handoff',
        handoffId,
        chars: 34,
        reason: 'manual'
      });

      const staleMeta = JSON.parse(
        await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
      ) as { events: number; lastHandoffId: string | null };
      expect(staleMeta.events).toBe(0);
      expect(staleMeta.lastHandoffId).toBeNull();

      // Simulate process death before the 1.5 s metadata debounce fires. The next mutation opens from disk and must project the four already-durable records before applying sequence 5.
      resetSessionStoreForTests();
      const afterCrash = await appendEvent(summary.id, {
        time: 14,
        source: 'app',
        kind: 'note',
        message: { text: 'after restart', truncated: false, chars: 13 }
      });
      expect(afterCrash.seq).toBe(5);

      const recovered = await getSession(summary.id);
      expect(recovered).toMatchObject({
        events: 5,
        userMessages: 1,
        errors: 1,
        activeTurnId: 'turn-crash',
        lastHandoffId: handoffId,
        lastHandoffAt: 13
      });
    });

  it('repairs a stale metadata projection on the first read after restart without a new mutation', async () => {
      const summary = await createSession({ title: 'read-only crash recovery' });
      const handoffId = '2026-08-25-readonly1';
      await appendEvent(summary.id, { time: 30, source: 'extension', kind: 'turn_start', turnId: 'turn-read' });
      await appendEvent(summary.id, {
        time: 31,
        source: 'extension',
        kind: 'user_message',
        message: { text: 'survived on disk', truncated: false, chars: 16 }
      });
      await saveHandoff({
        id: handoffId,
        sessionId: summary.id,
        createdAt: 32,
        text: 'TASK — read-only recovery',
        sourceEvents: 2,
        sourceTokens: 8,
        notes: []
      });
      await appendEvent(summary.id, {
        time: 32,
        source: 'app',
        kind: 'handoff',
        handoffId,
        chars: 25,
        reason: 'manual'
      });

      const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
      expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({ events: 0, lastHandoffId: null });

      // Simulate process death before the metadata debounce. There is deliberately no append, reopen or other mutation after reset: merely opening history must repair the projection.
      resetSessionStoreForTests();
      const recovered = await getSession(summary.id);
      expect(recovered).toMatchObject({
        events: 3,
        userMessages: 1,
        activeTurnId: 'turn-read',
        lastHandoffId: handoffId,
        lastHandoffAt: 32
      });
      expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({
        events: 3,
        userMessages: 1,
        lastHandoffId: handoffId
      });
    });

  const toolCall = (callId: string, tool: string, outcome: string, metric: string | undefined, seq: number) => ({
      time: 100 + seq,
      source: 'app' as const,
      kind: 'tool_call' as const,
      call: {
        callId,
        tool,
        attribution: 'unattributed' as const,
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed' as const,
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: outcome as ToolOutcome,
        durationMs: 1,
        summary: { title: callId, tone: 'neutral' as const, kind: 'run' as const, ...(metric ? { metric } : {}) }
      }
    });

  it('charges the reliability count for a defect here and for nothing else', async () => {
      const summary = await createSession({ title: 'reliability numerator' });
      await appendEvent(summary.id, toolCall('clean', 'exec_command', 'ok', undefined, 1));
      await appendEvent(summary.id, toolCall('failing-build', 'exec_command', 'process_exit_nonzero', undefined, 2));
      await appendEvent(summary.id, toolCall('refused', 'apply_patch', 'tool_rejected', undefined, 3));
      expect(await getSession(summary.id)).toMatchObject({ toolCalls: 3, errors: 0 });

      await appendEvent(summary.id, toolCall('broken', 'exec_command', 'tool_internal_error', undefined, 4));
      expect(await getSession(summary.id)).toMatchObject({
        toolCalls: 4,
        processExitNonzero: 1,
        toolRejected: 1,
        toolInternalErrors: 1,
        errors: 1
      });
    });

  it('re-derives outcome counters for a session recorded before the taxonomy existed', async () => {
      const summary = await createSession({ title: 'legacy outcome projection' });
      await appendEvent(summary.id, toolCall('legacy-exit', 'exec_command', 'error', '✕ exit 7', 1));
      await appendEvent(summary.id, toolCall('legacy-refusal', 'apply_patch', 'rejected', 'refused', 2));
      await appendEvent(summary.id, toolCall('legacy-ambiguous', 'read', 'error', undefined, 3));
      await flushSessions();

      const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
      const stored = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      delete stored.processExitNonzero;
      delete stored.toolRejected;
      delete stored.toolInternalErrors;
      stored.errors = 3;
      await fs.writeFile(metaPath, JSON.stringify(stored, null, 2), 'utf8');

      resetSessionStoreForTests();
      const expected = { processExitNonzero: 1, toolRejected: 1, toolInternalErrors: 0, errors: 0 };
      expect(await getSession(summary.id)).toMatchObject({ toolCalls: 3, ...expected });
      expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject(expected);

      const outcomes = (await readEvents(summary.id))
        .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
        .map((event) => event.call.outcome);
      expect(outcomes).toEqual(['error', 'rejected', 'error']);
    });

  it('reconciles a canonical message revision newer than the metadata checkpoint', async () => {
      const summary = await createSession({ title: 'stale meta canonical recovery' });
      const messageId = 'canonical-crash-revision';
      await upsertMessageEvent(summary.id, {
        time: 20,
        source: 'extension',
        kind: 'user_message',
        messageId,
        message: { text: 'small', truncated: false, chars: 5 }
      });
      await flushSessions();

      const revised = await upsertMessageEvent(summary.id, {
        time: 21,
        source: 'extension',
        kind: 'user_message',
        messageId,
        message: { text: 'x'.repeat(400), truncated: false, chars: 400 }
      });
      const checkpoint = JSON.parse(
        await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
      ) as { estimatedTokens: number };
      expect(checkpoint.estimatedTokens).toBeLessThan(eventTokens(revised.event));

      resetSessionStoreForTests();
      const afterCrash = await appendEvent(summary.id, {
        time: 22,
        source: 'app',
        kind: 'note',
        message: { text: 'open recovered state', truncated: false, chars: 20 }
      });
      expect(afterCrash.seq).toBe(revised.event.seq + 1);

      const recovered = await getSession(summary.id);
      expect(recovered?.events).toBe(2);
      expect(recovered?.userMessages).toBe(1);
      const expectedTokens = eventTokens(revised.event) + eventTokens(afterCrash);
      expect(recovered?.estimatedTokens).toBe(expectedTokens);
      expect(recovered?.contextTokens).toBe(expectedTokens);
    });

  it('repairs a canonical message revision while building the read-only session list after restart', async () => {
      const summary = await createSession({ title: 'catalog crash recovery' });
      const messageId = 'canonical-read-only-revision';
      await upsertMessageEvent(summary.id, {
        time: 40,
        source: 'extension',
        kind: 'user_message',
        messageId,
        message: { text: 'tiny', truncated: false, chars: 4 }
      });
      await flushSessions();

      const revised = await upsertMessageEvent(summary.id, {
        time: 41,
        source: 'extension',
        kind: 'user_message',
        messageId,
        message: { text: 'r'.repeat(800), truncated: false, chars: 800 }
      });
      resetSessionStoreForTests();

      const listed = (await listSessions()).find((entry) => entry.id === summary.id);
      expect(listed?.userMessages).toBe(1);
      expect(listed?.events).toBe(1);
      expect(listed?.estimatedTokens).toBe(eventTokens(revised.event));
      expect(listed?.contextTokens).toBe(eventTokens(revised.event));
    });

  it.each([false, true])('migrates legacy return estimates once while preserving frontend resets (rebound=%s)', async rebound => {
      const summary = await createSession({ title: 'return estimate migration', conversationId: 'estimate-source' });
      const call = (conversationId: string, chars: number) => ({ time: Date.now(), source: 'mcp' as const,
        kind: 'tool_call' as const, call: {
          callId: conversationId, conversationId, tool: 'read', attribution: 'request_id' as const,
          requestId: `request-${conversationId}`, attributionMethod: 'request_id' as const,
          args: { text: '{}', chars: 2, truncated: false },
          result: { text: 'preview', chars, truncated: true },
          outcome: 'ok' as const, durationMs: 1, summary: { title: 'Read', tone: 'neutral' as const, kind: 'read' as const }
        } });
      await appendEvent(summary.id, call('estimate-source', 524582));
      if (rebound) {
        expect(await rebindSession(summary.id, 'estimate-source', 'estimate-destination')).toBe(true);
        await appendEvent(summary.id, call('estimate-destination', 80000));
      }
      await flushSessions();
      const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      const expected = { estimatedTokens: meta.estimatedTokens, contextTokens: meta.contextTokens };
      delete meta.__tokenEstimate;
      meta.estimatedTokens += 121146 + (rebound ? 10000 : 0);
      meta.contextTokens += rebound ? 10000 : 121146;
      await fs.writeFile(metaPath, JSON.stringify(meta));
      resetSessionStoreForTests();
      expect((await listSessions()).find(entry => entry.id === summary.id)).toMatchObject(expected);
      expect(JSON.parse(await fs.readFile(metaPath, 'utf8')).__tokenEstimate).toBe(1);
      resetSessionStoreForTests();
      expect(await getSession(summary.id)).toMatchObject(expected);
      const events = await readEvents(summary.id);
      expect(events.find(event => event.kind === 'tool_call' && event.call.conversationId === 'estimate-source'))
        .toMatchObject({ call: { result: { chars: 524582, text: 'preview' } } });
    });
});
