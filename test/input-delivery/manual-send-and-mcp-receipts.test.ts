import {
  attributedMcp,
  createSession,
  defaultConfig,
  goal,
  input,
  message,
  post,
  randomUUID,
  refreshFailedView,
  saveConfig,
  writeDurableNow,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

it('defers an immediate failed-view manual send for native busy without requiring MCP or adding a checkpoint', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failed manual native busy', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'turn_start', turnId: 'failed-without-mcp', time: now },
      { kind: 'turn_end', turnId: 'failed-without-mcp', outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    const checkpoint = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Later checkpoint', mode: 'after-turn' });
    const manual = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Immediate correction', mode: 'auto' });
    const offer = (await post('/status', { openConversations: [conversationId] })).body.inputs.find((row: any) => row.id === manual.id);
    expect(offer).toMatchObject({ id: manual.id, silenceTurnId: 'failed-without-mcp' });
    expect((await input.listInputs()).find(row => row.id === manual.id)?.silenceBoundary).toBeUndefined();
    const claim = { id: manual.id, owner: 'busy-page', conversationId, requiresAuthorization: true };
    expect((await post('/input/claim', { ...claim, silenceBusyTurnId: offer.silenceTurnId })).body.ok).toBe(true);
    input.resetInputForTests();
    now += 5 * 60_000 - 1;
    expect((await post('/input/claim', claim)).body.input).toBeNull();
    expect((await input.listInputs()).find(row => row.id === manual.id)?.state).toBe('queued');
    now++;
    const delivered = (await post('/input/claim', claim)).body.input;
    expect(delivered?.text).toContain(manual.text);
    expect(delivered?.text).not.toContain(checkpoint.text);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/ack', { ...claim, messageId: 'manual-after-busy' })).body.ok).toBe(true);
    expect((await input.listInputs()).find(row => row.id === checkpoint.id)?.state).toBe('queued');
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  } finally { clock.mockRestore(); }
});

it.each(['app', 'browser'] as const)('files a missing failed-turn Loop ticket on explicit %s off/on and retains interim context', async surface => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  const store = await import('../../backend/domains/sessions/history/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Explicit failed Loop activation', conversationId });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'user_message', messageId: 'request', text: 'Build all stage layers', time: now },
      { kind: 'turn_start', turnId: 'activation-source', time: now },
      { kind: 'assistant_message', messageId: 'interim', turnId: 'activation-source', text: 'Portal repaired; rear geometry remains', state: 'streaming', time: now },
      { kind: 'turn_end', turnId: 'activation-source', outcome: 'failed', reason: 'thinking_failed', time: now + 1 }
    ] });
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(await goal.conversationMessages(session.id)).toEqual([
      { role: 'user', content: 'Build all stage layers' },
      { role: 'assistant', content: 'Portal repaired; rear geometry remains' }
    ]);
    await goal.setGoalSwitchNow(conversationId, 'loop', false, true);
    const toggle = async (on: boolean) => surface === 'app'
      ? bridge.setSessionAutomation(session.id, on ? 'loop' : 'off')
      : post('/settings', { conversationId, loop: on });
    await toggle(true);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    await toggle(false);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    now += 300001;
    await toggle(true);
    const first = goal.goalPendingReplyFor(conversationId)!;
    expect(first).toMatchObject({ turnId: 'activation-source', replyId: 'activation:activation-source' });
    const draft = { conversationId, turnId: first.turnId, clientId: 'activation-page', terminalRequired: true };
    await toggle(false);
    await toggle(true);
    expect(goal.goalPendingReplyFor(conversationId)!.acceptedAt).toBeGreaterThan(first.acceptedAt);
    goal.restoreGoalReplies(goal.snapshotGoalReplies());
    const queued = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, mode: 'auto' });
    expect((await post('/goal/draft', draft)).body.error).toBe('user_input_pending');
    await input.cancelInput(queued.id);
    expect((await post('/goal/draft', draft)).status).toBe(200);
    await toggle(false);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    now++;
    await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'new-work', time: now }] });
    await toggle(true);
    expect((await post('/goal/draft', draft)).status).toBe(409);
    expect((await store.getSession(session.id))?.activeTurnId).toBe('new-work');
    await toggle(false);
  } finally { clock.mockRestore(); }
});

