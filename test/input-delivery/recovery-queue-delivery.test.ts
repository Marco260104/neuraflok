import {
  APP_VERSION,
  BRIDGE_PROTOCOL,
  attributedMcp,
  bearer,
  bridgePort,
  createSession,
  defaultConfig,
  flushDurable,
  goal,
  input,
  message,
  post,
  randomUUID,
  saveConfig,
  silentTurnContinue,
  writeDurableNow,
} from './context.js';
import { expect, it, vi } from 'vitest';

it.each([false, true])('pauses completed queued input at manual close through the final Send fence (claimed: %s)', async claimed => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID(), turnId = randomUUID();
    const session = await createSession({ title: 'Closed queued delivery', conversationId });
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'after-turn' });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: ++now },
      { kind: 'turn_start', turnId, time: now },
      { kind: 'assistant_message', messageId: randomUUID(), turnId, text: 'Done.', state: 'final', final: true, time: ++now },
      { kind: 'turn_end', turnId, outcome: 'completed', time: ++now }
    ] });
    expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(true);
    if (claimed) expect(await input.claimBrowserInput(row.id, 'closing-document', conversationId, true)).not.toBeNull();
    now++;
    await post('/closed', { conversationId, manual: true });
    expect((await post('/status', { openConversations: [] })).body.inputs.some((item: any) => item.id === row.id)).toBe(false);
    expect(await input.claimBrowserInput(row.id, 'late-document', conversationId, true)).toBeNull();
    expect(await input.authorizeBrowserInput(row.id, 'closing-document', conversationId)).toBe(false);
    expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'queued', text: row.text });
    now++;
    const returned = await fetch(`http://127.0.0.1:${bridgePort()}/activity?conversationId=${conversationId}`, {
      headers: { authorization: `Bearer ${bearer}`, 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL) }
    });
    expect(returned.status).toBe(200);
    expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(true);
  } finally { clock.mockRestore(); }
});

it('keeps automatic Continue attached to the native question after injected corrections', async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const bridge = await import('../../backend/domains/browser/bridge.js');
    const store = await import('../../backend/domains/sessions/history/store.js');
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
    const conversationId = randomUUID(), turnId = randomUUID(), questionId = randomUUID();
    const session = await createSession({ title: 'Native recovery question', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'user_message', messageId: questionId, text: 'Finish the task', time: now },
      { kind: 'turn_start', turnId, time: now }
    ] });
    await attributedMcp(conversationId);
    now += 10_000;
    for (let index = 0; index < 3; index++) await store.appendEvent(session.id, {
      kind: 'user_message', source: 'app', time: now, turnId,
      inputId: `inline-correction-${index}`, messageId: `input:inline-correction-${index}`,
      message: { text: 'Keep this detail.', truncated: false, chars: 17 }
    });
    await attributedMcp(conversationId);
    now += 120_000;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs.find((item: any) => item.conversationId === conversationId);
    expect(repair?.reason).toBe('silence');
    expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const row = (await input.listInputs()).find(item => item.sessionId === session.id && item.recovery)!;
    expect(row.recovery?.questionId).toBe(questionId);
    expect((await input.pendingBrowserInputs()).find(item => item.id === row.id)?.recovery?.questionId).toBe(questionId);
    expect(await input.claimBrowserInput(row.id, 'replacement-document', conversationId, true)).not.toBeNull();
  } finally { clock.mockRestore(); }
});

/** The reason a recovery message could not be sent, kept instead of dropped. A Continue that was never authorized is still owed, so `releaseRecoveryClaim` hands the ticket back to the queue on purpose and keeps its pickup budget. What went with it was the explanation: the page tells the app exactly why it could not send, `failBrowserInput` receives that string, and this one branch was the only one that discarded it — every other branch there stores it as `error`. Measured on 2026-09-26: one recovery row claimed twelve times in three minutes, back to `queued` every time, with no `error` on the receipt and not a single line in the log. The loop was visible only because the *claims* are logged; the reason for the release was nowhere. */
it('keeps the reason a recovery claim was released, and says it once', async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const bridge = await import('../../backend/domains/browser/bridge.js');
    const { getLog } = await import('../../backend/infrastructure/settings/logger.js');
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
    const conversationId = randomUUID(), turnId = randomUUID(), questionId = randomUUID();
    const session = await createSession({ title: 'Released recovery claim', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'user_message', messageId: questionId, text: 'Finish the task', time: now },
      { kind: 'turn_start', turnId, time: now }
    ] });
    await attributedMcp(conversationId);
    now += 120_000;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs
      .find((item: any) => item.conversationId === conversationId);
    expect(repair?.reason, 'no silence repair, so no recovery row to release').toBe('silence');
    expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const row = (await input.listInputs()).find(item => item.sessionId === session.id && item.recovery)!;
    expect(row, 'no recovery row was filed').toBeTruthy();

    expect(await input.claimBrowserInput(row.id, 'a-document', conversationId, true)).not.toBeNull();
    const reason = 'The composer refused the prepared text.';
    expect(await input.failBrowserInput(row.id, 'a-document', reason)).toBe(true);

    // The ticket survives — that is the point of releasing rather than failing it — and now it carries why it came back.
    const released = (await input.listInputs()).find(item => item.id === row.id)!;
    expect(released.state, 'the ticket was not handed back to the queue').toBe('queued');
    expect(released.owner).toBeNull();
    expect(released.error, 'the reason the browser gave was discarded').toBe(reason);

    const said = getLog().filter(entry => entry.message.includes('could not send this recovery message'));
    expect(said, 'the release was not reported at all').toHaveLength(1);
    expect(said[0]!.message).toContain(reason);

    // Said once per reason, not once per attempt: the schedule re-offers the same ticket in seconds.
    expect(await input.claimBrowserInput(row.id, 'a-document', conversationId, true)).not.toBeNull();
    expect(await input.failBrowserInput(row.id, 'a-document', reason)).toBe(true);
    expect(getLog().filter(entry => entry.message.includes('could not send this recovery message')),
      'it repeated itself once per attempt').toHaveLength(1);

    // A different reason is new information and is said.
    expect(await input.claimBrowserInput(row.id, 'a-document', conversationId, true)).not.toBeNull();
    expect(await input.failBrowserInput(row.id, 'a-document', 'The tab moved to another chat.')).toBe(true);
    expect(getLog().filter(entry => entry.message.includes('could not send this recovery message'))).toHaveLength(2);
  } finally { clock.mockRestore(); }
});

