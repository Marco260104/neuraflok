import {
  attributedMcp,
  createSession,
  getSession,
  input,
  message,
  post,
  randomUUID,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('sends an immediate message into a running GPT-5.6 turn through the composer after its calls (#1231)', async () => {
  const conversationId = randomUUID(), turnId = randomUUID();
  const session = await createSession({ title: 'Message for the running turn', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', time: Date.now() },
    { kind: 'user_message', messageId: randomUUID(), text: 'Inspect the current task', time: Date.now() },
    { kind: 'turn_start', turnId, time: Date.now() }
  ] });
  await attributedMcp(conversationId);
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  expect(row).toMatchObject({ transportIntent: 'browser', directTurn: { id: turnId } });
  expect((await input.pendingBrowserInputs()).find(item => item.id === row.id)).toMatchObject({ directTurn: { id: turnId } });
  expect((await post('/input/claim', { id: row.id, owner: 'turn-page', conversationId, requiresAuthorization: true })).body.input)
    .toMatchObject({ id: row.id, directTurn: { id: turnId } });
});

it('hands a message for the running turn to the browser while one of its calls is still running (#1231)', async () => {
  const { trackInFlight, emptyEvidence } = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
  const conversationId = randomUUID(), turnId = randomUUID();
  const session = await createSession({ title: 'Message during a running call', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', time: Date.now() },
    { kind: 'user_message', messageId: randomUUID(), text: 'Run the long command', time: Date.now() },
    { kind: 'turn_start', turnId, time: Date.now() }
  ] });
  await trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { requestId: randomUUID(), transportKey: null, conversationId } }, async () => {
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', delivery: 'tool' });
    expect(row).toMatchObject({ transportIntent: 'browser', directTurn: { id: turnId } });
    const status = await post('/status', { openConversations: [conversationId] });
    expect(status.body.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.id, directTurn: { id: turnId, startedAt: expect.any(Number) } })]));
    // The page's claim must succeed during the call too: VM 141, 2026-10-09, the claim was refused until the call returned, so the message waited ~35 s and reached the turn only between calls.
    expect((await post('/input/claim', { id: row.id, owner: 'turn-page', conversationId, requiresAuthorization: true })).body.input)
      .toMatchObject({ id: row.id, directTurn: { id: turnId } });
  });
});

it('still holds an ordinary queued message for a chat while one of its calls is running', async () => {
  const { trackInFlight, emptyEvidence } = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Queued message during a call', conversationId });
  await trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { requestId: randomUUID(), transportKey: null, conversationId } }, async () => {
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
    expect(row.directTurn).toBeUndefined();
    expect((await post('/input/claim', { id: row.id, owner: 'idle-page', conversationId, requiresAuthorization: true })).body.input).toBeNull();
  });
});