it.each(['auto', 'after-turn'] as const)('reserves the failed-view five-minute window for automatic work, not manual %s input', async mode => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  const { trackInFlight, emptyEvidence } = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failure manual priority', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'turn_start', turnId: 'failure-priority', time: now }
    ] });
    await attributedMcp(conversationId);
    const row = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, mode });
    now++;
    await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'failure-priority', outcome: 'failed', reason: 'thinking_failed', time: now }] });
    expect((await input.pendingBrowserInputs()).some(r => r.id === row.id)).toBe(mode === 'auto');
    now += 300_000;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect((await input.pendingBrowserInputs()).some(r => r.id === row.id)).toBe(mode === 'auto');
    if (mode === 'auto') {
      const claim = { id: row.id, owner: 'failed-page', conversationId, requiresAuthorization: true };
      expect((await post('/input/claim', claim)).body.input?.id).toBe(row.id);
      await trackInFlight({ startedAt: now, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
        caller: { requestId: randomUUID(), transportKey: null, conversationId } }, async () => {
        expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).not.toBe(true);
      });
      expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
      expect((await post('/input/ack', { ...claim, messageId: 'manual-after-failure' })).body.ok).toBe(true);
      now += 300001;
      await bridge.sweepStaleSwarm(now);
      expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    } else {
      now += 300000;
      expect((await input.pendingBrowserInputs()).some(r => r.id === row.id)).toBe(true);
    }
  } finally { clock.mockRestore(); }
});

