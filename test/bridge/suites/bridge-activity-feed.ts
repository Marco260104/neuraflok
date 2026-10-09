import { randomUUID } from "node:crypto";
import {
  completeProcessCall,
  createSession,
  defaultConfig,
  describe,
  expect,
  findSessionByConversation,
  flushDurable,
  getConfig,
  getSession,
  GOAL_SWITCHES_STATE,
  it,
  liveConversations,
  noteChatOrigin,
  pair,
  PRIME_CHAT,
  readEvents,
  recordProcessCall,
  recordToolCall,
  request,
  requestCorrelation,
  resetCorrelationRegistryForTests,
  resetRecorderForTests,
  restoreRequestCorrelations,
  saveConfig,
  spawn,
  vi,
  writeDurableNow
} from '../test-context.js';

describe('activity feed', () => {
  it('reopens a durable still-open chat after recorder memory is lost', async () => {
    await pair();
    const conversationId = '98989898-7777-6666-5555-444444444444';
    const opened = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'turn_start', time: Date.now(), turnId: 'before-restart' }]
      }
    });
    const sessionId = opened.body.sessionId as string;
    expect(sessionId).toBeTruthy();

    resetRecorderForTests();
    expect(liveConversations()).toHaveLength(0);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/after-restart.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId: 'wfr_activity_restart',
      conversationId
    });
    // Exact request ownership can append durably without recreating the page-liveness map.
    expect(liveConversations()).toHaveLength(0);

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.status).toBe(200);
    expect(reply.body.sessionId).toBe(sessionId);
    expect(reply.body.entries).toHaveLength(1);
    expect(reply.body.entries[0]).toMatchObject({ tool: 'read', requestId: 'wfr_activity_restart' });
    expect(reply.body.pendingTools).toBe(0);
    expect(reply.body.settlingTools).toBe(0);
    expect(liveConversations().some((entry) => entry.conversationId === conversationId)).toBe(true);
  });

  it('atomically registers and verifies a live request id against its chat before the MCP call is filed', async () => {
    await pair();
    const conversationId = '13131313-3535-5757-7979-919191919191';
    const requestId = 'f0f00009-1111-4111-8111-111111111111';
    const mapped = await request('POST', '/correlations', {
      body: {
        conversationId,
        calls: [
          {
            messageId: 'page-request-live-handshake',
            tool: 'exec_command',
            order: 0,
            answered: false,
            requestId,
            createTime: Date.now() / 1000
          }
        ]
      }
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toMatchObject({
      ok: true,
      conversationId,
      requestIds: [requestId],
      confirmed: [requestId],
      complete: true
    });
    expect(mapped.body.sessionId).toBeTruthy();

    await recordToolCall({
      tool: 'exec_command',
      args: { command: 'echo exact' },
      content: [{ type: 'text', text: 'exact' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId,
      evidence: {
        changes: [],
        reviews: [],
        assets: [],
        count: null,
        detail: null,
        exitCode: 0,
        timedOut: false,
        durationMs: null,
        running: null,
        processSessionId: null
      }
    });

    const calls = await readEvents(mapped.body.sessionId, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind === 'tool_call' && calls[0].call).toMatchObject({
      requestId,
      conversationId,
      attribution: 'request_id',
      attributionMethod: 'request_id'
    });
  });
  it('hands a new chat to one browser only while that browser keeps polling', async () => {
    // Live 2026-09-29: with the extension in two browsers, one opened the elected tab and left it blank while an idle tab in the other browser typed and sent the same opening message.
    await pair();
    const input = await import("../../../backend/domains/sessions/input/input.js");
    input.resetInputForTests();
    await writeDurableNow('session-input', []);
    const first = 'a'.repeat(32), second = 'b'.repeat(32);
    const id = randomUUID();
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await input.enqueueInput({ id, sessionId: null, text: 'Open one chat', mode: 'auto', dueAt: now, model: null, reasoningEffort: null });
      const offered = async (browser?: string) => ((await request('POST', '/status', { body: { openConversations: [] }, browser })).body.inputs as Array<{ id: string }>)
        .some(row => row.id === id);
      expect(await offered(first)).toBe(true);
      expect(await offered(second)).toBe(false);
      expect((await request('POST', '/input/claim', { body: { id, owner: '9:other-browser:0', conversationId: null }, browser: second })).body.input).toBeNull();
      expect(await offered(first)).toBe(true);
      // An older extension without an id is not told apart, as before.
      expect(await offered()).toBe(true);
      // The first browser went away: the other one may take the opening over.
      now += 61_000;
      expect(await offered(second)).toBe(true);
      now += 1_000;
      expect(await offered(first)).toBe(false);
      expect((await request('POST', '/input/claim', { body: { id, owner: '9:other-browser:0', conversationId: null }, browser: second })).body.input)
        .toMatchObject({ id });
    } finally {
      clock.mockRestore();
      input.resetInputForTests();
      await writeDurableNow('session-input', []);
    }
  });

  it('keeps bind, first correlation and ACK on the reserved opening session', async () => {
    await pair();
    const input = await import("../../../backend/domains/sessions/input/input.js");
    input.resetInputForTests();
    await writeDurableNow('session-input', []);
    const id = randomUUID();
    const owner = '31:fresh-opening-document:0';
    const conversationId = '24242424-4646-4848-8a8a-626262626262';
    const requestId = 'wfr_reserved_opening_first_call';
    try {
      const row = await input.enqueueInput({ id, sessionId: null, text: 'Open the exact reserved task', mode: 'auto',
        dueAt: Date.now(), model: null, reasoningEffort: null });
      expect(row).toMatchObject({ id, sessionId: id, opening: true, conversationId: null });
      expect((await request('POST', '/input/claim', { body: {
        id, owner, conversationId: null, requiresAuthorization: true
      } })).body.input).toMatchObject({ id, owner, opening: true });
      expect((await request('POST', '/input/claim', { body: {
        id, owner, conversationId: null, authorize: true
      } })).body).toEqual({ ok: true });

      expect((await request('POST', '/input/bind', { body: { id, owner, conversationId } })).body).toEqual({ ok: true });
      const mapped = await request('POST', '/correlations', { body: { conversationId, calls: [{
        messageId: 'reserved-opening-call', tool: 'read', order: 0, answered: false,
        requestId, createTime: Date.now() / 1000
      }] } });
      expect(mapped.body).toMatchObject({ ok: true, sessionId: id, confirmed: [requestId], complete: true });
      expect((await request('POST', '/input/ack', { body: {
        id, owner, conversationId, messageId: 'reserved-opening-user'
      } })).body).toEqual({ ok: true });

      expect(await findSessionByConversation(conversationId, { requireUnique: true })).toMatchObject({
        id, conversationId, title: 'Open the exact reserved task'
      });
      expect(await getSession(id)).toMatchObject({ conversationId, chatIds: [conversationId] });
      expect((await input.listInputs()).find(entry => entry.id === id)).toMatchObject({
        state: 'sent', deliveredSessionId: id, conversationId, messageId: 'reserved-opening-user'
      });
    } finally {
      await writeDurableNow('session-input', []);
      input.resetInputForTests();
    }
  });
  it('registers a request id the page could not yet name a tool for', async () => {
    await pair();
    const conversationId = '16161616-3838-6060-8282-949494949494';
    const requestId = 'wfr-safety-check-held';
    // ChatGPT stamps `metadata.request_id` on the plain public message the moment a turn issues a connector request, and materializes the `api_tool` message — the only one carrying a tool path — once its safety check clears, routinely well past this app's fifteen second evidence window. Requiring a tool name here meant that id was refused while the page could already prove who owned it, and the call was filed under Unattributed activity. The tool name takes no part in the join.
    const mapped = await request('POST', '/correlations', {
      body: {
        conversationId,
        calls: [{ messageId: 'page-message-before-tool-row', requestId, createTime: Date.now() / 1000 }]
      }
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toMatchObject({ ok: true, conversationId, confirmed: [requestId], complete: true });

    await recordToolCall({
      tool: 'agents',
      args: { action: 'launch' },
      content: [{ type: 'text', text: 'launched' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId
    });

    const calls = await readEvents(mapped.body.sessionId, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind === 'tool_call' && calls[0].call).toMatchObject({
      requestId,
      conversationId,
      attribution: 'request_id'
    });
  });

  /** A stream origin has no message to name, and that is not a defect in it. It is read off the `/f/conversation` SSE body before ChatGPT has mounted anything, so the page sends `messageId: null` by construction. This route reads only `requestId` — it never looks at the message — but the parser required one anyway, so every stream-derived id was dropped silently and the route answered `bad_request_evidence` with no log line. Measured on the live page and reported in #393: the origin was published up to eighteen seconds *before* the call arrived and still counted for nothing. The call waited out the full twenty-second identity window, was filed under Unattributed activity, and the bridge then reloaded the tab looking for the evidence it had already been given and thrown away. `identity_ms` 15001 -> 2 after the fix. */
  it('registers a stream origin the page cannot yet name a message for', async () => {
    await pair();
    const conversationId = '17171717-3939-6161-8383-959595959595';
    const requestId = '11111111-2222-4333-8444-555555555555';
    const mapped = await request('POST', '/correlations', {
      body: { conversationId, calls: [{ messageId: null, requestId, createTime: Date.now() / 1000 }] }
    });
    expect(mapped.status, 'the stream origin was refused').toBe(200);
    expect(mapped.body).toMatchObject({ ok: true, conversationId, confirmed: [requestId], complete: true });
  });

  it('restores a stream origin with no native message id after an app restart', async () => {
    await pair();
    const conversationId = '19191919-4141-6363-8585-979797979797';
    const requestId = '41111111-2222-4333-8444-555555555555';
    const mapped = await request('POST', '/correlations', {
      body: { conversationId, calls: [{ messageId: null, requestId, createTime: Date.now() / 1000 }] }
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body.confirmed).toContain(requestId);
    await flushDurable();

    resetCorrelationRegistryForTests();
    expect(requestCorrelation(requestId)).toBeNull();
    await restoreRequestCorrelations();

    expect(requestCorrelation(requestId)).toMatchObject({
      conversationId,
      messageId: `stream:${requestId}`
    });
  });

  /** Two stream origins in one batch are two ids, not one duplicate. Dedup keys on the message when there is one and on the request id when there is not; keying both on an absent message would have collapsed every stream row in a batch into the first. */
  it('keeps two stream origins apart when neither names a message', async () => {
    await pair();
    const conversationId = '18181818-4040-6262-8484-969696969696';
    const first = '21111111-2222-4333-8444-555555555555';
    const second = '31111111-2222-4333-8444-555555555555';
    const mapped = await request('POST', '/correlations', {
      body: { conversationId, calls: [
        { messageId: null, requestId: first, createTime: Date.now() / 1000 },
        { messageId: null, requestId: second, createTime: Date.now() / 1000 }
      ] }
    });
    expect(mapped.status).toBe(200);
    expect((mapped.body as { confirmed: string[] }).confirmed.sort()).toEqual([first, second].sort());
  });

  it('still refuses correlation evidence that names no request id at all', async () => {
    await pair();
    const refused = await request('POST', '/correlations', {
      body: {
        conversationId: '17171717-3939-6161-8383-959595959595',
        calls: [{ messageId: 'page-message-with-nothing-to-join-on', tool: 'agents', order: 0 }]
      }
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: 'bad_request_evidence' });
  });

  it('refuses a live handshake that contradicts an already-proven request owner without poisoning the original mapping', async () => {
    await pair();
    const firstConversation = '14141414-3636-5858-8080-929292929292';
    const secondConversation = '15151515-3737-5959-8181-939393939393';
    const requestId = 'wfr-live-owner-cannot-move';
    const call = {
      messageId: 'page-request-owner-fixed',
      tool: 'exec_command',
      order: 0,
      answered: false,
      requestId,
      createTime: Date.now() / 1000
    };

    const first = await request('POST', '/correlations', {
      body: { conversationId: firstConversation, calls: [call] }
    });
    expect(first.body).toMatchObject({ confirmed: [requestId], conflicts: [], complete: true });

    const second = await request('POST', '/correlations', {
      body: { conversationId: secondConversation, calls: [call] }
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ confirmed: [], conflicts: [requestId], complete: false });

    await recordToolCall({
      tool: 'exec_command',
      args: { command: 'echo owner-stays-first' },
      content: [{ type: 'text', text: 'owner-stays-first' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId,
      evidence: {
        changes: [],
        reviews: [],
        assets: [],
        count: null,
        detail: null,
        exitCode: 0,
        timedOut: false,
        durationMs: null,
        running: null,
        processSessionId: null
      }
    });

    const firstCalls = await readEvents(first.body.sessionId, { kinds: ['tool_call'] });
    expect(firstCalls.some((event) =>
      event.kind === 'tool_call' && event.call.requestId === requestId && event.call.conversationId === firstConversation
    )).toBe(true);
    const secondCalls = await readEvents(second.body.sessionId, { kinds: ['tool_call'] });
    expect(secondCalls).toEqual([]);
  });

  it('preserves complete logical message identities and projects their exact provider aliases', async () => {
    await pair();
    const conversationId = '99999999-8888-7777-6666-555555555551';
    const prefix = 'assistant:' + 'a'.repeat(179);
    const ids = [prefix + 'x', prefix + 'y'];
    expect(ids[0]).toHaveLength(190);
    const providers = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const result = await request('POST', '/events', { body: { conversationId, events: [
      ...ids.map((messageId, index) => ({ kind: 'assistant_message', messageId, providerMessageId: providers[index],
        time: Date.now(), text: `Message ${index}`, state: 'streaming' })),
      { kind: 'assistant_message', messageId: ids[0] + 'overflow', time: Date.now(), text: 'Must not alias' }
    ] } });
    const first = await readEvents(result.body.sessionId, { kinds: ['assistant_message'] });
    expect(first.map(event => event.kind === 'assistant_message' && event.messageId)).toEqual(ids);
    const origin = first[0]!.seq;
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'assistant_message', messageId: 'renamed-logical-message', providerMessageId: providers[0],
        time: Date.now(), text: 'Updated through exact provider identity', state: 'streaming' }
    ] } });
    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    const messages = reply.body.stream.filter((row: any) => row.kind === 'assistant_message');
    expect(messages).toHaveLength(2);
    expect(messages.find((row: any) => row.providerMessageId === providers[0])).toMatchObject({
      messageId: ids[0], origin, text: 'Updated through exact provider identity'
    });
    expect(messages.find((row: any) => row.providerMessageId === providers[1])).toMatchObject({ messageId: ids[1] });
  });

  it('records the send-request model on a user message and drops a malformed one', async () => {
    await pair();
    const conversationId = '99999999-8888-7777-6666-555555555553';
    const result = await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'user_message', messageId: 'user-a', time: Date.now(), text: 'A', model: 'gpt-5-6-thinking' },
      { kind: 'user_message', messageId: 'user-b', time: Date.now(), text: 'B', model: 'gpt 6 <b>' }
    ] } });
    const users = await readEvents(result.body.sessionId, { kinds: ['user_message'] });
    expect(Object.fromEntries(users.map(event => [event.kind === 'user_message' && event.messageId, event.model])))
      .toEqual({ 'user-a': 'gpt-5-6-thinking', 'user-b': undefined });
  });

  it('records the server-resolved reply model, keeps it across sparse updates and drops malformed values', async () => {
    await pair();
    const conversationId = '99999999-8888-7777-6666-555555555552';
    const result = await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'assistant_message', messageId: 'reply-a', time: Date.now(), text: 'A', state: 'streaming', resolvedModel: 'gpt-5-6-thinking' },
      { kind: 'assistant_message', messageId: 'reply-b', time: Date.now(), text: 'B', state: 'streaming', resolvedModel: 'gpt-6 <b>pro</b>' }
    ] } });
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'assistant_message', messageId: 'reply-a', time: Date.now(), text: 'A final', state: 'final' }
    ] } });
    const replies = await readEvents(result.body.sessionId, { kinds: ['assistant_message'] });
    const model = Object.fromEntries(replies.map(event => [event.kind === 'assistant_message' && event.messageId, event.kind === 'assistant_message' ? event.resolvedModel : null]));
    expect(model).toEqual({ 'reply-a': 'gpt-5-6-thinking', 'reply-b': undefined });
  });

  it('hands back an app-owned render stream plus legacy tool summaries, with no raw tool I/O', async () => {
    await pair();
    const conversationId = '99999999-8888-7777-6666-555555555555';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'user_message', time: Date.now(), text: 'private user text stays out of the render anchor', messageId: 'user-anchor-42' },
          { kind: 'turn_start', time: Date.now(), turnId: 'turn-42' },
          { kind: 'page_tool', time: Date.now(), turnId: 'turn-42', text: 'Searched the web', messageId: 'native-1' },
          { kind: 'tool_block', time: Date.now(), turnId: 'turn-42', count: 1 }
        ]
      }
    });
    await recordToolCall({
      tool: 'apply_patch',
      args: { patch: '*** Begin Patch\n*** Update File: /project/src/main.ts\n*** End Patch', secretish: 'value' },
      content: [{ type: 'text', text: 'edited' }],
      outcome: 'ok',
      durationMs: 30,
      startedAt: Date.now(),
      requestId: 'wfr_bridge_patch',
      conversationId,
      evidence: {
        changes: [{ path: '/project/src/main.ts', added: 18, removed: 4, approximate: false }],
        reviews: [],
        assets: [],
        count: null,
        detail: null,
        exitCode: null,
        timedOut: false,
        durationMs: null,
        running: null,
        processSessionId: null
      }
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.status).toBe(200);
    expect(reply.body.entries).toHaveLength(1);
    const entry = reply.body.entries[0];
    expect(entry.turnId).toBe('turn-42');
    expect(entry.attribution).toBe('request_id');
    expect(entry.summary.title).toBe('Edited src/main.ts');
    expect(entry.summary.metric).toBe('+18 −4');
    expect(entry.generating).toBeUndefined();
    expect(entry).not.toHaveProperty('args');
    expect(entry).not.toHaveProperty('argsTruncated');
    expect(entry).not.toHaveProperty('result');
    expect(reply.body.userAnchors).toHaveLength(1);
    expect(reply.body.userAnchors[0]).toMatchObject({ messageId: 'user-anchor-42' });
    expect(reply.body.userAnchors[0]).not.toHaveProperty('text');
    expect(reply.body.stream.map((item: any) => item.kind)).toEqual(['turn_start', 'page_tool', 'tool_call']);
    expect(reply.body.stream[1]).toMatchObject({
      turnId: 'turn-42',
      kind: 'page_tool',
      label: 'Searched the web',
      messageId: 'native-1'
    });
    expect(reply.body.stream[2]).toMatchObject({
      turnId: 'turn-42',
      tool: 'apply_patch',
      summary: { title: 'Edited src/main.ts', metric: '+18 −4' }
    });
    expect(reply.body.stream[2]).not.toHaveProperty('args');
    expect(reply.body.stream[2]).not.toHaveProperty('result');
    expect(reply.body.stream[2].detailRevision).toBeGreaterThan(0);
    expect(reply.body.stream[2].displayOutcome).toEqual({ code: 'completed', label: 'completed' });
    expect(reply.body.generating).toBe(true);

    const detail = await request('POST', '/activity/detail', { body: {
      conversationId, callId: reply.body.stream[2].callId, detailRevision: reply.body.stream[2].detailRevision
    } });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ ok: true, conversationId, callId: reply.body.stream[2].callId,
      detailRevision: reply.body.stream[2].detailRevision, tool: 'apply_patch',
      outcome: { code: 'completed', label: 'completed' },
      args: { truncated: false }, result: { text: 'edited', truncated: false } });
    expect(detail.body.args.text).toContain('*** Begin Patch');
    expect(detail.body).not.toHaveProperty('requestId');
    expect(JSON.stringify(detail.body)).not.toMatch(/assetId|assets/);
  });

  it('returns only one bounded redacted readable call preview and refuses cross-conversation disclosure', async () => {
    await pair();
    const conversationId = '78787878-6767-5656-4545-343434343434';
    const otherConversation = '89898989-7878-6767-5656-454545454545';
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'turn_start', time: Date.now(), turnId: 'detail-turn' }
    ] } });
    await recordToolCall({
      tool: 'plugin_fixture',
      args: { query: 'visible', secret: 'DETAIL_SECRET_SENTINEL', payload: 'q'.repeat(9_000) },
      content: [{ type: 'text', text: `Readable plugin text data:image/png;base64,${'C'.repeat(300)}` }],
      protocolResult: { content: [
        { type: 'text', text: 'Readable plugin text' },
        { type: 'resource', resource: { text: 'Readable resource text' } },
        { type: 'image', data: 'A'.repeat(2_000), mimeType: 'image/png' }
      ] },
      outcome: 'ok', durationMs: 4, startedAt: Date.now(), requestId: 'wfr_detail_projection', conversationId
    });
    await recordToolCall({
      tool: 'plugin_fixture',
      // This field is longer than the bounded stored prefix, so the preview ends inside the quoted binary body without a closing quote.
      args: { dataBase64: 'B'.repeat(9_000) },
      content: [{ type: 'text', text: 'binary args fixture' }],
      outcome: 'ok', durationMs: 2, startedAt: Date.now(), requestId: 'wfr_detail_truncated_binary', conversationId
    });
    const feed = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    const rows = feed.body.stream.filter((entry: any) => entry.kind === 'tool_call');
    const row = rows[0];
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty('args');
    expect(row).not.toHaveProperty('result');

    const detail = await request('POST', '/activity/detail', { body: {
      conversationId, callId: row.callId, detailRevision: row.detailRevision
    } });
    expect(detail.body.ok).toBe(true);
    expect(detail.body.args.text.length).toBeLessThanOrEqual(8_000);
    expect(detail.body.args).toMatchObject({ truncated: true, chars: expect.any(Number) });
    expect(detail.body.result.text).toContain('Readable plugin text');
    expect(detail.body.result.text).toContain('Readable resource text');
    expect(detail.body.result.text).toContain('binary payload omitted');
    expect(detail.body.args.text).toContain('q'.repeat(256));
    const serialized = JSON.stringify(detail.body);
    expect(serialized).not.toContain('DETAIL_SECRET_SENTINEL');
    expect(serialized).not.toContain('A'.repeat(128));
    expect(serialized).not.toMatch(/assetId|assets|more characters stored in full as/);

    const binaryArgs = await request('POST', '/activity/detail', { body: {
      conversationId, callId: rows[1].callId, detailRevision: rows[1].detailRevision
    } });
    expect(binaryArgs.body.args.text).toContain('binary payload omitted');
    expect(binaryArgs.body.args.text).not.toContain('B'.repeat(128));
    expect(JSON.stringify(binaryArgs.body)).not.toMatch(/assetId|more characters stored in full as/);

    await request('POST', '/events', { body: { conversationId: otherConversation, events: [
      { kind: 'turn_start', time: Date.now(), turnId: 'other-detail-turn' }
    ] } });
    await request('GET', `/activity?conversationId=${otherConversation}&since=0`);
    const foreign = await request('POST', '/activity/detail', { body: {
      conversationId: otherConversation, callId: row.callId, detailRevision: row.detailRevision
    } });
    expect(foreign.body).toEqual({ ok: false, error: 'call_not_available' });
    expect((await request('POST', '/activity/detail', { body: {
      conversationId, callId: [row.callId], detailRevision: row.detailRevision
    } })).status).toBe(400);
  });

  it('keeps existing details and records new history after a legacy writer proposes recording off', async () => {
    await pair();
    const conversationId = '67676767-5656-4545-3434-232323232323';
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'turn_start', time: Date.now(), turnId: 'recorded-before-off' }
    ] } });
    await recordToolCall({
      tool: 'read_file', args: { path: '/project/already-recorded.ts' },
      content: [{ type: 'text', text: 'recorded result' }], outcome: 'ok', durationMs: 2,
      startedAt: Date.now(), requestId: 'wfr_recorded_before_off', conversationId
    });
    const feed = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    const row = feed.body.stream.find((entry: any) => entry.kind === 'tool_call');
    const before = await readEvents(feed.body.sessionId);
    const previous = getConfig();
    try {
      await saveConfig({ ...previous, sessions: { ...previous.sessions, record: false } });
      expect(getConfig().sessions).toMatchObject({ record: true, retainDays: 0 });
      const detail = await request('POST', '/activity/detail', { body: {
        conversationId, callId: row.callId, detailRevision: row.detailRevision
      } });
      expect(detail.body).toMatchObject({ ok: true, callId: row.callId,
        args: { text: expect.stringContaining('already-recorded.ts') },
        result: { text: 'recorded result' } });
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'turn_start', time: Date.now() + 1, turnId: 'recorded-after-legacy-off' }
      ] } });
      const after = await readEvents(feed.body.sessionId);
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)).toMatchObject({ kind: 'turn_start', turnId: 'recorded-after-legacy-off' });
    } finally {
      await saveConfig(previous);
    }
  });

  it('projects pending and completed process outcomes from canonical completion evidence', async () => {
    await pair();
    const conversationId = '69696969-5858-4747-3636-252525252525';
    const opened = await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'turn_start', time: Date.now(), turnId: 'outcome-turn' }
    ] } });
    const baseCall = (callId: string, process: { sessionId: string; completedAt?: number; exitCode?: number | null; durationMs?: number }) => ({
      kind: 'tool_call' as const, source: 'mcp' as const, time: 100, turnId: 'outcome-turn', call: {
        callId, conversationId, requestId: `request-${callId}`, attribution: 'request_id' as const,
        attributionMethod: 'request_id' as const, tool: 'exec_command',
        args: { text: '{}', chars: 2, truncated: false }, result: { text: 'initial', chars: 7, truncated: false },
        durationMs: 5, outcome: 'ok' as const, process,
        summary: { kind: 'run' as const, tone: 'neutral' as const, title: 'Started fixture', metric: 'running' }
      }
    });
    await recordProcessCall(opened.body.sessionId, baseCall('pending', { sessionId: '1' }));
    await recordProcessCall(opened.body.sessionId, baseCall('zero', { sessionId: '2' }));
    await recordProcessCall(opened.body.sessionId, baseCall('nonzero', { sessionId: '3' }));
    await recordProcessCall(opened.body.sessionId, baseCall('unknown', { sessionId: '4' }));
    await recordProcessCall(opened.body.sessionId, baseCall('legacy-missing', {
      sessionId: '5', completedAt: 200, durationMs: 30
    }));
    await completeProcessCall(opened.body.sessionId, 'zero', { completedAt: 200, durationMs: 20, exitCode: 0 });
    await completeProcessCall(opened.body.sessionId, 'nonzero', { completedAt: 200, durationMs: 21, exitCode: 7 });
    await completeProcessCall(opened.body.sessionId, 'unknown', { completedAt: 200, durationMs: 22, exitCode: null });

    const feed = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    const rows = new Map(feed.body.stream.filter((entry: any) => entry.kind === 'tool_call')
      .map((entry: any) => [entry.callId, entry]));
    expect(rows.get('pending')).toMatchObject({ displayOutcome: { code: 'started', label: 'started' }, durationMs: 5 });
    expect(rows.get('zero')).toMatchObject({ displayOutcome: { code: 'completed', label: 'completed', exitCode: 0 }, durationMs: 20 });
    expect(rows.get('nonzero')).toMatchObject({ displayOutcome: { code: 'failed', label: 'failed · exit 7', exitCode: 7 }, durationMs: 21 });
    expect(rows.get('unknown')).toMatchObject({ displayOutcome: { code: 'finished', label: 'finished · exit unknown', exitCode: null }, durationMs: 22 });
    expect(rows.get('legacy-missing')).toMatchObject({ displayOutcome: { code: 'finished', label: 'finished · exit unknown', exitCode: null }, durationMs: 30 });
  });

  it('projects every current non-process outcome without making the content script reinterpret it', async () => {
    await pair();
    const conversationId = '56565656-4545-3434-2323-121212121212';
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'turn_start', time: Date.now(), turnId: 'outcome-enums' }
    ] } });
    const cases = [
      ['ok', 'completed', 'completed'],
      ['process_exit_nonzero', 'failed', 'failed · exit 4'],
      ['tool_rejected', 'refused', 'refused'],
      ['tool_execution_error', 'failed', 'failed'],
      ['tool_internal_error', 'internal_error', 'internal error']
    ] as const;
    for (const [outcome] of cases) {
      await recordToolCall({
        tool: 'exec_command', args: { command: `fixture-${outcome}` },
        content: [{ type: 'text', text: `result-${outcome}` }], outcome, durationMs: 3,
        startedAt: Date.now(), requestId: `wfr_enum_${outcome}`, conversationId,
        evidence: { changes: [], reviews: [], assets: [], count: null, detail: null,
          exitCode: outcome === 'process_exit_nonzero' ? 4 : null, timedOut: false,
          durationMs: null, running: null, processSessionId: null }
      });
    }
    const feed = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    const rows = new Map(feed.body.stream.filter((entry: any) => entry.kind === 'tool_call')
      .map((entry: any) => [entry.outcome, entry.displayOutcome]));
    for (const [outcome, code, label] of cases) expect(rows.get(outcome)).toEqual({ code, label,
      ...(outcome === 'process_exit_nonzero' ? { exitCode: 4 } : {}) });
  });

  /** The page folds the chat's first user message away when this says so, and that message is the handoff brief or the worker bootstrap — a screenful of machinery the user did not type. It is read off the session record rather than remembered in the tab, so it still holds when the chat is reopened days later. */
  it('says whether the app opened this chat itself, and how', async () => {
    await pair();
    const worker = '66666666-3333-2222-1111-000000000000';
    const own = '77777777-3333-2222-1111-000000000000';
    await noteChatOrigin(worker, { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Build it' });
    for (const conversationId of [worker, own]) {
      await request('POST', '/events', {
        body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-1' }] }
      });
    }

    expect((await request('GET', `/activity?conversationId=${worker}`)).body.bootstrap).toBe('worker');
    // A chat the user started themselves has nothing to fold away.
    expect((await request('GET', `/activity?conversationId=${own}`)).body.bootstrap).toBeNull();
  });

  it('reports the committed current resume independently of the original desktop origin', async () => {
    await pair();
    const { rebindSession } = await import("../../../backend/domains/sessions/history/store.js");
    const from = '77777777-3333-2222-1111-000000000071';
    const to = '77777777-3333-2222-1111-000000000072';
    const session = await createSession({ conversationId: from, origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
    expect((await request('GET', `/activity?conversationId=${from}`)).body.bootstrap).toBe('desktop');
    expect(await rebindSession(session.id, from, to, '2026-09-07-testproof')).toBe(true);
    expect((await request('GET', `/activity?conversationId=${to}`)).body.bootstrap).toBe('resume');
    expect((await request('GET', `/activity?conversationId=${from}`)).body.bootstrap).not.toBe('resume');
  });

  it('returns nothing for a conversation it has never seen', async () => {
    await pair();
    const reply = await request('GET', '/activity?conversationId=deadbeef-0000-0000-0000-000000000000');
    expect(reply.status).toBe(200);
    expect(reply.body.entries).toEqual([]);
    expect(reply.body.sessionId).toBeNull();
  });

  /** A chat ChatGPT has only just named, which the recorder has not attached to yet. The feed is empty then, and it used to answer with no goal at all — so the sheet above a New Chat opened on a loop read the reply as "nothing is driving this chat" the moment its id landed: the slider fell to Off, the task the user had just written vanished from it, and it said an API key was missing while the model that wrote the opening message was still streaming. None of that is a fact about the recorder. The switch, the task and the draft are keyed by conversation and durable, so they are answered from the first poll. */
  it('answers what drives a chat before the recorder has attached to it', async () => {
    await pair();
    const chat = 'cafe0044-0000-4000-8000-000000000044';
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'api', enabled: false, mode: 'goal' } });
    await writeDurableNow(GOAL_SWITCHES_STATE, null);

    // Exactly what a New Chat's opening does: the goal is bound as a loop before anything this chat says has been recorded.
    const saved = await request('POST', '/goal/objective', {
      body: { conversationId: chat, text: 'one cycle stop', mode: 'loop' }
    });
    expect(saved.status).toBe(200);

    const feed = await request('GET', `/activity?conversationId=${chat}`);
    expect(feed.status).toBe(200);
    expect(feed.body.sessionId).toBeNull();
    expect(feed.body.entries).toEqual([]);
    expect(feed.body.goal).toMatchObject({
      enabled: true,
      own: true,
      mode: 'loop',
      objective: 'one cycle stop',
      blocked: ''
    });
    // The app-wide default is still off: this chat answers for itself and says so.
    expect(getConfig().goal.enabled).toBe(false);
  });

  it('pages by sequence number so the extension never re-reads what it has', async () => {
    await pair();
    const conversationId = '12121212-3434-5656-7878-909090909090';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 't' },
          { kind: 'tool_block', time: Date.now(), turnId: 't', count: 4 }
        ]
      }
    });
    for (let i = 0; i < 3; i++) {
      await recordToolCall({
        tool: 'read_file',
        args: { path: `/project/f${i}.ts` },
        content: [{ type: 'text', text: 'body' }],
        outcome: 'ok',
        durationMs: 2,
        startedAt: Date.now(),
        requestId: `wfr_bridge_page_${i}`,
        conversationId
      });
    }
    // A later user message is not rendered in the assistant stream, but it still advances the shared sequence cursor so the browser cannot re-read it forever.
    await request('POST', '/events', {
      body: { conversationId, events: [{ kind: 'user_message', time: Date.now(), text: 'next question', messageId: 'next-q' }] }
    });
    const all = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(all.body.entries).toHaveLength(3);
    const lastSeq = all.body.entries.at(-1).seq;
    expect(all.body.nextSince).toBeGreaterThan(lastSeq + 1);
    const after = await request('GET', `/activity?conversationId=${conversationId}&since=${all.body.nextSince}`);
    expect(after.body.entries).toEqual([]);
    expect(after.body.stream).toEqual([]);
    expect(after.body.nextSince).toBe(all.body.nextSince);
  });

  it('never sends a credential argument through session history or the extension activity feed', async () => {
    await pair();
    const conversationId = '45454545-6767-8989-abab-cdcdcdcdcdcd';
    await request('POST', '/events', {
      body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'secret-turn' },
          { kind: 'tool_block', time: Date.now(), turnId: 'secret-turn', count: 2 }
        ]
      }
    });
    // The credentials this app still handles all arrive the same way: a user pastes one into a `secret` argument. It must not reach disk, session history or the feed.
    const secret = 'bridge-token-9f2c4d6e8a0b2c4d6e8a1f3b';
    await recordToolCall({
      tool: 'read_file',
      args: { path: '/project/secret.ts', secret },
      content: [{ type: 'text', text: 'could not read secret.ts' }],
      // Failed summaries may copy the first result line into summary.detail, so this exercises the leak path that an otherwise-successful call would not touch.
      outcome: 'tool_internal_error',
      durationMs: 2,
      startedAt: Date.now(),
      requestId: 'wfr_bridge_secret',
      conversationId
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(reply.body.entries).toHaveLength(1);
    const serialised = JSON.stringify(reply.body.entries[0]);
    expect(serialised).not.toContain(secret);
    expect(reply.body.entries[0]).not.toHaveProperty('args');
    expect(reply.body.entries[0]).not.toHaveProperty('result');
    expect(JSON.stringify(reply.body.stream)).not.toContain(secret);
    const stored = JSON.stringify(await readEvents(reply.body.sessionId));
    expect(stored).not.toContain(secret);
    expect(stored).toContain('<removed>');
  });

  /** There is no live worker code any more, and no sentence that hands one out. This used to cover the reply `agents action=join` sent a worker: a three-character routing code in prose, which went to disk, to session history and to the Activity feed verbatim, and which had to be cut out by matching the sentence that published it. A worker is identified by the conversation it is in, so nothing is published, nothing has to be cut, and the recovery key that was the last credential here is gone with it. */
  it('writes no credential of any kind into an agents call it recorded', async () => {
    await pair();
    const conversationId = '56565656-7878-9a9a-bcbc-dedededede00'.slice(0, 36);
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'agents-turn' },
          { kind: 'tool_block', time: Date.now(), turnId: 'agents-turn', count: 1 }
        ]
      }
    });
    spawn({ workers: [{ task: 'security check' }], caller: { conversationId: PRIME_CHAT } });

    await recordToolCall({
      tool: 'agents',
      args: { action: 'finish', result: 'RESULT one path can misattribute a call.' },
      content: [{ type: 'text', text: 'Reported to prime. This worker is done.' }],
      outcome: 'ok',
      durationMs: 2,
      startedAt: Date.now()
    });

    const reply = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    const stored = JSON.stringify(await readEvents(reply.body.sessionId));
    for (const written of [JSON.stringify(reply.body), stored]) {
      expect(written).not.toMatch(/agent[_ ]?key|join[_ ]?key|recovery key/i);
    }
  });
});