it('says why a page withdrew a Continue and ends it after three minutes of withdrawals (#820)', async () => {
  // Measured in #820: a page released the same automatic Continue about once a second for many minutes, its text left in the composer, and the log never said why after the first time.
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const bridge = await import('../../backend/domains/browser/bridge.js');
    const { getLog } = await import('../../backend/infrastructure/settings/logger.js');
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
    const conversationId = randomUUID(), turnId = randomUUID(), questionId = randomUUID();
    const session = await createSession({ title: 'Withdrawn recovery claim', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'user_message', messageId: questionId, text: 'Finish the task', time: now },
      { kind: 'turn_start', turnId, time: now }
    ] });
    await attributedMcp(conversationId);
    now += 120_000;
    await bridge.sweepStaleSwarm(now);
    const repair = (await post('/status', { openConversations: [conversationId] })).body.repairs
      .find((item: any) => item.conversationId === conversationId);
    expect((await post('/repairs/claim', { token: repair.token })).body.allowed).toBe(true);
    await post(`/status?repaired=${repair.token}&repairAction=reloaded`, { openConversations: [conversationId] });
    const row = (await input.listInputs()).find(item => item.sessionId === session.id && item.recovery)!;
    const withdrawn = 'After-turn pickup was withdrawn before Send.';

    // Through the bridge route, as the extension reports it: the reason travels with the release.
    expect(await input.claimBrowserInput(row.id, 'a-document', conversationId, true)).not.toBeNull();
    expect((await post('/input/fail', { id: row.id, owner: 'a-document', conversationId, error: withdrawn, detail: 'send-not-ready' })).body.ok).toBe(true);
    expect(getLog().filter(entry => entry.message.includes('could not send this recovery message')).at(-1)?.message)
      .toContain('(send-not-ready)');
    const firstRelease = now;
    expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'queued',
      recovery: { withdrawnSince: firstRelease } });

    // Repeated withdrawals inside the window keep handing the ticket back, from the same start.
    for (let attempt = 0; attempt < 5; attempt++) {
      now += 30_000;
      expect(await input.claimBrowserInput(row.id, 'a-document', conversationId, true)).not.toBeNull();
      expect(await input.failBrowserInput(row.id, 'a-document', withdrawn, 'page-unreadable')).toBe(true);
      expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'queued',
        recovery: { withdrawnSince: firstRelease } });
    }
    // Past three minutes of nothing but withdrawals the Continue ends, and the log says why.
    now = firstRelease + input.RECOVERY_WITHDRAW_LIMIT_MS;
    expect(await input.claimBrowserInput(row.id, 'a-document', conversationId, true)).not.toBeNull();
    expect(await input.failBrowserInput(row.id, 'a-document', withdrawn, 'page-unreadable')).toBe(true);
    expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'failed',
      error: 'Automatic Continue was not sent: page-unreadable' });
    expect(getLog().some(entry => entry.message.includes('automatic Continue ended') && entry.message.includes('page-unreadable'))).toBe(true);
    input.resetInputForTests();
    expect((await input.pendingBrowserInputs()).filter(item => item.id === row.id)).toEqual([]);
  } finally { clock.mockRestore(); }
});