// Pro keeps tool injection; a GPT-5.6 turn takes the same message directly (test above).
it.each([
  ['gpt-6-pro', false], ['gpt-6-pro', true]
] as const)('delivers after the full final or recovers after %s silence (full final: %s)', async (model, nativeCompleted) => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Silence correction and checkpoint', conversationId });
    await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model, time: now },
      { kind: 'turn_start', turnId: 'silent-source', time: now }
    ] });
    await attributedMcp(conversationId);
    const { stageInputAttachment } = await import('../../backend/domains/sessions/input/attachments/index.js');
    const attachment = await stageInputAttachment({ text: 'Checkpoint reference' }, new Set());
    const checkpoint = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Verify the geometry', mode: 'after-turn', attachments: [attachment] });
    const later = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Prepare the export', mode: 'after-turn' });
    const manual = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, text: 'Use no color or textures', mode: 'auto' });
    expect(manual.transportIntent).toBe('tool');
    if (nativeCompleted) {
      await post('/events', { conversationId, events: [
        { kind: 'assistant_message', turnId: 'silent-source', messageId: 'full-final', text: 'Provider reports a result', state: 'final', final: true, time: now },
        { kind: 'turn_end', turnId: 'silent-source', outcome: 'completed', time: now }
      ] });
      const ready = await post('/input/claim', { id: manual.id, owner: 'finished-page', conversationId, requiresAuthorization: true });
      expect(ready.body.input?.text).toBe(manual.text);
      expect((await post('/goal/draft', { conversationId, turnId: 'silent-source', terminalRequired: true })).status).toBe(409);
      now += model === 'gpt-6-pro' ? 600001 : 120001;
      await bridge.sweepStaleSwarm(now);
      const repairs = (await post('/status', { openConversations: [conversationId] })).body.repairs;
      expect(repairs.some((repair: any) => repair.conversationId === conversationId && repair.reason === 'silence')).toBe(false);
      expect((await input.listInputs()).find(row => row.id === later.id)?.state).toBe('queued');
      return;
    }
    const window = model === 'gpt-6-pro' ? 600000 : 120000;
    now += window - 1;
    await bridge.sweepStaleSwarm(now);
    expect((await input.pendingBrowserInputs()).some(r => r.conversationId === conversationId)).toBe(false);
    now += 2;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
    expect(repair?.reason).toBe('silence');
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    input.resetInputForTests();
    expect((await input.pendingBrowserInputs()).filter(r => r.conversationId === conversationId)).toEqual([expect.objectContaining({ id: manual.id })]);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    const claim = { id: manual.id, owner: 'recovered-page', conversationId, requiresAuthorization: true };
    const response = await post('/input/claim', claim);
    expect(response.body.input?.text).toContain(manual.text);
    expect(response.body.input?.text).toContain(checkpoint.text);
    expect(response.body.input?.text).not.toContain(later.text);
    expect(response.body.input?.attachments).toEqual([attachment]);
    const fileRequest = { ...claim, attachmentId: attachment.id, offset: 0 };
    expect((await post('/input/attachment', { ...fileRequest, owner: 'wrong-page' })).status).toBe(409);
    expect(Buffer.from((await post('/input/attachment', fileRequest)).body.chunk, 'base64').toString()).toBe('Checkpoint reference');
    input.resetInputForTests();
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/attachment', fileRequest)).status).toBe(409);
    expect((await post('/input/ack', { ...claim, messageId: 'combined-user' })).body.ok).toBe(true);
    const rows = await input.listInputs();
    expect(rows.find(r => r.id === manual.id)?.state).toBe('sent');
    expect(rows.find(r => r.id === checkpoint.id)?.state).toBe('sent');
    expect(rows.find(r => r.id === later.id)?.state).toBe('queued');
    const { readEvents } = await import('../../backend/domains/sessions/history/store.js');
    const messages = await readEvents(session.id, { kinds: ['user_message'] });
    expect(messages.filter(event => event.kind === 'user_message' && event.messageId === 'combined-user')).toHaveLength(1);
    expect(messages.find(event => event.kind === 'user_message' && event.messageId === 'combined-user')).toMatchObject({
      authoredText: expect.stringContaining(checkpoint.text), attachments: [attachment], message: { text: expect.stringContaining(manual.text) }
    });
    expect((await post('/goal/draft', { conversationId, turnId: 'silent-source', terminalRequired: true })).status).toBe(409);
  } finally { clock.mockRestore(); }
});