// A running GPT-5.6 turn takes an immediate message directly (above); these cover the boundary.
it.each([
  { mode: 'after-turn', earlyEnd: false }, { mode: 'finish', earlyEnd: false },
  { mode: 'auto', earlyEnd: true }, { mode: 'after-turn', earlyEnd: true }, { mode: 'finish', earlyEnd: true }
] as const)('delivers $mode queued during a delayed report of the current final (early end: $earlyEnd)', async ({ mode, earlyEnd }) => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID(), turnId = randomUUID();
    const session = await createSession({ title: 'Delayed final and follow-up', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'user_message', messageId: randomUUID(), text: 'Inspect the current task', time: now },
      { kind: 'turn_start', turnId, time: now }
    ] });
    await attributedMcp(conversationId);
    const completedAt = now + 1000;
    now += 2000;
    if (earlyEnd) {
      await post('/events', { conversationId, events: [{ kind: 'turn_end', turnId, outcome: 'completed', time: completedAt }] });
      // A UI end without its final retains the same exact MCP-backed work grant.
      expect(await input.sessionInputPolicy(session.id)).toMatchObject({ canInject: true, injectionTurnId: turnId, settled: false });
    }
    // The browser has finished, but its journal has not reached the app yet.
    expect((await getSession(session.id))?.activeTurnId).toBe(earlyEnd ? null : turnId);
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode });
    const next = mode === 'auto' ? null : await input.enqueueInput({ ...message(session.id, 'off'), mode, text: 'A later checkpoint' });
    expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(false);
    const finalEvents = [
      { kind: 'assistant_message', turnId, messageId: randomUUID(), text: 'The task is complete.',
        state: 'final', final: true, activeNow: true, time: completedAt },
      { kind: 'turn_end', turnId, outcome: 'completed', time: completedAt }
    ];
    await post('/events', { conversationId, events: finalEvents });
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({ browserAllowed: true, settled: true });
    input.resetInputForTests();
    expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(true);
    expect((await input.listInputs()).find(item => item.id === row.id)?.queuedTurn).toEqual({ conversationId, turnId });
    const { trackInFlight, emptyEvidence } = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
    await trackInFlight({ startedAt: now, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { requestId: randomUUID(), transportKey: null, conversationId } }, async () => {
      expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(false);
      expect(await input.claimBrowserInput(row.id, 'running-tool-document', conversationId, true)).toBeNull();
    });
    const claim = await input.claimBrowserInput(row.id, 'followup-document', conversationId, true);
    expect(claim?.id).toBe(row.id);
    expect(claim?.completedTurnId).toBe(turnId);
    expect(await input.authorizeBrowserInput(row.id, 'followup-document', conversationId)).toBe(true);
    expect(await input.authorizeBrowserInput(row.id, 'followup-document', conversationId)).toBe(false);
    expect(await input.acknowledgeBrowserInput(row.id, 'followup-document', conversationId, randomUUID())).toBe(true);
    await post('/events', { conversationId, events: finalEvents });
    input.resetInputForTests();
    expect((await input.pendingBrowserInputs()).some(item => item.id === row.id || item.id === next?.id)).toBe(false);
    if (next) expect((await input.listInputs()).find(item => item.id === next.id)?.state).toBe('queued');
  } finally { clock.mockRestore(); }
});

it.each(['after-turn', 'finish'] as const)('does not release %s queued after the answer was already recorded, including replay', async mode => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID(), turnId = randomUUID();
    const session = await createSession({ title: 'Already completed queue boundary', conversationId });
    const events = [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'user_message', messageId: randomUUID(), text: 'Original question', time: now },
      { kind: 'turn_start', turnId, time: now },
      { kind: 'assistant_message', turnId, messageId: randomUUID(), text: 'Already complete.', state: 'final', final: true, time: now },
      { kind: 'turn_end', turnId, outcome: 'completed', time: now }
    ];
    await post('/events', { conversationId, events });
    now += 2000;
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode });
    expect(row.queuedTurn).toBeUndefined();
    await post('/events', { conversationId, events });
    input.resetInputForTests();
    expect((await input.pendingBrowserInputs()).some(item => item.id === row.id)).toBe(false);
    expect(await input.claimBrowserInput(row.id, 'old-answer-document', conversationId, true)).toBeNull();
  } finally { clock.mockRestore(); }
});

it('does not pin an idle chat to tool transport because another call is unattributed', async () => {
  const { trackInFlight, emptyEvidence } = await import('../../backend/infrastructure/tool-gateway/protocol/call-context.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Completed target', conversationId });
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', time: Date.now() },
    { kind: 'turn_start', turnId: 'completed-before-input', time: Date.now() },
    { kind: 'turn_end', turnId: 'completed-before-input', outcome: 'completed', time: Date.now() }
  ] });
  let row!: import('../../backend/domains/sessions/input/input.js').InputEntry;
  await trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
    caller: { requestId: null, transportKey: null, conversationId: null } }, async () => {
    row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
    expect(row.transportIntent).toBeUndefined();
    expect((await input.sessionInputPolicy(session.id)).canInject).toBe(false);
    expect(await input.claimBrowserInput(row.id, 'fresh-document', conversationId)).toBeNull();
  });
  expect(await input.claimBrowserInput(row.id, 'fresh-document', conversationId)).not.toBeNull();
});