it('ends a Continue the page refuses before claiming because its answer is finished', async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false } });
    const { conversationId, turnId, session, row } = await silentTurnContinue('Finished before Continue', ms => now += ms);

    // Only for its own chat.
    expect((await post('/input/claim', { id: row.id, owner: 'a-document', conversationId: randomUUID(), recoveryVeto: 'page-final' })).body.ok).toBe(false);
    expect((await post('/input/claim', { id: row.id, owner: 'a-document', conversationId, recoveryVeto: 'page-final' })).body.ok).toBe(true);
    expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'cancelled',
      error: 'Automatic Continue was not needed: the page shows a finished answer.', recovery: { ended: 'page-final' } });

    // Nothing changed since: the same turn does not get the same Continue back.
    expect(await input.fileRecoveryInput(session.id, conversationId, turnId, false, () => true)).toBe(false);
    // New work is a new situation, and may earn a restart again.
    await attributedMcp(conversationId);
    expect(await input.fileRecoveryInput(session.id, conversationId, turnId, false, () => true)).toBe(true);

    // And only for an automatic Continue: a typed message is never ended by a page's verdict.
    const typed = await input.enqueueInput({ ...message(session.id, 'off'), text: 'typed while waiting', mode: 'after-turn' });
    expect((await post('/input/claim', { id: typed.id, owner: 'a-document', conversationId, recoveryVeto: 'page-final' })).body.ok).toBe(false);
    expect((await input.listInputs()).find(item => item.id === typed.id)?.state).toBe('queued');
  } finally { clock.mockRestore(); }
});

it.each([
  { model: 'gpt-5.6-sol', alias: false }, { model: 'gpt-5.6-sol', alias: true },
  { model: 'gpt-6-pro', alias: false }, { model: 'gpt-6-pro', alias: true }
])('retires Goal only when queued input commits its exact source ($model, restored alias: $alias)', async ({ model, alias }) => {
  const store = await import('../../backend/domains/sessions/history/store.js');
  const durable = await import('../../backend/persistence/durable.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Queue before Goal commitment', conversationId });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, backend: 'templates' } });
    await goal.setGoalObjectiveNow(conversationId, 'Complete the current requested work');
    await goal.setGoalSwitchNow(conversationId, 'goal', true);
    const row = await input.enqueueInput({ ...message(session.id, 'off'), automation: undefined, mode: 'after-turn' });
    now += 10;
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model, time: now },
      { kind: 'turn_start', turnId: 'queue-source', time: now },
      { kind: 'assistant_message', turnId: 'queue-source', messageId: 'queue-source-answer', text: 'Current result', state: 'final', final: true, time: now + 1 },
      { kind: 'turn_end', turnId: 'queue-source', outcome: 'completed', time: now + 2 }
    ] });
    now += 3;
    const [answer] = await store.readRecentEvents(session.id, 1, { kinds: ['assistant_message'] });
    expect(answer?.kind).toBe('assistant_message');
    const source = alias && answer?.kind === 'assistant_message' ? `reply:${answer.messageId}` : 'queue-source';
    const obligation = { conversationId, sessionId: session.id, replyId: 'queue-source-obligation', turnId: source, eventSeq: answer!.seq, blocked: false };
    await goal.acceptGoalReplyNow(obligation);
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(obligation.replyId);
    const activity = async () => {
      const response = await fetch(`http://127.0.0.1:${bridgePort()}/activity?conversationId=${conversationId}`, {
        headers: { authorization: `Bearer ${bearer}`, 'x-extension-version': APP_VERSION, 'x-extension-protocol': String(BRIDGE_PROTOCOL) }
      });
      expect(response.status).toBe(200);
      return await response.json() as any;
    };
    expect(await input.claimBrowserInput(row.id, 'queue-page', conversationId, true)).not.toBeNull();
    expect((await activity()).goal.queuePending).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(obligation.replyId);
    expect(await input.failBrowserInput(row.id, 'queue-page', 'After-turn pickup was withdrawn before Send.')).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe(obligation.replyId);
    expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');

    expect(await input.claimBrowserInput(row.id, 'queue-page-retry', conversationId, true)).not.toBeNull();
    expect(await input.authorizeBrowserInput(row.id, 'queue-page-retry', conversationId)).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(await input.acknowledgeBrowserInput(row.id, 'queue-page-retry', conversationId, 'queued-user-message')).toBe(true);
    await flushDurable();
    const saved = await durable.readDurable<Parameters<typeof goal.restoreGoalReplies>[0]>(goal.GOAL_REPLIES_STATE);
    const switches = goal.snapshotGoalSwitches(), objectives = goal.snapshotGoalObjectives();
    await writeDurableNow('session-input', []); // Simulate receipt retention pruning after other sessions advance.
    input.resetInputForTests(); goal.resetGoalStateForTests(); goal.restoreGoalSwitches(switches); goal.restoreGoalObjectives(objectives); goal.restoreGoalReplies(saved);
    await goal.acceptGoalReplyNow(obligation); // Replayed old final cannot recreate the handled obligation.
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(await input.inputBeforeGoal(session.id, 'queue-source')).toBeNull();
    await goal.acceptGoalReplyNow({ ...obligation, replyId: 'new-source-obligation', turnId: 'new-source', eventSeq: answer!.seq + 100 });
    expect(goal.goalPendingReplyFor(conversationId)?.turnId).toBe('new-source');
  } finally { clock.mockRestore(); }
});
