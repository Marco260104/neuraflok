import {
  APP_VERSION,
  BRIDGE_PROTOCOL,
  attributedMcp,
  bearer,
  bridgePort,
  createSession,
  defaultConfig,
  getSession,
  goal,
  input,
  message,
  post,
  randomUUID,
  saveConfig,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('does not turn generic failed/error prose or an unknown wire reason into queue authority', async () => {
  const { readEvents } = await import('../../backend/domains/sessions/history/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Unclassified failure', conversationId });
  await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn', afterTurn: true });
  await post('/events', { conversationId, events: [
    { kind: 'turn_start', turnId: 'unclassified', time: Date.now() },
    { kind: 'turn_end', turnId: 'unclassified', outcome: 'failed', reason: 'unrecognized', detail: 'Thinking failed', time: Date.now() + 1 }
  ] });
  expect((await readEvents(session.id, { kinds: ['turn_end'] })).at(-1)).not.toHaveProperty('reason');
  expect(await input.pendingBrowserInputs()).toEqual([]);
});

it.each([
  [false, 'same-batch'], [true, 'same-batch'], [true, 'before-start'], [true, 'after-start'], [true, 'after-refresh'], [false, 'unknown'], [true, 'unknown']
] as const)('normal/unknown queued recovery uses two minutes plus one minute after ACK (Goal enabled: %s, selection: %s)', async (enabled, selection) => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Normal queued recovery', conversationId });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled } });
    if (enabled) await goal.setGoalSwitchNow(conversationId, 'goal', true);
    const observed = { kind: 'model_selection', model: 'gpt-5-6-thinking', reasoningEffort: 'high', time: now };
    if (selection === 'before-start') await post('/events', { conversationId, events: [observed] });
    await post('/events', { conversationId, events: [
      ...(selection === 'same-batch' ? [observed] : []),
      { kind: 'turn_start', turnId: 'normal-silence', time: now }
    ] });
    if (selection === 'after-start') await post('/events', { conversationId, events: [observed] });
    expect(bridge.sessionInputActivity((await getSession(session.id))!).model).toBe(['unknown', 'after-refresh'].includes(selection) ? 'unknown' : 'other');
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    const second = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await attributedMcp(conversationId);
    now += 119_999;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((r: any) => r.conversationId === conversationId)).toBe(false);
    now += 2;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((r: any) => r.conversationId === conversationId);
    expect(repair).toMatchObject({ reason: 'silence' });
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const boundary = (await input.listInputs()).find(row => row.id === first.id)!.silenceBoundary!;
    expect(boundary.listenUntil).toBe(now + 60_000);
    expect((await bridge.sessionControlsFor(session.id)).recovery).toEqual([{ kind: 'post-reload', next: 'queue', deadline: boundary.listenUntil, generating: true }]);
    if (selection === 'after-refresh') {
      now += 10_000;
      await post('/events', { conversationId, events: [{ ...observed, time: now }] });
      expect(bridge.sessionInputActivity((await getSession(session.id))!).model).toBe('other');
      expect((await bridge.sessionControlsFor(session.id)).recovery).toEqual([{ kind: 'post-reload', next: 'queue', deadline: boundary.listenUntil, generating: true }]);
      await bridge.sweepStaleSwarm(now);
      expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(false);
    }
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now = boundary.listenUntil! - 1;
    expect((await post('/input/claim', { id: first.id, owner: 'normal-page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
    now++;
    await bridge.sweepStaleSwarm(now);
    expect(await input.pendingBrowserInputs()).toEqual([expect.objectContaining({ id: first.id })]);
    const activity = await fetch(`http://127.0.0.1:${bridgePort()}/activity?conversationId=${conversationId}`, { headers: {
      authorization: `Bearer ${bearer}`, 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL)
    } }).then(r => r.json());
    expect(activity.goal).toMatchObject({ queuePending: true, draft: null, pending: null });
    if (enabled) expect((await post('/goal/draft', { conversationId, turnId: 'normal-silence' })).body.error).toBe('user_input_pending');
    const claim = { id: first.id, owner: 'normal-page', conversationId, requiresAuthorization: true };
    expect((await post('/input/claim', claim)).body.input?.id).toBe(first.id);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await post('/input/ack', { ...claim, messageId: 'normal-next' })).body.ok).toBe(true);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    expect((await input.listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  } finally { clock.mockRestore(); }
});

