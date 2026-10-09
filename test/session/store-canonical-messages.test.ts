import {
  appendEvent,
  createHash,
  createSession,
  eventTokens,
  flushSessions,
  fs,
  getSession,
  path,
  readEvents,
  resetSessionStoreForTests,
  sessionsRoot,
  upsertMessageEvent,
} from './context.js';
import { describe, expect, it } from 'vitest';

describe('session store', () => {
  it('preserves the legacy authored position when a reload changes the provider timestamp for the same UUID', async () => {
      const session = await createSession({ title: 'reload authored timestamp' });
      const owner = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const providerMessageId = '11111111-2222-4333-8444-555555555555';
      const message = { text: 'The recorded answer', chars: 19, truncated: false };
      const first = await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', final: true,
        messageId: `assistant:${owner}:${owner}:1789662776481`, providerMessageId, time: 1789662900000, message });
      const replay = await upsertMessageEvent(session.id, { kind: 'assistant_message', source: 'extension', final: true,
        messageId: `assistant:${owner}:${owner}:1789662999999`, providerMessageId, time: 1789663000000,
        authoredAt: 1789662999999, message }, { preferTime: true });
      expect(replay.event).toMatchObject({ messageId: first.event.messageId, time: first.event.time,
        origin: first.event.origin, authoredAt: 1789662776481 });
      expect(await readEvents(session.id)).toHaveLength(1);
    });

  it('reorders late events only inside the durable turn that owns them', async () => {
      const summary = await createSession({ title: 'deferred append' });
      await appendEvent(summary.id, { time: 1000, source: 'extension', kind: 'turn_start', turnId: 'g-order' });
      await appendEvent(summary.id, {
        time: 5000,
        source: 'extension',
        kind: 'progress',
        turnId: 'g-order',
        message: { text: 'later progress', truncated: false, chars: 14 }
      });
      // Arrived late, but logically happened between the two rows above.
      await appendEvent(summary.id, {
        time: 2000,
        source: 'extension',
        kind: 'progress',
        turnId: 'g-order',
        message: { text: 'earlier progress', truncated: false, chars: 16 }
      });
      await appendEvent(summary.id, { time: 6000, source: 'extension', kind: 'turn_end', turnId: 'g-order', outcome: 'completed' });
      const events = await readEvents(summary.id);
      expect(events.map((event) => event.kind)).toEqual(['turn_start', 'progress', 'progress', 'turn_end']);
      expect(events.slice(1, 3).map((event) => event.time)).toEqual([2000, 5000]);
      // The JSONL stays append-only: the logically earlier progress still has the later seq.
      expect(events[1]!.seq).toBeGreaterThan(events[2]!.seq);
    });

  it('keeps a session from ageing backwards when a call is written late', async () => {
      const summary = await createSession({ title: 'late append' });
      const now = Date.now();
      await appendEvent(summary.id, { time: now, source: 'extension', kind: 'turn_end', outcome: 'completed' });
      await appendEvent(summary.id, { time: now - 5000, source: 'mcp', kind: 'turn_start' });
      expect((await getSession(summary.id))?.updatedAt).toBe(now);
    });

  it('filters by kind and by starting sequence number', async () => {
      const summary = await createSession({ title: 'filters' });
      for (let i = 0; i < 6; i++) {
        await appendEvent(summary.id, {
          time: 1000 + i,
          source: 'extension',
          kind: i % 2 === 0 ? 'progress' : 'turn_start',
          ...(i % 2 === 0 ? { message: { text: `step ${i}`, truncated: false, chars: 6 } } : {})
        } as never);
      }
      const progress = await readEvents(summary.id, { kinds: ['progress'] });
      expect(progress).toHaveLength(3);
      const tail = await readEvents(summary.id, { from: 4 });
      expect(tail.every((event) => event.seq >= 4)).toBe(true);
      expect(await readEvents(summary.id, { limit: 2 })).toHaveLength(2);
    });

  it('preserves app-staged attachment identity and preview when native metadata observes the same user send', async () => {
      const summary = await createSession({ title: 'attachment custody' });
      const original = { id: 'app-staged-id', name: 'example.png', size: 123, mimeType: 'image/png', preview: 'data:image/webp;base64,YQ==' };
      const base = { kind: 'user_message' as const, source: 'extension' as const, time: 100, messageId: 'native-user',
        message: { text: '', chars: 0, truncated: false } };
      await upsertMessageEvent(summary.id, { ...base, inputId: 'app-input', attachments: [original] });
      await upsertMessageEvent(summary.id, { ...base, attachments: [{ ...original, id: 'provider-file-id', preview: undefined }] });
      const [recorded] = await readEvents(summary.id, { kinds: ['user_message'] });
      expect(recorded).toMatchObject({ inputId: 'app-input', attachments: [original] });
    });

  it('keeps the original anchor when provider creation time changes on reload, without merging sibling messages', async () => {
      const summary = await createSession({ title: 'provider timestamp revision' });
      const row = (messageId: string, providerMessageId: string) => ({
        kind: 'assistant_message' as const, source: 'extension' as const, time: 100,
        messageId, providerMessageId, message: { text: 'Same greeting', chars: 13, truncated: false },
        final: true, state: 'final' as const
      });
      const first = await upsertMessageEvent(summary.id, row('assistant:working:exchange:1000', 'provider-one'));
      await upsertMessageEvent(summary.id, row('assistant:working:exchange:1100', 'provider-two'));
      const replay = await upsertMessageEvent(summary.id,
        { ...row('assistant:working:exchange:2000', 'provider-one'), time: 900 }, { preferTime: true });
      expect(replay.event.messageId).toBe(first.event.messageId);
      expect(replay.event.origin).toBe(first.event.origin);
      expect(replay.event.time).toBe(first.event.time);
      await flushSessions();
      const rows = await readEvents(summary.id, { kinds: ['assistant_message'] });
      expect(rows).toHaveLength(2);
    });

  it('reads already stored reload aliases once at their original position without deleting source shards', async () => {
      const summary = await createSession({ title: 'existing reload aliases' });
      const first = await upsertMessageEvent(summary.id, { kind: 'assistant_message', source: 'extension', time: 100,
        messageId: 'assistant:working:exchange:1000', providerMessageId: 'actual-provider-uuid',
        message: { text: 'The old complete answer.', chars: 24, truncated: false }, final: true, state: 'final' });
      await upsertMessageEvent(summary.id, { kind: 'user_message', source: 'extension', time: 200,
        messageId: 'new-user', message: { text: 'ghjkghk', chars: 7, truncated: false } });
      await flushSessions();
      const duplicate = { ...first.event, seq: first.event.seq + 2, origin: first.event.seq + 2,
        time: 300, messageId: 'assistant:working:exchange:2000', turnId: undefined };
      const name = createHash('sha256').update(`assistant_message\u0000${duplicate.messageId}`).digest('hex') + '.json';
      const file = path.join(sessionsRoot(), summary.id, 'messages', name);
      await fs.writeFile(file, JSON.stringify(duplicate));
      resetSessionStoreForTests();
      const rows = await readEvents(summary.id, { kinds: ['assistant_message', 'user_message'] });
      expect(rows.map(row => row.kind)).toEqual(['assistant_message', 'user_message']);
      expect(rows[0]?.kind === 'assistant_message' && rows[0].origin).toBe(first.event.origin);
      expect(JSON.parse(await fs.readFile(file, 'utf8')).messageId).toBe(duplicate.messageId);
      await upsertMessageEvent(summary.id, { ...duplicate, message: { text: 'The corrected complete answer.', chars: 30, truncated: false } });
      resetSessionStoreForTests();
      expect(await readEvents(summary.id, { kinds: ['assistant_message'] })).toHaveLength(1);
    });

  it('selects terminal alias content independently of cursor and repairs an otherwise current legacy summary once', async () => {
      const summary = await createSession({ title: 'legacy alias checkpoint' });
      const first = await upsertMessageEvent(summary.id, { kind: 'assistant_message', source: 'extension', time: 100,
        messageId: 'first', providerMessageId: 'same-provider', turnId: 'original-turn', goalEligible: true,
        message: { text: 'Old final', chars: 9, truncated: false }, final: true, state: 'final' });
      await flushSessions();
      const metaFile = path.join(sessionsRoot(), summary.id, 'meta.json');
      const baseline = JSON.parse(await fs.readFile(metaFile, 'utf8'));
      const streaming = { ...first.event, messageId: 'streaming-alias', origin: 3, seq: 30, time: 300,
        message: { text: 'Partial', chars: 7, truncated: false }, final: false, state: 'streaming' as const };
      const terminal = { ...first.event, messageId: 'final-alias', origin: 4, seq: 20, time: 400,
        turnId: undefined, goalEligible: undefined,
        message: { text: 'Latest complete final answer', chars: 28, truncated: false } };
      const files: string[] = [];
      for (const event of [streaming, terminal]) {
        const name = createHash('sha256').update(`assistant_message\u0000${event.messageId}`).digest('hex') + '.json';
        const file = path.join(sessionsRoot(), summary.id, 'messages', name);
        await fs.writeFile(file, JSON.stringify(event)); files.push(file);
      }
      const extraTokens = eventTokens(streaming) + eventTokens(terminal);
      const oldMeta = { ...baseline, __historySeq: 30, events: baseline.events + 2,
        estimatedTokens: baseline.estimatedTokens + extraTokens,
        contextTokens: baseline.contextTokens + extraTokens - 1 };
      delete oldMeta.__canonicalProjection;
      await fs.writeFile(metaFile, JSON.stringify(oldMeta));
      resetSessionStoreForTests();
      const recovered = await getSession(summary.id);
      const expectedTokens = baseline.estimatedTokens - eventTokens(first.event) + eventTokens(terminal);
      expect(recovered).toMatchObject({ events: baseline.events, estimatedTokens: expectedTokens,
        contextTokens: Math.max(0, expectedTokens - 1) });
      const rows = await readEvents(summary.id, { kinds: ['assistant_message'], from: 21 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ messageId: 'first', time: 100, origin: first.event.origin,
        seq: 30, turnId: 'original-turn', goalEligible: true, message: terminal.message });
      const repairedMeta = await fs.readFile(metaFile, 'utf8');
      resetSessionStoreForTests();
      expect((await getSession(summary.id))?.estimatedTokens).toBe(expectedTokens);
      expect(await fs.readFile(metaFile, 'utf8')).toBe(repairedMeta);
      expect(JSON.parse(await fs.readFile(files[0]!, 'utf8')).seq).toBe(30);
      expect(JSON.parse(await fs.readFile(files[1]!, 'utf8')).seq).toBe(20);
    });

  it('never downgrades a final canonical message when a stale streaming snapshot arrives later', async () => {
      const summary = await createSession({ title: 'terminal canonical final' });
      const messageId = 'msg-terminal-final';
      const final = await upsertMessageEvent(summary.id, {
        time: 100,
        source: 'extension',
        kind: 'assistant_message',
        messageId,
        message: { text: 'Complete answer.', truncated: false, chars: 16 },
        state: 'final',
        final: true
      });
      const stale = await upsertMessageEvent(summary.id, {
        time: 120,
        source: 'extension',
        kind: 'assistant_message',
        messageId,
        message: { text: 'Complete', truncated: false, chars: 8 },
        state: 'streaming',
        final: false
      });

      expect(stale.changed).toBe(false);
      expect(stale.event.seq).toBe(final.event.seq);
      const [stored] = await readEvents(summary.id, { kinds: ['assistant_message'] });
      expect(stored?.kind === 'assistant_message' && stored.final).toBe(true);
      expect(stored?.kind === 'assistant_message' && stored.message.text).toBe('Complete answer.');
    });

  it('keeps canonical message metadata when the same prose is reobserved', async () => {
      const summary = await createSession({ title: 'sparse rich final' });
      const messageId = 'msg-sparse-rich';
      const providerMessageId = 'f0f00016-1111-4111-8111-111111111111';
      const message = { text: 'Bold answer', truncated: false, chars: 11 };
      await upsertMessageEvent(summary.id, {
        time: 200,
        source: 'extension',
        kind: 'assistant_message',
        messageId,
        message,
        providerMessageId,
        state: 'final',
        final: true
      });
      const repeated = await upsertMessageEvent(summary.id, {
        time: 220,
        source: 'extension',
        kind: 'assistant_message',
        messageId,
        message,
        state: 'final',
        final: true
      });

      expect(repeated.changed).toBe(false);
      expect(repeated.event.kind === 'assistant_message' && repeated.event.providerMessageId).toBe(providerMessageId);
      expect(repeated.event.kind === 'assistant_message' && repeated.event.message.text).toBe('Bold answer');
      expect(await readEvents(summary.id, { kinds: ['assistant_message'] })).toHaveLength(1);
    });

  it('lets an authoritative page-model timestamp correct a delayed DOM first sight', async () => {
      const summary = await createSession({ title: 'authored timestamp correction' });
      const messageId = 'user-authored-time';
      const message = { text: 'the real question', truncated: false, chars: 17 };
      const first = await upsertMessageEvent(summary.id, {
        time: 20_000,
        source: 'extension',
        kind: 'user_message',
        messageId,
        message
      });
      const corrected = await upsertMessageEvent(
        summary.id,
        {
          time: 10_000,
          source: 'extension',
          kind: 'user_message',
          messageId,
          message
        },
        { preferTime: true }
      );

      expect(corrected.changed).toBe(true);
      expect(corrected.event.time).toBe(10_000);
      expect(corrected.event.kind === 'user_message' && corrected.event.origin).toBe(first.event.seq);
      const [stored] = await readEvents(summary.id, { kinds: ['user_message'] });
      expect(stored?.time).toBe(10_000);
      expect(stored?.kind === 'user_message' && stored.origin).toBe(first.event.seq);
    });

  it('revises one canonical row only when the website logical identity is the same', async () => {
      const summary = await createSession({ title: 'stable website identity' });
      const turnId = 'g-stream-growth';
      const logicalId = 'thought-website-parent';
      const snapshots = [
        'Eight calls in, still zero writes.',
        'Eight calls in, still zero writes. The repo was already very',
        'Eight calls in, still zero writes. The repo was already very dirty before this check.'
      ];

      for (let index = 0; index < snapshots.length; index++) {
        const text = snapshots[index]!;
        await upsertMessageEvent(summary.id, {
          time: 100 + index,
          source: 'extension',
          kind: 'assistant_message',
          turnId,
          messageId: logicalId,
          message: { text, truncated: false, chars: text.length },
          state: index === snapshots.length - 1 ? 'final' : 'streaming',
          final: index === snapshots.length - 1
        });
      }

      const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.kind === 'assistant_message' && messages[0].messageId).toBe(logicalId);
      expect(messages[0]?.kind === 'assistant_message' && messages[0].message.text).toBe(snapshots.at(-1));
      expect(messages[0]?.kind === 'assistant_message' && messages[0].state).toBe('final');
    });

  it('keeps the first sequence as the origin of a revised stable user message', async () => {
      const summary = await createSession({ title: 'stable user boundary' });
      const message = { text: 'the user turn boundary', truncated: false, chars: 22 };
      const first = await upsertMessageEvent(summary.id, {
        time: 100,
        source: 'extension',
        kind: 'user_message',
        turnId: 'page-user-before',
        messageId: 'user-stable-boundary',
        message
      });
      const revised = await upsertMessageEvent(summary.id, {
        time: 200,
        source: 'extension',
        kind: 'user_message',
        turnId: 'page-user-after',
        messageId: 'user-stable-boundary',
        message
      });

      expect(revised.changed).toBe(true);
      expect(first.event.kind === 'user_message' && first.event.origin).toBe(first.event.seq);
      expect(revised.event.kind === 'user_message' && revised.event.origin).toBe(first.event.seq);
      expect(revised.event.seq).toBeGreaterThan(first.event.seq);
      const stored = await readEvents(summary.id, { kinds: ['user_message'] });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.kind === 'user_message' && stored[0].origin).toBe(first.event.seq);
    });

  it('never merges distinct website identities merely because their prose is a prefix continuation', async () => {
      const summary = await createSession({ title: 'distinct website identities' });
      const turnId = 'g-distinct-prefix';
      const first = 'First checkpoint.';
      const second = 'First checkpoint. Second checkpoint.';

      for (const [messageId, text] of [
        ['thought-parent-a', first],
        ['thought-parent-b', second]
      ] as const) {
        await upsertMessageEvent(summary.id, {
          time: Date.now(),
          source: 'extension',
          kind: 'assistant_message',
          turnId,
          messageId,
          message: { text, truncated: false, chars: text.length },
          state: 'streaming',
          final: false
        });
      }

      const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
      expect(messages).toHaveLength(2);
      expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
        'thought-parent-a',
        'thought-parent-b'
      ]);
    });

  it('does not merge separate streaming commentary that merely shares a turn', async () => {
      const summary = await createSession({ title: 'separate streaming commentary' });
      const turnId = 'g-separate-commentary';
      for (const [messageId, text] of [
        ['comment-a', 'First three are clean; continuing the checks.'],
        ['comment-b', 'Eight calls in; still zero writes.']
      ] as const) {
        await upsertMessageEvent(summary.id, {
          time: Date.now(),
          source: 'extension',
          kind: 'assistant_message',
          turnId,
          messageId,
          message: { text, truncated: false, chars: text.length },
          state: 'streaming',
          final: false
        });
      }

      const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
      expect(messages).toHaveLength(2);
      expect(messages.map((event) => event.kind === 'assistant_message' && event.message.text)).toEqual([
        'First three are clean; continuing the checks.',
        'Eight calls in; still zero writes.'
      ]);
    });

  it('keeps a settled raw website id distinct from a different provisional id', async () => {
      const summary = await createSession({ title: 'different id at final' });
      const turnId = 'g-stream-final-remount';
      const text = 'The completed answer is already fully visible.';
      await upsertMessageEvent(summary.id, {
        time: 100,
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId: 'raw-streaming',
        message: { text, truncated: false, chars: text.length },
        state: 'streaming',
        final: false
      });
      await upsertMessageEvent(summary.id, {
        time: 110,
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId: 'raw-final-remount',
        message: { text, truncated: false, chars: text.length },
        state: 'final',
        final: true
      });

      const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
      expect(messages).toHaveLength(2);
      expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
        'raw-streaming',
        'raw-final-remount'
      ]);
      expect(messages[1]?.kind === 'assistant_message' && messages[1].state).toBe('final');
    });
});
