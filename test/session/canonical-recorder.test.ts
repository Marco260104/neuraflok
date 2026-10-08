import {
  MAX_ASSET_BYTES,
  autoCompactionReady,
  createSession,
  defaultConfig,
  enableRecording,
  estimateTokens,
  flushSessions,
  fs,
  getLog,
  getSession,
  listSessions,
  liveConversations,
  path,
  readAsset,
  readEvents,
  readLatestUserMessage,
  rebindConversation,
  rebindSession,
  recordChatObservations,
  recordToolCall,
  resetRecorderForTests,
  resetSessionStoreForTests,
  saveConfig,
  sessionForConversation,
  sessionsRoot,
  sharp,
  upsertMessageEvent,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------- recorder

describe('canonical recorder 1.8', () => {
  it('caps the estimated tool return after rebind while retaining its full recorded result', async () => {
    const config = defaultConfig();
    await saveConfig({ ...config, compaction: { ...config.compaction, auto: true, autoTokens: 10000 } });
    try {
      const source = 'conv-fulltext-source';
      const destination = 'conv-fulltext-destination';
      const opened = await recordChatObservations(source, [{ kind: 'user_message', time: Date.now(),
        messageId: 'old-large-context', text: 'x'.repeat(50000) }]);
      const sessionId = opened.sessionId!;
      expect(await rebindSession(sessionId, source, destination)).toBe(true);
      rebindConversation(sessionId, source, destination);
      const requestId = 'wfr-fulltext-result';
      await recordChatObservations(destination, [
        { kind: 'user_message', time: Date.now(), messageId: 'new-handoff', text: 'h'.repeat(13237) },
        { kind: 'tool_evidence', time: Date.now(), calls: [{ messageId: 'fulltext-call', requestId,
          tool: 'read', order: 0, answered: false }] }
      ]);
      const before = (await getSession(sessionId))!;
      const args = { paths: ['a.ts', 'b.ts', 'c.ts'] };
      const result = 'r'.repeat(60306);
      const call = await recordToolCall({ tool: 'read', args, content: [{ type: 'text', text: result }],
        outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
      expect(call?.result).toMatchObject({ truncated: true, chars: result.length });
      expect(call!.result.text.length).toBeLessThan(8200);
      expect((await readAsset(sessionId, call!.result.assetId!))?.toString('utf8')).toBe(result);
      const expected = estimateTokens(JSON.stringify(args)) + 10000 + estimateTokens(call!.summary.title);
      const after = (await getSession(sessionId))!;
      expect(after.estimatedTokens - before.estimatedTokens).toBe(expected);
      expect(after.contextTokens).toBe(estimateTokens('h'.repeat(13237)) + expected);
      expect(autoCompactionReady(after)).toBe(true);
    } finally { await enableRecording(); }
  });

  it('replaces a canonical truncated message contribution with its new full length once', async () => {
    const opened = await createSession({ title: 'full message revisions' });
    const revision = (chars: number) => ({ time: Date.now(), source: 'extension' as const, kind: 'assistant_message' as const,
      messageId: 'full-answer', state: 'streaming' as const, final: false,
      message: { text: 'same bounded head', truncated: true, chars, digest: String(chars) } });
    await upsertMessageEvent(opened.id, revision(20000));
    await upsertMessageEvent(opened.id, revision(60000));
    await upsertMessageEvent(opened.id, revision(60000));
    expect(await getSession(opened.id)).toMatchObject({ estimatedTokens: 15000, contextTokens: 15000 });
  });

  it('refuses rejected native-image owners before writing preview assets', async () => {
    const conversationId = `conv-native-image-owner-${Date.now()}`;
    const messageId = '5150f756-bf2d-45fa-ac0f-45010b2239fb';
    const providerAssetId = 'file_00000000000000000000000000000071';
    const preview = async (color: string) => {
      const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: color } }).webp().toBuffer();
      return `data:image/webp;base64,${bytes.toString('base64')}`;
    };
    const first = await recordChatObservations(conversationId, [{
      kind: 'native_image', time: 100, messageId, providerAssetId, providerRole: 'tool',
      providerChannel: 'final', providerStatus: 'in_progress', width: 1254, height: 1254,
      previewStatus: 'pending'
    }], 'worker-a');
    const sessionId = first.sessionId!;

    const roleConflict = await recordChatObservations(conversationId, [{
      kind: 'native_image', time: 200, messageId, providerAssetId, providerRole: 'assistant',
      providerChannel: 'final', providerStatus: 'finished_successfully', width: 1254, height: 1254,
      previewStatus: 'available', previewWidth: 12, previewHeight: 8, previewDataUrl: await preview('#0044ff')
    }], 'worker-a');
    const agentConflict = await recordChatObservations(conversationId, [{
      kind: 'native_image', time: 300, messageId, providerAssetId, providerRole: 'tool',
      providerChannel: 'final', providerStatus: 'finished_successfully', width: 1254, height: 1254,
      previewStatus: 'available', previewWidth: 12, previewHeight: 8, previewDataUrl: await preview('#ff6600')
    }], 'worker-b');

    expect(roleConflict.stored).toBe(0);
    expect(agentConflict.stored).toBe(0);
    const rows = await readEvents(sessionId, { kinds: ['native_image'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerRole: 'tool', agent: 'worker-a', providerStatus: 'in_progress', previewStatus: 'pending' });
    const assets = await fs.readdir(path.join(sessionsRoot(), sessionId, 'assets')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    expect(assets).toEqual([]);
  });

  it('lets the store deduplicate repeated recorder assets instead of shadow-counting the same bytes toward quota', async () => {
    const conversationId = `conv-dedup-shot-${Date.now()}`;
    const sessionId = await sessionForConversation(conversationId);
    const requestIds = Array.from({ length: 25 }, (_, index) => `wfr_dedup_asset_${index}`);
    const now = Date.now();
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: now, turnId: 'dedup-asset-turn' },
      {
        kind: 'tool_evidence',
        time: now + 1,
        turnId: 'dedup-asset-turn',
        calls: requestIds.map((requestId, index) => ({
          messageId: `dedup-asset-${index}`,
          tool: 'screenshot',
          order: index,
          answered: false,
          requestId
        }))
      }
    ]);

    // Exactly one maximum-sized file exists on disk. Twenty-five references total 200 MiB logically, which used to trip recorder.ts's separate 192 MiB shadow counter even though the authoritative content-addressed store correctly charged only the first 8 MiB.
    const imageBase64 = Buffer.alloc(MAX_ASSET_BYTES, 0x5a).toString('base64');
    const assetIds: Array<string | undefined> = [];
    for (const [index, requestId] of requestIds.entries()) {
      const call = await recordToolCall({
        tool: 'screenshot',
        args: { index },
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
        outcome: 'ok',
        durationMs: 1,
        startedAt: now + 2 + index,
        requestId
      });
      assetIds.push(call?.assets?.[0]?.id);
    }

    expect(assetIds.every(Boolean)).toBe(true);
    expect(new Set(assetIds).size).toBe(1);
    expect((await readEvents(sessionId!, { kinds: ['tool_call'] }))).toHaveLength(25);
  });

  it('records one provider-limit notice for concurrent tab reports and journal replay after restart', async () => {
    const conversationId = 'conv-error-burst';
    const error = { kind: 'chat_error' as const, time: 100_000,
      text: 'Too many requests. Please wait a few minutes.', blocking: true, recoverable: false };
    const reports = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      recordChatObservations(conversationId, [{ ...error, time: error.time + index * 50, turnId: `tab-${index}` }])));
    expect(reports.reduce((count, report) => count + report.stored, 0)).toBe(1);
    expect(reports.slice(1).every(report => !report.activity.meaningful)).toBe(true);
    const sessionId = reports[0]!.sessionId!;
    await flushSessions();
    resetRecorderForTests();
    resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ ...error, time: error.time + 1_000 }]);
    expect(await readEvents(sessionId, { kinds: ['chat_error'] })).toEqual([
      expect.objectContaining({ blocking: true, recoverable: false })
    ]);

    await recordChatObservations(conversationId, [{ ...error, time: error.time + 30_001 }]);
    expect(await readEvents(sessionId, { kinds: ['chat_error'] })).toHaveLength(2);
    const other = await recordChatObservations('conv-error-burst-other', [error]);
    expect(other.stored).toBe(1);
  });

  it('coalesces same-turn error bursts but preserves different errors and genuine turn failures', async () => {
    const error = { kind: 'chat_error' as const, time: 100_000, text: 'Message delivery timed out.', turnId: 'first' };
    const first = await recordChatObservations('conv-error-turns', [error,
      { ...error, time: 100_100, text: 'Message  delivery\n timed out.' },
      { ...error, time: 100_200, text: 'Something went wrong.' },
      { ...error, time: 100_300, turnId: 'second' }]);
    const errors = await readEvents(first.sessionId!, { kinds: ['chat_error'] });
    expect(errors).toHaveLength(3);
    expect(errors.map(event => event.turnId)).toEqual(['first', 'first', 'second']);
  });

  it('owns reload errors by the canonical question across missing and reminted document turns', async () => {
    const conversationId = 'conv-reload-error-owner';
    const error = { kind: 'chat_error' as const, time: 100_000, text: 'Connection interrupted', recoverable: true, turnId: 'original' };
    const first = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 90_000, messageId: 'question-one', text: 'Build it', authoredNow: true }, error]);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    for (const [turnId, time] of [[undefined, 110_000], ['replacement', 121_000], ['replacement-again', 200_000]] as const) {
      const replay = await recordChatObservations(conversationId, [{ ...error, turnId, time }]);
      expect(replay.activity.meaningful).not.toBe(true);
    }
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(1);
    await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 210_000, messageId: 'question-two', text: 'Build it', authoredNow: true },
      { kind: 'user_message', time: 90_000, messageId: 'question-one', text: 'Build it with corrected rendering' },
      { ...error, time: 211_000 }]);
    expect((await readLatestUserMessage(first.sessionId!))?.messageId).toBe('question-two');
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(2);
  });

  it('keeps a failed error append eligible for retry', async () => {
    const conversationId = 'conv-error-append-retry';
    await sessionForConversation(conversationId);
    const error = { kind: 'chat_error' as const, time: 100, text: 'Something went wrong.' };
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(recordChatObservations(conversationId, [error])).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }
    const retry = await recordChatObservations(conversationId, [error]);
    expect(retry.stored).toBe(1);
    expect(await readEvents(retry.sessionId!, { kinds: ['chat_error'] })).toHaveLength(1);
  });

  it('coalesces the same transport notice with Retry button text across document turns', async () => {
    const conversationId = 'conv-error-retry-label';
    const error = { kind: 'chat_error' as const, time: 100_000,
      text: 'Message delivery timed out. Please try again.', recoverable: true, turnId: 'original' };
    const first = await recordChatObservations(conversationId, [
      { kind: 'user_message', messageId: 'question', text: 'Build', time: 90_000, authoredNow: true },
      { ...error, text: `${error.text} Retry` }, { ...error, time: 100_100, turnId: undefined }
    ]);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ ...error, time: 200_000, turnId: 'replacement' }]);
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(1);
    await recordChatObservations(conversationId, [{ ...error, time: 201_000, text: 'Connection interrupted' }]);
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(2);
  });

  it('keeps one exact Thinking failed notice across reload/restart beyond the burst window', async () => {
    const conversationId = 'conv-failed-header-reload';
    const error = { kind: 'chat_error' as const, time: 100_000, text: 'Thinking failed',
      reason: 'thinking_failed' as const, turnId: 'failed-turn', recoverable: false };
    const first = await recordChatObservations(conversationId, [error]);
    await flushSessions(); resetRecorderForTests(); resetSessionStoreForTests();
    await recordChatObservations(conversationId, [{ ...error, time: 500_000 }]);
    await recordChatObservations(conversationId, [{ ...error, time: 600_000, turnId: undefined }]);
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toEqual([
      expect.objectContaining({ reason: 'thinking_failed', turnId: 'failed-turn' })
    ]);
    await recordChatObservations(conversationId, [{ ...error, time: 700_000, turnId: 'another-turn' }]);
    expect(await readEvents(first.sessionId!, { kinds: ['chat_error'] })).toHaveLength(2);
  });

  it('deduplicates replayed turn lifecycle boundaries from the at-least-once browser journal', async () => {
    const conversationId = 'conv-lifecycle-replay';
    const batch = [
      { kind: 'turn_start' as const, time: 100, turnId: 'g-replayed-lifecycle' },
      { kind: 'turn_end' as const, time: 200, turnId: 'g-replayed-lifecycle', outcome: 'completed' as const }
    ];
    const first = await recordChatObservations(conversationId, batch);
    await recordChatObservations(conversationId, batch);

    const lifecycle = await readEvents(first.sessionId!, { kinds: ['turn_start', 'turn_end'] });
    expect(lifecycle.map((event) => event.kind)).toEqual(['turn_start', 'turn_end']);
    expect(lifecycle.map((event) => event.turnId)).toEqual(['g-replayed-lifecycle', 'g-replayed-lifecycle']);
  });

  it('serializes concurrent replays before lifecycle dedupe is decided', async () => {
    const conversationId = 'conv-lifecycle-concurrent-replay';
    const batch = [
      { kind: 'turn_start' as const, time: 100, turnId: 'g-concurrent-lifecycle' },
      { kind: 'turn_end' as const, time: 200, turnId: 'g-concurrent-lifecycle', outcome: 'completed' as const }
    ];
    const [first] = await Promise.all([
      recordChatObservations(conversationId, batch),
      recordChatObservations(conversationId, batch)
    ]);

    const lifecycle = await readEvents(first.sessionId!, { kinds: ['turn_start', 'turn_end'] });
    expect(lifecycle.map((event) => event.kind)).toEqual(['turn_start', 'turn_end']);
  });

  it('does not mark a lifecycle retry duplicate before its durable append commits', async () => {
    const conversationId = 'conv-lifecycle-commit-failure';
    const sessionId = await sessionForConversation(conversationId);
    const start = { kind: 'turn_start' as const, time: 100, turnId: 'g-retry-after-disk-failure' };
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(recordChatObservations(conversationId, [start])).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }

    await recordChatObservations(conversationId, [start]);
    const lifecycle = await readEvents(sessionId!, { kinds: ['turn_start'] });
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]?.turnId).toBe(start.turnId);
  });

  const tool = (requestId: string, startedAt = Date.now()) =>
    recordToolCall({
      tool: 'read',
      args: { paths: ['/project/a.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok' as const,
      durationMs: 1,
      startedAt,
      requestId
    });

  it('creates exactly one session when the same conversation is first observed concurrently', async () => {
    const conversationId = 'conv-concurrent-first-sight';
    const [first, second] = await Promise.all([
      sessionForConversation(conversationId),
      sessionForConversation(conversationId)
    ]);
    expect(second).toBe(first);
    expect((await listSessions()).filter((entry) => entry.conversationId === conversationId)).toHaveLength(1);
    expect(await readEvents(first!, { kinds: ['session_start'] })).toHaveLength(1);
  });

  it('many streaming updates become exactly one final canonical message', async () => {
    const conversationId = 'conv-canonical-stream';
    const messageId = 'msg-stream-123';
    const result = await recordChatObservations(conversationId, [
      { kind: 'assistant_message', time: 100, messageId, text: 'I inspected', state: 'streaming' },
      { kind: 'assistant_message', time: 110, messageId, text: 'I inspected the current tree', state: 'streaming' },
      { kind: 'assistant_message', time: 120, messageId, text: 'I inspected the current tree.', state: 'final', final: true }
    ]);

    const messages = await readEvents(result.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.kind).toBe('assistant_message');
    if (message.kind !== 'assistant_message') throw new Error('wrong event');
    expect(message.messageId).toBe(messageId);
    expect(message.state).toBe('final');
    expect(message.final).toBe(true);
    expect(message.message.text).toBe('I inspected the current tree.');
  });

  it('repeating the same final snapshot never creates another logical message', async () => {
    const conversationId = 'conv-repeat-final';
    const snapshot = {
      kind: 'assistant_message' as const,
      time: 200,
      messageId: 'msg-repeat-final',
      text: 'Done.',
      state: 'final' as const,
      final: true
    };
    const first = await recordChatObservations(conversationId, [snapshot]);
    await recordChatObservations(conversationId, [{ ...snapshot, time: 210 }, { ...snapshot, time: 220 }]);
    const messages = await readEvents(first.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
  });

  it('correlates every hidden or rowless MCP request independently by request id', async () => {
    const conversationId = 'conv-rowless-modern';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [
      {
        kind: 'tool_evidence',
        time: now,
        fiberConversationId: conversationId,
        calls: Array.from({ length: 5 }, (_unused, index) => ({
          messageId: `hidden-${index}`,
          tool: 'read',
          order: index,
          answered: false,
          requestId: `wfr_hidden_${index}`
        }))
      }
    ]);
    for (let index = 0; index < 5; index++) await tool(`wfr_hidden_${index}`, now + index);
    const calls = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(5);
    for (const event of calls) {
      if (event.kind !== 'tool_call') throw new Error('wrong event');
      expect(event.call.attributionMethod).toBe('request_id');
      expect(event.call.conversationId).toBe(conversationId);
      expect(event.call.requestId).toMatch(/^wfr_hidden_/);
    }
  });

  /** Live 2026-09-02: the page reloaded mid-turn, adopted the open turn and reported it completed four seconds later; the same ChatGPT request id then called tools for another twenty-four minutes. The request id is per server turn, so a call under the ended turn's request id that starts after the reported end is proof the end was the page's, not ChatGPT's. The recorder reopens the turn durably and lets the real end close it later. */
  it.each(['completed', 'stopped', 'interrupted'] as const)('reopens a turn the page marked %s while its server turn kept calling tools', async outcome => {
    const conversationId = `conv-false-turn-end-${outcome}`;
    const sameRequest = `wfr_same_turn_${outcome}`, nextRequest = `wfr_next_turn_${outcome}`;
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    const active = () => liveConversations().find((entry) => entry.conversationId === conversationId)?.activeTurnId ?? null;
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: now, turnId: 'g-false-end' },
      {
        kind: 'tool_evidence', time: now, fiberConversationId: conversationId,
        calls: [
          { messageId: 'same-0', tool: 'read', order: 0, answered: false, requestId: sameRequest },
          { messageId: 'next-0', tool: 'read', order: 1, answered: false, requestId: nextRequest }
        ]
      }
    ]);
    await tool(sameRequest, now + 10);
    expect(active()).toBe('g-false-end');

    await recordChatObservations(conversationId, [
      { kind: 'turn_end', time: now + 20, turnId: 'g-false-end', outcome }
    ]);
    expect(active()).toBeNull();

    // An in-flight call that merely finished late proves nothing about the end.
    await tool(sameRequest, now + 15);
    expect(active()).toBeNull();
    // Nor does a different server turn: that is a different turn.
    await tool(nextRequest, now + 30);
    expect(active()).toBeNull();

    // The same server turn calling on after the end is the turn not having ended.
    await tool(sameRequest, now + 40);
    expect(active()).toBe('g-false-end');
    const starts = await readEvents(sessionId!, { kinds: ['turn_start'] });
    expect(starts.map((event) => [event.turnId, event.source])).toEqual([
      ['g-false-end', 'extension'],
      ['g-false-end', 'app']
    ]);
    expect(starts[1]?.kind === 'turn_start' && starts[1].detail).toMatch(/kept calling tools/);

    // Reopened once; the same turn going on is not news, and the real end is accepted.
    await tool(sameRequest, now + 50);
    expect(await readEvents(sessionId!, { kinds: ['turn_start'] })).toHaveLength(2);
    await recordChatObservations(conversationId, [
      { kind: 'turn_end', time: now + 60, turnId: 'g-false-end', outcome: 'completed' }
    ]);
    expect(active()).toBeNull();
    const ends = await readEvents(sessionId!, { kinds: ['turn_end'] });
    expect(ends.map((event) => event.time)).toEqual([now + 20, now + 60]);
  });

  it.each(['continued-work', 'native-final'] as const)(
    'reconciles a stopped response after recorder restart from %s', async evidenceKind => {
    const conversationId = `conv-stop-restart-${evidenceKind}`;
    const requestId = `wfr_stop_restart_${evidenceKind}`, turnId = 'stopped-before-restart';
    const now = Date.now();
    const { sessionId } = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: now, messageId: 'restart-question', text: 'Complete the task.' },
      { kind: 'turn_start', time: now + 1, turnId },
      { kind: 'tool_evidence', time: now + 2, turnId, fiberConversationId: conversationId,
        calls: [{ messageId: 'restart-call', tool: 'read', order: 0, answered: false, requestId }] }
    ]);
    await tool(requestId, now + 3);
    await recordChatObservations(conversationId, [{ kind: 'turn_end', time: now + 10, turnId, outcome: 'stopped' }]);
    await flushSessions();
    resetRecorderForTests();
    resetSessionStoreForTests();
    await sessionForConversation(conversationId);
    // Restored exact request proof is supplied by a re-observed native call.
    await recordChatObservations(conversationId, [{ kind: 'tool_evidence', time: now + 20, turnId,
      fiberConversationId: conversationId,
      calls: [{ messageId: 'restart-call', tool: 'read', order: 0, answered: true, requestId }] }]);
    if (evidenceKind === 'continued-work') {
      await tool(requestId, now + 21);
      expect((await getSession(sessionId!))?.activeTurnId).toBe(turnId);
    }
    await recordChatObservations(conversationId, [{ kind: 'assistant_message', time: now + 30,
      turnId, messageId: 'native-final-after-reload', providerMessageId: '11111111-2222-4333-8444-555555555555',
      text: 'The full answer is available after reload.', state: 'final', final: true, activeNow: false }]);
    const { readCompletedFinal } = await import('../../backend/domains/sessions/history/store.js');
    expect(await readCompletedFinal(sessionId!, conversationId, turnId))
      .toMatchObject({ messageId: 'native-final-after-reload', turnId });
    await tool(requestId, now + 31);
    expect((await getSession(sessionId!))?.activeTurnId).toBeNull();
    expect(await readCompletedFinal(sessionId!, conversationId, turnId)).not.toBeNull();
  });

  it('never cross-attributes concurrent same-tool calls from two chats', async () => {
    const now = Date.now();
    const firstId = 'conv-concurrent-a';
    const secondId = 'conv-concurrent-b';
    const first = await sessionForConversation(firstId);
    const second = await sessionForConversation(secondId);
    await recordChatObservations(firstId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: firstId,
      calls: [{ messageId: 'call-a', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_a' }]
    }]);
    await recordChatObservations(secondId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: secondId,
      calls: [{ messageId: 'call-b', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_b' }]
    }]);

    await Promise.all([tool('wfr_concurrent_b', now), tool('wfr_concurrent_a', now)]);
    const firstCalls = await readEvents(first!, { kinds: ['tool_call'] });
    const secondCalls = await readEvents(second!, { kinds: ['tool_call'] });
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(1);
    expect(firstCalls[0]!.kind === 'tool_call' && firstCalls[0]!.call.requestId).toBe('wfr_concurrent_a');
    expect(secondCalls[0]!.kind === 'tool_call' && secondCalls[0]!.call.requestId).toBe('wfr_concurrent_b');
  });

  it('keeps an unmatched modern request unattributed and never borrows another chat', async () => {
    vi.useFakeTimers();
    try {
      const other = await sessionForConversation('conv-other-evidence');
      await recordChatObservations('conv-other-evidence', [{
        kind: 'tool_evidence', time: Date.now(), fiberConversationId: 'conv-other-evidence',
        calls: [{ messageId: 'other-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_other' }]
      }]);
      const pending = tool('wfr_missing', Date.now());
      await vi.advanceTimersByTimeAsync(15_100);
      const call = await pending;
      expect(call?.attributionMethod).toBe('unattributed');
      expect(call?.conversationId).toBeNull();
      expect(await readEvents(other!, { kinds: ['tool_call'] })).toHaveLength(0);
      const unattributed = (await listSessions()).find((entry) => entry.title === 'Unattributed activity');
      expect(unattributed?.toolCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects URL/Fiber conversation conflicts instead of choosing either identity', async () => {
    const now = Date.now();
    await sessionForConversation('conv-url-identity');
    await sessionForConversation('conv-fiber-identity');
    await recordChatObservations('conv-url-identity', [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: 'conv-fiber-identity',
      calls: [{ messageId: 'conflict-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_identity_conflict' }]
    }]);
    const call = await tool('wfr_identity_conflict', now);
    expect(call?.attributionMethod).toBe('unattributed');
    expect(call?.conversationId).toBeNull();
  });

  /** One line, and not a problem line. A refused claim means the registry did its job: the id keeps the chat that proved it and every call under it keeps arriving there. Reporting that as a fault put a run that was working perfectly into the problem count, and reporting it once per call put it there thirty-five times over. */
  it('reports a refused claim once per batch, and as a note rather than a problem', async () => {
    const firstConversation = 'conv-conflict-log-first';
    const secondConversation = 'conv-conflict-log-second';
    const requestId = `wfr_conflict_log_${Date.now()}`;
    const now = Date.now();
    await sessionForConversation(firstConversation);
    await sessionForConversation(secondConversation);
    await recordChatObservations(firstConversation, [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: firstConversation,
      calls: [{ messageId: 'first-proof', tool: 'read', order: 0, answered: true, requestId }]
    }]);

    const lines = (level: 'warn' | 'info'): number => getLog().filter(
      (entry) => entry.level === level && entry.message.includes(`${requestId} stays with conversation`)
    ).length;
    const conflictingCalls = Array.from({ length: 35 }, (_, index) => ({
      messageId: `conflicting-call-${index}`,
      tool: index % 2 === 0 ? 'read' : 'exec_command',
      order: index,
      answered: true,
      requestId
    }));
    await recordChatObservations(secondConversation, [{
      kind: 'tool_evidence',
      time: now + 1,
      fiberConversationId: secondConversation,
      calls: conflictingCalls
    }]);
    expect(lines('info')).toBe(1);
    expect(lines('warn')).toBe(0);

    // And the id still belongs to the chat that proved it, which is the whole point of having refused: a call arriving under it now is filed there, not left unattributed.
    const call = await tool(requestId, now + 2);
    expect(call?.attributionMethod).toBe('request_id');
    expect(call?.conversationId).toBe(firstConversation);
  });

  /** A disagreement is a bad moment, not a bad request id. The page can be mid-navigation, still holding the previous chat's model, or showing a conversation whose client-side thread id is not yet the server's. All of those make the URL and the React tree disagree for a tick. Marking the request ids in that batch contradictory — which is what this used to do — is permanent: nothing republishes a conflicted id, and the deterministic repair pass skips it. Whole turns of provable tool calls stayed in Unattributed activity for good because of one transient tick. */
  it('lets agreeing evidence prove a call whose first sighting disagreed with the URL', async () => {
    const conversationId = 'conv-late-agreement';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();

    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: 'conv-still-the-old-one',
      calls: [{ messageId: 'late-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_late_agreement' }]
    }]);

    // The same sighting a tick later, from a page that now agrees with its own URL.
    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence',
      time: now + 5,
      fiberConversationId: conversationId,
      calls: [{ messageId: 'late-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_late_agreement' }]
    }]);

    const call = await tool('wfr_late_agreement', now + 10);
    expect(call?.attributionMethod).toBe('request_id');
    expect(call?.conversationId).toBe(conversationId);
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  it('keeps one message anchored before tool calls while streaming revisions update it', async () => {
    const conversationId = 'conv-interleaved';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now, messageId: 'msg-interleaved', text: 'Working', state: 'streaming'
    }]);
    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence', time: now + 10, fiberConversationId: conversationId,
      calls: [{ messageId: 'tool-interleaved', tool: 'read', order: 0, answered: false, requestId: 'wfr_interleaved' }]
    }]);
    await tool('wfr_interleaved', now + 20);
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now + 30, messageId: 'msg-interleaved', text: 'Working — done', state: 'final', final: true
    }]);
    const timeline = (await readEvents(sessionId!)).filter((event) => event.kind === 'assistant_message' || event.kind === 'tool_call');
    expect(timeline.map((event) => event.kind)).toEqual(['assistant_message', 'tool_call']);
    expect(timeline.filter((event) => event.kind === 'assistant_message')).toHaveLength(1);
  });
});