it.each(['open', 'stalled', 'final-during-listen', 'failure-during-listen', 'failure-before-claim', 'failure-after-claim'])('files one durable after-turn ticket only after the silence refresh ACK (%s)', async boundary => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Silent Pro', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
      { kind: 'user_message', messageId: 'silence-user', text: 'Continue the task', time: now },
      { kind: 'turn_start', turnId: 'silence-turn', time: now }
    ] });
    await attributedMcp(conversationId);
    now += bridge.PRO_SILENCE_MS - 1;
    await bridge.sweepStaleSwarm(now);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now += 2;
    if (boundary === 'stalled') await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'silence-turn', outcome: 'stalled', time: now }
    ] });
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    expect(await input.pendingBrowserInputs()).toEqual([]);
    const confirmedAt = now;
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary?.turnId).toBe('silence-turn');
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([expect.objectContaining({ id: first.id, silenceTurnId: 'silence-turn' })]);
    const claim = { id: first.id, owner: 'refreshed-page', conversationId };
    if (boundary === 'failure-after-claim') {
      expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    } else if (boundary !== 'failure-before-claim') {
      if (boundary === 'failure-during-listen') now += 10_000;
      expect((await post('/input/claim', { ...claim, silenceBusyTurnId: 'silence-turn' })).body.ok).toBe(true);
      expect(await input.pendingBrowserInputs()).toEqual([]);
    }
    if (boundary === 'final-during-listen' || boundary === 'failure-during-listen' || boundary === 'failure-before-claim' || boundary === 'failure-after-claim') {
      now++;
      await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'silence-turn', time: now,
        ...(boundary === 'final-during-listen' ? { outcome: 'completed' } : { outcome: 'failed', reason: 'thinking_failed' }) }] });
    }
    // The exact source already has a confirmed refresh. Learning its failure must keep that receipt and native-busy deadline, not ask for a second reload.
    if (boundary === 'failure-during-listen' || boundary === 'failure-before-claim') {
      const status = await post('/status', { openConversations: [conversationId] });
      expect(status.body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(false);
      const row = (await input.listInputs()).find(row => row.id === first.id)!;
      expect(row.silenceBoundary?.listenUntil).toBe(confirmedAt + 5 * 60_000 + (boundary === 'failure-during-listen' ? 10_000 : 0));
      input.resetInputForTests();
      expect(await input.pendingBrowserInputs()).toEqual([]);
    }
    if (boundary === 'failure-after-claim') {
      // An already offered automatic row is immutable. The new failure changes the source work sequence, so its old claim cannot cross final Send.
      expect((await input.listInputs()).find(row => row.id === first.id)?.state).toBe('browser');
      expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(false);
      expect((await post('/input/fail', { ...claim, error: 'After-turn pickup was withdrawn before Send.' })).body.ok).toBe(true);
      now = confirmedAt + 5 * 60_000 - 1;
      await bridge.sweepStaleSwarm(now);
      expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input).toBeNull();
      now++;
      await bridge.sweepStaleSwarm(now);
    }
    const until = (await input.listInputs()).find(row => row.id === first.id)!.silenceBoundary!.listenUntil!;
    if (until > now) {
      now = until - 1;
      expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input).toBeNull();
      now++;
    }
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    expect((await post('/input/fail', { ...claim, error: 'After-turn pickup was withdrawn before Send.' })).body.ok).toBe(true);
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(true);
    expect((await input.listInputs()).find(row => row.id === first.id)?.state).toBe('browser');
    expect((await post('/input/ack', { ...claim, messageId: 'accepted-next' })).body.ok).toBe(true);
    input.resetInputForTests();
    expect(await input.pendingBrowserInputs()).toEqual([]);
  } finally { clock.mockRestore(); }
});

it('continues an Extra High chat whose turn ended as failed after two minutes, not twenty', async () => {
  // Measured 2026-10-01: an Extra High prime lost its stream twice; each turn ended as failed and the chat then sat toward its twenty-minute thinking window until its owner typed "continue".
  const bridge = await import('../../backend/domains/browser/bridge.js');
  await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, autoContinue: true } });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failed Extra High', conversationId });
    const questionId = randomUUID(), turnId = randomUUID();
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', time: now },
      { kind: 'user_message', messageId: questionId, text: 'Finish the long task', time: now },
      { kind: 'turn_start', turnId, time: now }
    ] });
    await attributedMcp(conversationId);
    now += 5 * 60_000;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs
      .some((row: any) => row.conversationId === conversationId)).toBe(false);

    await post('/events', { conversationId, events: [
      { kind: 'chat_error', text: 'Resume stream unavailable', recoverable: true, time: now },
      { kind: 'turn_end', turnId, outcome: 'failed', time: now }
    ] });
    now += 2 * 60_000 + 1;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs
      .find((row: any) => row.conversationId === conversationId && row.reason === 'silence');
    expect(repair, 'the failed turn waited for the long thinking window').toBeDefined();
    if (repair.requiresClaim) expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect((await input.listInputs()).find(row => row.sessionId === session.id && row.recovery))
      .toMatchObject({ state: 'queued', recovery: { questionId, phase: 'ready' } });
  } finally { clock.mockRestore(); }
});