describe.each(['input', 'loop'] as const)('MCP admission for %s recovery', destination => {
  describe.each(['silence', 'thinking_failed'] as const)('%s boundary', boundary => {
    it.each(['none', 'previous-turn', 'native-tool', 'request-only', 'current-turn'] as const)(
      'requires an actual attributed call in this turn (%s)', async evidence => {
      const bridge = await import('../../backend/domains/browser/bridge.js');
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const conversationId = randomUUID();
        const session = await createSession({ title: 'Recovery MCP admission', conversationId });
        await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'web' } });
        if (destination === 'loop') await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
        if (evidence === 'previous-turn') {
          await post('/events', { conversationId, events: [{ kind: 'turn_start', turnId: 'previous-mcp-turn', time: now }] });
          await attributedMcp(conversationId);
          await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'previous-mcp-turn', outcome: 'stopped', time: now }] });
          now++;
        }
        await post('/events', { conversationId, events: [
          { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
          { kind: 'user_message', messageId: 'new-user', text: 'Fixture task', time: now },
          { kind: 'turn_start', turnId: 'current-turn', time: now }
        ] });
        const row = destination === 'input' ? await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' }) : null;
        if (evidence === 'current-turn') await attributedMcp(conversationId);
        if (evidence === 'native-tool') await post('/events', { conversationId, events: [
          { kind: 'page_tool', turnId: 'current-turn', messageId: 'native-tool', label: 'Used container tool', time: now }
        ] });
        if (evidence === 'request-only') await post('/events', { conversationId, events: [
          { kind: 'tool_evidence', time: now, calls: [{ messageId: 'request-sighting', tool: 'read', order: 0, answered: false, requestId: randomUUID() }] }
        ] });
        if (boundary === 'silence') {
          now += bridge.PRO_SILENCE_MS + 1;
          await bridge.sweepStaleSwarm(now);
          const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((item: any) => item.conversationId === conversationId);
          expect(!!repair).toBe(evidence === 'current-turn');
          if (repair) await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
        } else {
          now += 330_000;
          await post('/events', { conversationId, events: [
            { kind: 'turn_end', turnId: 'current-turn', outcome: 'failed', reason: 'thinking_failed', time: now }
          ] });
          if (evidence === 'current-turn') await refreshFailedView(conversationId, ms => { now += ms; });
          else expect((await post('/status', { openConversations: [conversationId] })).body.repairs
            .some((repair: any) => repair.conversationId === conversationId)).toBe(false);
        }
        const eligible = evidence === 'current-turn';
        if (row) {
          input.resetInputForTests();
          expect((await input.listInputs()).find(item => item.id === row.id)?.silenceBoundary !== undefined).toBe(eligible);
          expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(eligible);
          expect(!!(await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input).toBe(eligible);
        } else {
          goal.restoreGoalReplies(goal.snapshotGoalReplies());
          expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
          expect((await input.listInputs()).some(item => item.sessionId === session.id && item.recovery && item.state === 'queued')).toBe(eligible);
        }
      } finally { clock.mockRestore(); }
    });
  });
});

it.each(['gpt-6-pro', 'gpt-5.6-sol'])('carries settled Thinking failed through HTTP, recording and one queued send (%s)', async model => {
  const { readEvents } = await import('../../backend/domains/sessions/history/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Native failure queue', conversationId });
  const time = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model, time },
    { kind: 'turn_start', turnId: 'native-failed-turn', time }
  ] });
  const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  const second = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  await attributedMcp(conversationId);
  await post('/events', { conversationId, events: [
    { kind: 'chat_error', turnId: 'native-failed-turn', text: 'Thinking failed', reason: 'thinking_failed', recoverable: false, time: Date.now() }
  ] });
  expect((await readEvents(session.id, { kinds: ['chat_error'] })).at(-1)).toMatchObject({ reason: 'thinking_failed', recoverable: false });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  // Content closes the failed view immediately; the refresh/listening owner gates automatic delivery.
  const end = { kind: 'turn_end', turnId: 'native-failed-turn', outcome: 'failed', reason: 'thinking_failed', detail: 'Thinking failed', time: Date.now() + 1 };
  expect((await post('/events', { conversationId, events: [end] })).status).toBe(200);
  expect((await readEvents(session.id, { kinds: ['turn_end'] })).at(-1)).toMatchObject({ reason: 'thinking_failed', outcome: 'failed' });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await refreshFailedView(conversationId, ms => { now += ms; });
    expect(await input.pendingBrowserInputs()).toEqual([{ id: first.id, conversationId, silenceTurnId: 'native-failed-turn' }]);
    {
      const busyAt = Date.now();
      clock.mockReturnValue(busyAt);
      expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, silenceBusyTurnId: 'native-failed-turn' })).body.ok).toBe(true);
      input.resetInputForTests();
      const extraWait = model === 'gpt-6-pro' ? 300_000 : 60_000;
      clock.mockReturnValue(busyAt + extraWait - 1);
      expect(await input.pendingBrowserInputs()).toEqual([]);
      expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
      clock.mockReturnValue(busyAt + extraWait);
      expect(await input.pendingBrowserInputs()).toHaveLength(1);
    }
    const claim = await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, requiresAuthorization: true });
    expect(claim.body.input).toMatchObject({ id: first.id, completedTurnId: 'native-failed-turn' });
    expect((await post('/input/claim', { id: first.id, owner: 'failed-turn-page', conversationId, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/ack', { id: first.id, owner: 'failed-turn-page', conversationId, messageId: 'queued-next-user' })).body.ok).toBe(true);
    input.resetInputForTests();
    await post('/events', { conversationId, events: [end] });
    expect(await input.pendingBrowserInputs()).toEqual([]);
    expect((await input.listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  } finally { clock.mockRestore(); }
});

it.each(['gpt-6-pro', 'gpt-5.6-sol'])('preserves failed prime recovery while another worker tool outlives five minutes (%s)', async model => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  const calls = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const conversationId = randomUUID(), worker = randomUUID();
  await createSession({ title: 'Prime recovery with a busy worker', conversationId });
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'web' } });
  await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model, reasoningEffort: 'high', time: now },
    { kind: 'user_message', messageId: 'prime-question', text: 'Finish the original task with its worker', time: now },
    { kind: 'turn_start', turnId: 'prime-failed-view', time: now }
  ] });
  await attributedMcp(conversationId);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const running = calls.trackMcpRequest(() => calls.trackInFlight({ startedAt: now, transportKey: null,
    agent: 'worker-1', outcome: null, evidence: calls.emptyEvidence(),
    caller: { conversationId: worker, requestId: randomUUID(), transportKey: null } }, () => held));
  try {
    now++;
    await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'prime-failed-view', outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    await refreshFailedView(conversationId, ms => { now += ms; });
    const pending = (await input.listInputs()).find(row => row.conversationId === conversationId && row.recovery)!;
    expect(pending).toMatchObject({ state: 'queued', silenceBoundary: { turnId: 'prime-failed-view' } });
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(calls.runningToolCalls(worker)).toBe(1);
    expect(calls.runningToolCalls(conversationId)).toBe(0);
    now += 2 * 60_000;
    await bridge.sweepStaleSwarm(now);
    expect((await input.claimBrowserInput(pending.id, 'prime-page', conversationId, true))?.id).toBe(pending.id);
    expect(await input.authorizeBrowserInput(pending.id, 'prime-page', conversationId)).toBe(true);
    release(); await running;
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  } finally { release(); await running; clock.mockRestore(); }
});