it('commits a failed-source listening deadline while another chat observation is still recording', async () => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  const recorder = await import('../../backend/domains/sessions/history/recorder.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let release = () => {};
  let otherPost: Promise<unknown> | undefined;
  let held: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failed receipt concurrency', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: now },
      { kind: 'turn_start', turnId: 'concurrent-failed-source', time: now }
    ] });
    await attributedMcp(conversationId);
    now += bridge.PRO_SILENCE_MS;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    const confirmedAt = now;
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    expect(await input.pendingBrowserInputs()).toHaveLength(1);
    const otherId = randomUUID();
    let entered = () => {};
    const recording = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const record = recorder.recordChatObservations;
    held = vi.spyOn(recorder, 'recordChatObservations').mockImplementation(async (...args) => {
      if (args[0] === otherId) { entered(); await gate; }
      return record(...args);
    });
    otherPost = post('/events', { conversationId: otherId, events: [{ kind: 'turn_start', turnId: 'unrelated-turn', time: now }] });
    await recording;
    now += 6_000;
    expect((await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId: 'concurrent-failed-source',
      outcome: 'failed', reason: 'thinking_failed', time: now }] })).status).toBe(200);
    input.resetInputForTests();
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary?.listenUntil).toBe(confirmedAt + 5 * 60_000);
    const claim = { id: first.id, owner: 'replacement', conversationId, requiresAuthorization: true };
    now = confirmedAt + 5 * 60_000 - 1;
    expect((await post('/input/claim', claim)).body.input).toBeNull();
    release(); await otherPost;
    now++;
    expect((await post('/input/claim', claim)).body.input?.id).toBe(first.id);
  } finally { release(); await otherPost; held?.mockRestore(); clock.mockRestore(); }
});

it.each(['queued', 'claimed', 'tool', 'settled-failure'])('withdraws a silence ticket on new work and rearms refresh (%s)', async change => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Resumed Pro', conversationId });
    const first = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'user_message', messageId: 'resume-user', text: 'Continue', time: now },
      { kind: 'turn_start', turnId: 'resume-turn', time: now }
    ] });
    await attributedMcp(conversationId);
    now += bridge.PRO_SILENCE_MS + 1;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((row: any) => row.conversationId === conversationId);
    expect(repair).toBeDefined();
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const claim = { id: first.id, owner: 'resume-page', conversationId };
    if (change === 'claimed' || change === 'tool') expect((await post('/input/claim', { ...claim, requiresAuthorization: true })).body.input?.id).toBe(first.id);
    if (change === 'settled-failure') await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: 'resume-turn', outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    now += 1_000;
    if (change === 'tool') {
      const { recordToolCall } = await import('../../backend/domains/sessions/history/recorder.js');
      await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'Read complete' }],
        outcome: 'ok', durationMs: 1, startedAt: now, requestId: 'silence-resumed-call', conversationId });
    } else await post('/events', { conversationId, events: [
      { kind: 'assistant_message', turnId: 'resume-turn', messageId: 'new-interim', text: 'Still working', state: 'streaming', activeNow: true, time: now }
    ] });
    expect((await input.listInputs()).find(row => row.id === first.id)).toMatchObject({ state: 'queued', owner: null });
    expect((await input.listInputs()).find(row => row.id === first.id)?.silenceBoundary).toBeUndefined();
    expect((await post('/input/claim', { ...claim, authorize: true })).body.ok).toBe(false);
    expect(await input.pendingBrowserInputs()).toEqual([]);
    now += bridge.PRO_SILENCE_MS - 1;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.filter((row: any) => row.conversationId === conversationId)).toEqual([]);
    now += 2;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', { openConversations: [conversationId] })).body.repairs.some((row: any) => row.conversationId === conversationId)).toBe(true);
  } finally { clock.mockRestore(); }
});