it('refuses restored recovery tickets without MCP proof but still delivers a real final', async () => {
  const { readRecentEvents } = await import('../../backend/domains/sessions/history/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Restored recovery admission', conversationId });
  await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, mode: 'loop', loopBackend: 'web' } });
  await goal.setGoalSwitchNow(conversationId, 'loop', true, true);
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-pro', time: Date.now() },
    { kind: 'turn_start', turnId: 'restored-turn', time: Date.now() }
  ] });
  const [start] = await readRecentEvents(session.id, 1);
  await writeDurableNow('session-input', [{ ...row, silenceBoundary: { turnId: 'restored-turn', conversationId, workSeq: start!.seq } }]);
  input.resetInputForTests();
  goal.restoreGoalReplies({ version: 1, savedAt: Date.now(), replies: [{ conversationId, sessionId: session.id,
    replyId: 'silence:restored', turnId: 'g-silence-restored', silenceSourceTurnId: 'restored-turn', silencePro: true,
    eventSeq: start!.seq, acceptedAt: Date.now(), state: 'pending' }] });
  expect(await input.pendingBrowserInputs()).toEqual([]);
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
  expect((await post('/goal/draft', { conversationId, turnId: 'g-silence-restored', terminalRequired: true })).status).toBe(409);
  await post('/events', { conversationId, events: [
    { kind: 'assistant_message', turnId: 'restored-turn', messageId: 'restored-final', text: 'Finished', state: 'final', final: true, time: Date.now() },
    { kind: 'turn_end', turnId: 'restored-turn', outcome: 'completed', time: Date.now() + 1 }
  ] });
  expect((await post('/input/claim', { id: row.id, owner: 'page', conversationId, requiresAuthorization: true })).body.input?.id).toBe(row.id);
});
