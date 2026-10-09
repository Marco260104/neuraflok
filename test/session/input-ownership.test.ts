import {
  fixture,
  openings,
  binding,
  automate,
  changed,
  sessionId,
  input,
  seedLegacyInput,
  offerToolInput,
} from './input-context.js';
import { describe, expect, it, vi } from 'vitest';
import { readDurable, writeDurableNow } from '../../backend/persistence/durable.js';
import {
  inputArgs,
  acknowledgeBrowserInput,
  cancelInput,
  claimBrowserInput,
  completeBrowserDecision,
  enqueueInput,
  listInputs,
  offerToolInput as offerToolInputBatch,
  acknowledgeToolInput,
  pendingBrowserInputs,
  requestBrowserDecision,
  resetInputForTests,
  configureInputDelivery,
  hasEligibleToolInput,
  editQueuedInput,
  reorderQueuedInputs,
  setInputAutomation,
  authorizeBrowserInput,
  sessionInputPolicy,
  retryUnclaimedInput,
  noteInputStartupError,
  acceptLocalExecutorInput,
} from '../../backend/domains/sessions/input/input.js';
import type { InputEntry } from '../../backend/domains/sessions/input/input.js';
import { noteChatOrigin } from '../../backend/domains/sessions/history/recorder.js';
import { listUsageSessions } from '../../backend/domains/sessions/history/store.js';
import {
  trackInFlight,
  emptyEvidence,
  type CallContext,
} from '../../backend/infrastructure/tool-gateway/protocol/call-context.js';

describe('durable user input ownership', () => {
  it.each(['api', 'deepseek', 'kimi', 'qwen', 'glm'] as const)('keeps %s custody durable before browser election and refuses a foreign executor', async executor => {
    const args = input({ sessionId: null });
    const row = await enqueueInput(args, undefined, executor);
    expect(row.localExecutor).toBe(executor);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'foreign-document', null, true)).toBeNull();
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)?.localExecutor).toBe(executor);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await acceptLocalExecutorInput(row.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'message')).toBe(false);
    const prefixes = { api: 'ap', deepseek: 'ds', kimi: 'km', qwen: 'qw', glm: 'gm' };
    const conversation = `${prefixes[executor]}-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
    expect(await acceptLocalExecutorInput(row.id, conversation, 'message')).toBe(true);
  });
  it.each([
    ['held for Setup', 'Message queued. Finish Setup to send: Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.', 'queued'],
    ['held after a failed browser start', 'Message queued. Browser startup failed: Chrome refused startup', 'queued'],
    ['simply never picked up', null, 'failed']
  ] as const)('applies the 60-second browser pickup deadline only to a message the app is not holding (%s)', async (_case, held, state) => {
    // Seen on Windows without Setup: the follow-up said "Message queued. Finish Setup to send" and a minute later failed as "the browser did not pick up this message", losing the queue entry and naming the wrong cause.
    binding.finishEnabled = false;
    const row = await enqueueInput(input());
    expect(row.transportIntent).toBe('browser');
    if (held) await noteInputStartupError(row.id, held);
    fixture.now += 60_001;
    resetInputForTests();
    const after = (await listInputs()).find(entry => entry.id === row.id);
    expect(after?.state).toBe(state);
    if (held) expect(after?.error).toBe(held);
    else expect(after?.error).toContain('did not pick up this message');
  });
  it('requeues one proven pre-Send browser pickup timeout on the same row, then stops retrying', async () => {
    binding.model = 'gpt-5.6-sol'; binding.finishEnabled = false;
    const row = await enqueueInput(input());
    expect(row.transportIntent).toBe('browser');
    fixture.now += 60_001;
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed', pickupFailedAt: fixture.now,
      error: 'Not sent: the browser did not pick up this message within 60 seconds.' });
    fixture.now += 120_000;
    const retried = await retryUnclaimedInput(row.id);
    expect(retried).toMatchObject({ id: row.id, state: 'queued', pickupRetryCount: 1 });
    expect(retried).not.toHaveProperty('sendAuthorizedAt');
    expect(retried).not.toHaveProperty('deliveredAt');
    fixture.now += 60_001;
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ id: row.id, state: 'failed', pickupRetryCount: 1 });
    fixture.now += 120_000;
    expect(await retryUnclaimedInput(row.id)).toBeNull();
  });
  it('does not retry a pickup timeout after the user dismissed its browser chat', async () => {
    binding.model = 'gpt-5.6-sol'; binding.finishEnabled = false;
    const row = await enqueueInput(input());
    fixture.now += 60_001;
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed',
      error: 'Not sent: the browser did not pick up this message within 60 seconds.' });

    // retryUnclaimedBrowserInputs only opens the chat after retryUnclaimedInput returns a row. A manual browser dismissal must therefore leave this same row failed and produce no wake.
    openings.set(sessionId, Object.assign({ id: sessionId, conversationId: binding.conversationId,
      origin: { kind: binding.origin } }, { browserRecoveryDismissedAt: fixture.now }));
    fixture.now += 120_000;
    expect(await retryUnclaimedInput(row.id)).toBeNull();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed' });
    expect((await listInputs()).find(entry => entry.id === row.id)).not.toHaveProperty('pickupRetryCount');
  });
  it('does not requeue a never-claimed input after Automatic Continue is turned off', async () => {
    binding.model = 'gpt-5.6-sol'; binding.finishEnabled = false;
    const row = await enqueueInput(input());
    fixture.now += 60_001;
    await listInputs();
    fixture.now += 120_000;
    binding.recoveryAllowed = false;
    expect(await retryUnclaimedInput(row.id)).toBeNull();
    const retained = (await listInputs()).find(entry => entry.id === row.id);
    expect(retained?.state).toBe('failed');
    expect(retained?.pickupRetryCount).toBeUndefined();
  });
  it('never auto-retries an authorized or legacy unmarked pickup failure', async () => {
    binding.model = 'gpt-5.6-sol'; binding.finishEnabled = false;
    const authorized = await enqueueInput(input());
    fixture.now += 60_001;
    await listInputs();
    const rows = await listInputs();
    await writeDurableNow('session-input', rows.map(row => row.id === authorized.id
      ? { ...row, state: 'failed' as const, pickupFailedAt: fixture.now - 120_000, sendAuthorizedAt: fixture.now - 30_000 }
      : row));
    resetInputForTests();
    fixture.now += 120_000;
    expect(await retryUnclaimedInput(authorized.id)).toBeNull();
    const legacy = await enqueueInput(input());
    fixture.now += 60_001;
    await listInputs();
    const legacyRows = await listInputs();
    await writeDurableNow('session-input', legacyRows.map(row => row.id === legacy.id
      ? { ...row, state: 'failed' as const, pickupFailedAt: undefined, error: 'Not sent: the browser did not pick up this message within 60 seconds.' }
      : row));
    resetInputForTests();
    fixture.now += 120_000;
    expect(await retryUnclaimedInput(legacy.id)).toBeNull();
  });
  it('gives a released hold its full 60 seconds for the browser to pick it up', async () => {
    binding.finishEnabled = false;
    const row = await enqueueInput(input());
    await noteInputStartupError(row.id, 'Message queued. Finish Setup to send: Add a folder before connecting.');
    fixture.now += 10 * 60_000; // Setup takes a while.
    await noteInputStartupError(row.id, null); // Setup done: the browser may take it now.
    fixture.now += 59_000;
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
    fixture.now += 2_000;
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('failed');
  });
  it('preserves messages beyond the former composer limit through admission, restart and browser claim', async () => {
    binding.finishEnabled = false;
    const text = 'Long user request. '.repeat(2000);
    const row = await enqueueInput(input({ text }));
    resetInputForTests();
    expect((await listInputs())[0]?.text).toBe(text.trim());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).toMatchObject({ text: text.trim(), deliveryText: text.trim() });
  });
  it('edits queued text beyond 16000 characters while retaining the message transport ceiling', async () => {
    const row = await enqueueInput(input({ mode: 'after-turn' }));
    const text = 'x'.repeat(32_000);
    expect(await editQueuedInput(row.id, text)).toBe(true);
    expect((await listInputs())[0]?.text).toBe(text);
    await expect(editQueuedInput(row.id, 'x'.repeat(96_001))).rejects.toThrow();
    expect((await listInputs())[0]?.text).toBe(text);
    expect(inputArgs.safeParse(input({ text: 'x'.repeat(96_001) })).success).toBe(false);
  });
  it('sends a tool-free non-Pro correction through one durable browser claim and native receipt', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    binding.lastToolCallAt = 800; // Earlier turns do not change this turn's menu.
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'plain-turn', startedAt: 900 } });
    const direct = await enqueueInput(input());
    expect(direct).toMatchObject({ transportIntent: 'browser', directTurn: { id: 'plain-turn' } });
    expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: direct.id, directTurn: direct.directTurn })]);
    const claim = await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
    expect(claim?.directTurn).toEqual(direct.directTurn);
    expect(await offerToolInput(sessionId, binding.conversationId, 'racing-tool', fixture.now)).toEqual([]);
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'stopped', turnId: 'plain-turn', time: 1001 };
    expect(await authorizeBrowserInput(direct.id, 'native-page', binding.conversationId)).toBe(true);
    expect(await authorizeBrowserInput(direct.id, 'native-page', binding.conversationId)).toBe(false);
    expect(await acknowledgeBrowserInput(direct.id, 'native-page', binding.conversationId, 'native-message')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: 'native-message' });
  });

  // A message inside a tool result never reached the model on GPT-5.6/6 (#1231): Inject now goes through ChatGPT's composer whenever the running turn takes a message, tool calls or not.
  it('sends an explicit Inject now into the running turn through the composer, tool calls or not', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    binding.lastToolCallAt = 950;
    const row = await enqueueInput(input({ delivery: 'tool' }));
    expect(row).toMatchObject({ state: 'queued', transportIntent: 'browser', directTurn: { id: 'plain-turn' } });
    expect(row.delivery).toBeUndefined();
    expect(row.toolTurnId).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: row.id, directTurn: row.directTurn })]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-call', fixture.now)).toEqual([]);
  });

  it('keeps an explicit injection on a Pro turn in its tool result without browser fallback', async () => {
    binding.model = 'gpt-5.6-pro'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    binding.lastToolCallAt = 800;
    const row = await enqueueInput(input({ delivery: 'tool' }));
    expect(row).toMatchObject({ state: 'queued', delivery: 'tool', transportIntent: 'tool', toolTurnId: 'plain-turn' });
    expect(row.directTurn).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'native-page', binding.conversationId, true)).toBeNull();
    expect(await offerToolInput(sessionId, 'foreign-conversation', 'foreign-call', fixture.now)).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'first-exact-call', fixture.now)).toEqual([
      { text: row.text, images: [] }
    ]);
  });

  it('fails an explicit injection visibly when its exact turn ends without a tool', async () => {
    binding.model = 'gpt-5.6-pro'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const row = await enqueueInput(input({ delivery: 'tool' }));
    resetInputForTests();
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'plain-turn', time: 1001 };
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({
      state: 'failed',
      error: 'Not injected: the selected turn ended before an eligible tool call.'
    });
    binding.activeTurnId = 'next-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'next-turn', time: 1002 };
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-turn-call', fixture.now + 2)).toEqual([]);
  });

  it('does not leak a restarted explicit injection into a newer inactive turn', async () => {
    binding.model = 'gpt-5.6-pro'; binding.activeTurnId = 'original-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'original-turn', time: 900 };
    const row = await enqueueInput(input({ delivery: 'tool' }));
    resetInputForTests();
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'newer-turn', time: 1001 };
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'newer-call', fixture.now + 1)).toEqual([]);
  });

  it.each(['gpt-5-pro', 'gpt-5.6-pro', 'gpt-6-astra', 'gpt-6-pro'])('keeps %s on MCP injection before its first call', async model => {
    binding.model = model; binding.activeTurnId = 'pro-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'pro-turn', time: 900 };
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: true, directTurn: null });
    expect(await enqueueInput(input())).toMatchObject({ transportIntent: 'tool' });
    expect(await pendingBrowserInputs()).toEqual([]);
  });

  it.each(['pro', 'unknown'] as const)('does not interrupt %s turn ownership after the picker changes to Sol', async model => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'original-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'original-turn', time: 900 };
    expect(await sessionInputPolicy(sessionId, { exact: true, possible: true, model })).toMatchObject({ canInject: true, directTurn: null });
  });

  it('keeps an unsubmitted direct correction when its turn calls a tool', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const direct = await enqueueInput(input());
    await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
    binding.lastToolCallAt = 950;
    expect(await authorizeBrowserInput(direct.id, 'native-page', 'conversation-a')).toBe(true);
  });

  it.each(['turn', 'rebind', 'blocked'])('revokes an unsubmitted direct correction after %s changes', async change => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const direct = await enqueueInput(input());
    await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
    if (change === 'turn') { binding.activeTurnId = 'new-turn'; binding.end = { ...binding.end, turnId: 'new-turn', time: 1001 }; }
    if (change === 'rebind') binding.conversationId = 'conversation-b';
    if (change === 'blocked') binding.blocked = true;
    expect(await authorizeBrowserInput(direct.id, 'native-page', 'conversation-a')).toBe(false);
  });

  it('keeps direct delivery through the turn\'s running and finished MCP calls, and moves to the next turn', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const context: CallContext = { startedAt: 950, transportKey: null, agent: null, outcome: null,
      caller: { conversationId: binding.conversationId, requestId: 'first-call', transportKey: null }, evidence: emptyEvidence() };
    await trackInFlight(context, async () => {
      expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'plain-turn' } });
      binding.lastToolCallAt = 950;
    });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'plain-turn' } });
    binding.activeTurnId = 'next-turn'; binding.end = { ...binding.end, turnId: 'next-turn', time: 1001 };
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'next-turn' } });
    const after = await enqueueInput(input({ mode: 'after-turn' }));
    expect(after.directTurn).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-tool', fixture.now)).toEqual([]);
  });

  it('acknowledges prior tool delivery at call ingress without consuming the next queued stage', async () => {
    const previous = await enqueueInput(input({ text: 'Already delivered' }));
    await offerToolInput(sessionId, binding.conversationId, 'same-server-request', fixture.now);
    const nextStage = await enqueueInput(input({ text: 'Still queued', mode: 'finish' }));
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same-server-request', fixture.now);
    expect((await listInputs()).find(row => row.id === previous.id)?.state).toBe('tool');
    fixture.now += 1;
    await acknowledgeToolInput(sessionId, 'different-conversation', 'same-server-request', fixture.now);
    expect((await listInputs()).find(row => row.id === previous.id)?.state).toBe('tool');
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same-server-request', fixture.now);
    const rows = await listInputs();
    expect(rows.find(row => row.id === previous.id)).toMatchObject({ state: 'sent', messageId: `input:${previous.id}` });
    expect(rows.find(row => row.id === nextStage.id)?.state).toBe('queued');
    expect(await hasEligibleToolInput(sessionId)).toBe(false);
    expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
  });

  it.each([3, 5])('adds the configured %s-minute reminder once per delivery, preserving each authored message and staged boundary', async lead => {
    binding.leadMinutes = lead;
    const direct = await enqueueInput(input({ text: 'Check the new requirement' }));
    const stage = await enqueueInput(input({ text: 'Verify the next stage', mode: 'finish' }));
    const first = await offerToolInputBatch(sessionId, binding.conversationId, 'ordinary-tool', fixture.now, true);
    expect(first.messages).toEqual([{ text: direct.text, images: [] }]);
    expect(first.reminder).toContain(`about ${lead} minutes of final verification remain`);
    expect(first.reminder).toContain('only when the requested implementation is complete');
    expect(first.reminder).toContain('New instructions extend the work; they do not require another finish call');
    fixture.now += 1;
    const second = await offerToolInputBatch(sessionId, binding.conversationId, 'finish-tool', fixture.now, true);
    expect(second.messages).toEqual([{ text: stage.text, images: [] }]);
    expect(second.reminder).toContain(`about ${lead} minutes of final verification remain`);
    expect(second.reminder.match(/Use session_finish/g)).toHaveLength(1);
    const rows = await listInputs();
    expect(rows.find(row => row.id === direct.id)?.text).toBe('Check the new requirement');
    expect(rows.find(row => row.id === stage.id)?.text).toBe('Verify the next stage');
    expect(rows.find(row => row.id === stage.id)?.deliveryText).toBe('Verify the next stage');
  });
  it.each(['other-model', 'disabled', 'released', 'helper', 'worker'])('does not add an Astra finish reminder when %s', async condition => {
    if (condition === 'other-model') binding.model = 'gpt-5.6-sol';
    if (condition === 'disabled') binding.finishEnabled = false;
    if (condition === 'released') binding.finishReleased = true;
    if (condition === 'helper' || condition === 'worker') binding.origin = condition;
    await enqueueInput(input());
    const result = await offerToolInputBatch(sessionId, binding.conversationId, 'ordinary-tool', fixture.now, true);
    expect(result.messages).toHaveLength(1);
    expect(result.reminder).toBe('');
  });

  it('supersedes only the receiving session Goal and preserves another session queued Goal across restart', async () => {
    binding.goalEnabled = true;
    binding.activeTurnId = 'turn-one';
    const otherGoal = await enqueueInput(input({ text: 'Goal A' }), { turnId: 'turn-one', periodic: false, mode: 'goal' });
    const ownGoal = await enqueueInput(input({ sessionId: 'session-two', text: 'Goal B' }), { turnId: 'turn-one', periodic: false, mode: 'goal' });
    const ownInput = await enqueueInput(input({ sessionId: 'session-two', text: 'Correction for B' }));
    resetInputForTests();
    const rows = await listInputs();
    expect(rows.find(row => row.id === otherGoal.id)).toMatchObject({ state: 'queued', sessionId, conversationId: 'conversation-a' });
    expect(rows.find(row => row.id === ownGoal.id)?.state).toBe('cancelled');
    expect(rows.find(row => row.id === ownInput.id)).toMatchObject({ state: 'queued', sessionId: 'session-two', conversationId: 'conversation-b' });
    expect(await enqueueInput(input({ sessionId: 'session-two', text: 'Another direct instruction' }))).toMatchObject({ state: 'queued' });
  });
  it.each([[sessionId, 60000], ['session-two', 60000], ['session-two', 0]] as const)('does not let unrelated or future input in %s at +%s ms block a completed plan stage', async (scheduledSession, delay) => {
    const stage = await enqueueInput(input({ mode: 'finish', text: 'Next stage A', afterTurn: true }));
    await enqueueInput(input({ sessionId: scheduledSession, dueAt: fixture.now + delay, text: 'Later input' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-a', time: fixture.now + 1 };
    expect(await pendingBrowserInputs()).toContainEqual({ id: stage.id, conversationId: 'conversation-a' });
  });
  it('keeps due direct input ahead of the same session completed plan stage', async () => {
    const stage = await enqueueInput(input({ mode: 'finish' }));
    const direct = await enqueueInput(input({ text: 'Do this first' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-a', time: fixture.now + 1 };
    const pending = await pendingBrowserInputs();
    expect(pending.some(row => row.id === stage.id)).toBe(false);
    expect(pending.some(row => row.id === direct.id)).toBe(true);
  });

  it('delivers one manual input before staged work and preserves the next stage for a later poll', async () => {
    const stage = await enqueueInput(input({ text: 'Stage one', mode: 'finish' }));
    await enqueueInput(input({ text: 'Stage two', mode: 'finish' }));
    await enqueueInput(input({ text: 'Manual correction' }));
    expect((await offerToolInput(sessionId, binding.conversationId, 'poll', fixture.now, true))[0]?.text).toContain('Manual correction');
    fixture.now += 1;
    const next = await offerToolInput(sessionId, binding.conversationId, 'poll', fixture.now, true);
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe(stage.text);
    fixture.now += 1;
    const last = await offerToolInput(sessionId, binding.conversationId, 'poll', fixture.now, true);
    expect(last).toHaveLength(1);
    expect(last[0]?.text).toContain('Stage two');
  });
  it('keeps an automatic Goal for a call started after its enqueue', async () => {
    binding.goalEnabled = true;
    binding.activeTurnId = 'turn-one';
    await enqueueInput(input(), { turnId: 'turn-one', periodic: false, mode: 'goal' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'running-call', fixture.now, true)).toEqual([]);
    fixture.now += 1;
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-call', fixture.now, true)).toHaveLength(1);
  });

  it.each([false, true])('prioritizes new user input while preserving generated post-wire receipts: offered=%s', async offered => {
    binding.goalEnabled = true;
    binding.activeTurnId = 'turn-one'; binding.impulseMinutes = 3;
    const generated = await enqueueInput(input({ text: 'Generated instruction' }), { turnId: 'turn-one', periodic: false, mode: 'goal' });
    if (offered) fixture.now += 1;
    if (offered) await offerToolInput(sessionId, binding.conversationId, 'first-request', fixture.now);
    const user = await enqueueInput(input({ text: 'My newer instruction' }));
    const rows = await listInputs();
    expect(rows.find(row => row.id === generated.id)?.state).toBe(offered ? 'tool' : 'cancelled');
    expect(rows.find(row => row.id === user.id)?.state).toBe('queued');
    fixture.now += 100;
    const result = await offerToolInput(sessionId, binding.conversationId, 'next-request', fixture.now);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain('My newer instruction');
    expect(result[0]!.text).not.toContain('Generated instruction');
  });
  it.each(['queued', 'tool'] as const)('cancels persisted obsolete periodic %s rows even with the old setting enabled', async state => {
    binding.goalEnabled = true;
    binding.activeTurnId = 'turn-one'; binding.impulseMinutes = 3;
    const row: InputEntry = { ...input(), state, owner: state === 'tool' ? 'old-request' : null,
      createdAt: fixture.now, conversationId: binding.conversationId,
      ...(state === 'tool' ? { offeredAt: fixture.now } : {}), finishOwner: { turnId: 'turn-one', periodic: true } };
    await writeDurableNow('session-input', [row]); resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-request', fixture.now + 1, true)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input(), { turnId: 'turn-one', periodic: true })).rejects.toThrow('no longer belongs');
  });
  it.each(['end', 'next-turn', 'hold-off'] as const)('does not deliver a queued finish instruction after %s, including restart', async change => {
    binding.goalEnabled = true;
    binding.activeTurnId = 'turn-one';
    const row = await enqueueInput(input({ text: 'Check the remaining issue' }), { turnId: 'turn-one', periodic: false, mode: 'goal' });
    if (change === 'end') binding.finishReleased = true;
    if (change === 'next-turn') binding.activeTurnId = 'turn-two';
    if (change === 'hold-off') binding.finishEnabled = false;
    resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'new-request', fixture.now + 1)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
  });  it('delivers a generated finish instruction through the existing exact tool receipt once', async () => {
    binding.goalEnabled = true;
    binding.activeTurnId = 'turn-one';
    const row = await enqueueInput(input({ text: 'Finish the validation' }), { turnId: 'turn-one', periodic: false, mode: 'goal' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'first-request', fixture.now + 1, true)).toHaveLength(1);
    fixture.now += 100;
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-request', fixture.now, true)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
  });
  it('offers and claims an ordinary follow-up after the recorded turn already completed', async () => {
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-greeting', time: fixture.now };
    fixture.now += 69000;
    const row = await enqueueInput(input({ text: 'Read one file', dueAt: fixture.now }));
    // offeredAt is claim metadata, not proof that /status has published the offer.
    expect(row.offeredAt).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
    const claim = await claimBrowserInput(row.id, 'exact-browser-document', binding.conversationId, true);
    expect(claim).toMatchObject({ state: 'browser', owner: 'exact-browser-document', offeredAt: fixture.now });
  });

  it('persists reordered finish tasks and uses that order at the tool boundary', async () => {
    const a = await enqueueInput(input({ mode: 'finish', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'finish', text: 'B' }));
    expect(await reorderQueuedInputs(sessionId, [b.id, a.id])).toBe(true);
    resetInputForTests();
    expect((await listInputs()).map(row => row.text)).toEqual(['B', 'A']);
    await enqueueInput(input({ mode: 'finish', text: 'C' }));
    expect((await listInputs()).map(row => row.text)).toEqual(['B', 'A', 'C']);
    const delivered = await offerToolInput(sessionId, binding.conversationId, 'request', fixture.now, true);
    expect(delivered.map(row => row.text).join(' ')).toContain('B');
    expect(delivered.map(row => row.text).join(' ')).not.toContain('A');
    expect(await reorderQueuedInputs(sessionId, [a.id, b.id])).toBe(false);
  });
  it('rejects stale, duplicate and cross-session reorder snapshots without altering the queue', async () => {
    const a = await enqueueInput(input({ mode: 'finish', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'finish', text: 'B' }));
    expect(await reorderQueuedInputs(sessionId, [a.id])).toBe(false);
    expect(await reorderQueuedInputs(sessionId, [a.id, a.id])).toBe(false);
    expect(await reorderQueuedInputs('other-session', [b.id, a.id])).toBe(false);
    expect((await listInputs()).map(row => row.id)).toEqual([a.id, b.id]);
  });
  it('stamps only proven desktop-created chats and restores that origin from the retained receipt', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null);
    expect(noteChatOrigin).not.toHaveBeenCalled();
    await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-user');
    expect(openings.get(row.sessionId!)?.origin.kind).toBe('desktop');
    vi.mocked(noteChatOrigin).mockClear();
    resetInputForTests(); await listInputs();
    expect(openings.get(row.sessionId!)?.origin.kind).toBe('desktop');
    expect(noteChatOrigin).not.toHaveBeenCalled();
    vi.mocked(noteChatOrigin).mockClear();
    const existing = await enqueueInput(input());
    await claimBrowserInput(existing.id, 'existing', binding.conversationId);
    await acknowledgeBrowserInput(existing.id, 'existing', binding.conversationId, 'followup');
    expect(noteChatOrigin).not.toHaveBeenCalled();
  });
  it('retries preparation through existing offers but grants native Send only once to the current owner', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'lost-response-page', null, true);
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: null }]);
    expect(await claimBrowserInput(row.id, 'replacement-page', null, true)).toMatchObject({ id: row.id, owner: 'replacement-page' });
    expect(await authorizeBrowserInput(row.id, 'lost-response-page', null)).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'replacement-page', null)).toBe(true);
    expect(await authorizeBrowserInput(row.id, 'replacement-page', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'late-page', null, true)).toBeNull();
    fixture.now += 45000;
    // An authorized Send retains exact custody while native identity is still pending.
    expect((await listInputs())[0]).toMatchObject({ state: 'browser', owner: 'replacement-page' });
    expect(await claimBrowserInput(row.id, 'late-page', null, true)).toBeNull();
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
    expect(await acknowledgeBrowserInput(row.id, 'replacement-page', binding.conversationId, 'late-native')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: 'late-native' });
  });
  it('does not replay a retained transcript after a migrated opening owns its exact session', async () => {
    const row = await seedLegacyInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null);
    await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-user');
    vi.mocked(noteChatOrigin).mockClear();
    vi.mocked(listUsageSessions).mockResolvedValueOnce([{ id: sessionId, conversationId: binding.conversationId, origin: { kind: 'desktop' } }] as never);
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).not.toHaveBeenCalled();
    // A later catalog conflict cannot detach or replay the outbox's exact migrated owner.
    vi.mocked(listUsageSessions).mockResolvedValueOnce([{ id: sessionId, conversationId: binding.conversationId, origin: { kind: 'desktop' } }, { id: 'session-two', conversationId: binding.conversationId, origin: null }] as never);
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).not.toHaveBeenCalled();
  });
  it('expires pre-send preparation without images within one minute and revokes a late document', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null, true);
    fixture.now += 60000;
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('Not sent') });
    expect(await authorizeBrowserInput(row.id, 'page', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
  });
  it('keeps temporary planner text and answer out of durable storage and accepts an exact id-less receipt', async () => {
    const controller = new AbortController();
    const wake = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, wakeDecision: wake });
    const answer = requestBrowserDecision('PRIVATE PLANNER TASK', controller.signal, { lifetime: 'temporary-planner' });
    await vi.waitFor(async () => expect(await pendingBrowserInputs()).toHaveLength(1));
    const row = (await listInputs())[0]!;
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, lifetime: 'temporary-planner', conversationId: null }), controller.signal));
    expect(await claimBrowserInput(row.id, 'temporary-page', null)).toMatchObject({ text: 'PRIVATE PLANNER TASK', lifetime: 'temporary-planner' });
    expect(await acknowledgeBrowserInput(row.id, 'temporary-page', null)).toBe(true);
    expect(await completeBrowserDecision(row.id, 'wrong-page', 'PRIVATE RESPONSE', null)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'temporary-page', 'PRIVATE RESPONSE', null)).toBe(true);
    expect(await answer).toBe('PRIVATE RESPONSE');
    const durable = JSON.stringify(await readDurable('session-input'));
    expect(durable).not.toContain('PRIVATE');
    expect(durable).toContain('temporary-planner');
  });
  it('retains the opening Loop delivery preference across restart, Off and the exact send receipt', async () => {
    const entry = await enqueueInput(input({ sessionId: null, automation: 'loop', loopAfterTurn: true }));
    resetInputForTests();
    expect((await listInputs()).find(row => row.id === entry.id)?.loopAfterTurn).toBe(true);
    await claimBrowserInput(entry.id, 'browser-owner', null);
    await setInputAutomation(entry.id, 'off');
    await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId);
    expect(automate).toHaveBeenLastCalledWith(binding.conversationId, 'off', 'after-send', undefined, true);
    await setInputAutomation(entry.id, 'loop', false);
    expect(automate).toHaveBeenLastCalledWith(binding.conversationId, 'loop', 'after-send', undefined, false);
    resetInputForTests();
    expect((await listInputs()).find(row => row.id === entry.id)).toMatchObject({ automation: 'loop', loopAfterTurn: false });
    automate.mockClear();
    await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId);
    expect(automate).not.toHaveBeenCalled();
  });
  it('persists fresh-chat Off before ACK and applies Off after ACK without resending', async () => {
    const entry = await enqueueInput(input({ sessionId: null, automation: 'goal', objective: 'Keep objective' }));
    await claimBrowserInput(entry.id, 'browser-owner', null);
    expect(await setInputAutomation(entry.id, 'off')).toBe(true);
    expect(await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId)).toBe(true);
    expect(automate.mock.calls.map(call => call[1])).toEqual(['off']);
    expect((await listInputs()).find(row => row.id === entry.id)).toMatchObject({ state: 'sent', automation: 'off', objective: 'Keep objective' });
    await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId);
    expect(automate).toHaveBeenCalledTimes(1);
    const second = await enqueueInput(input({ sessionId: null, automation: 'goal' }));
    await claimBrowserInput(second.id, 'second-owner', null);
    await acknowledgeBrowserInput(second.id, 'second-owner', binding.conversationId);
    expect(await setInputAutomation(second.id, 'off')).toBe(true);
    expect(automate.mock.calls.at(-1)?.[1]).toBe('off');
    await acknowledgeBrowserInput(second.id, 'second-owner', binding.conversationId);
    expect(automate.mock.calls.at(-1)?.[1]).toBe('off');
  });
  it('migrates a legacy initial browser attempt while retaining an intentional after-turn wait', async () => {
    const stale = await seedLegacyInput(input({ sessionId: null }));
    const after = await seedLegacyInput(input({ mode: 'after-turn' }));
    fixture.now += 600001;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'fresh-end', time: fixture.now };
    expect(await pendingBrowserInputs()).toContainEqual({ id: after.id, conversationId: binding.conversationId });
    expect((await listInputs()).find(row => row.id === stale.id)).toMatchObject({ state: 'queued', opening: true, sessionId: stale.id });
    resetInputForTests();
    expect(await claimBrowserInput(stale.id, 'after-restart', null)).toMatchObject({ id: stale.id, state: 'browser' });
  });
  it('waits indefinitely for tool injection after restart', async () => {
    binding.activeTurnId = 'active';
    const row = await enqueueInput(input());
    binding.activeTurnId = null;
    fixture.now += 365 * 24 * 60 * 60 * 1000;
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued' });
    expect((await offerToolInput(sessionId, binding.conversationId, 'late-tool', fixture.now))[0]?.text).toContain(row.text);
  });
  it('lets the user cancel indefinitely queued input after restart', async () => {
    binding.activeTurnId = 'active';
    const row = await enqueueInput(input());
    fixture.now += 365 * 24 * 60 * 60 * 1000;
    resetInputForTests();
    expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-tool', fixture.now + 1)).toEqual([]);
  });
  it('admits independent chats while preserving same-session admission and exact UUID retry', async () => {
    const first = input({ sessionId: null });
    await enqueueInput(first);
    expect(await enqueueInput(first)).toMatchObject({ id: first.id });
    const second = await enqueueInput(input());
    await expect(enqueueInput(input())).rejects.toThrow('One message');
    expect(await cancelInput(first.id)).toBe(true);
    expect(await cancelInput(second.id)).toBe(true);
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
  });
  it.each(['tool', 'browser'] as const)('retains the %s delivery receipt when recording fails and never resends it', async (transport) => {
    const record = vi.fn(async () => { throw new Error('recorder unavailable'); return true; });
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const row = await enqueueInput(input());
    if (transport === 'tool') {
      expect(await offerToolInput(sessionId, binding.conversationId, 'same-request', 0)).toHaveLength(1);
      fixture.now++;
      expect(await offerToolInput(sessionId, binding.conversationId, 'same-request', fixture.now)).toEqual([]);
    } else {
      expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).not.toBeNull();
      expect(await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-message')).toBe(true);
    }
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: transport === 'tool' ? `input:${row.id}` : 'native-message' });
    expect((await listInputs())[0]?.historyRecorded).not.toBe(true);
    resetInputForTests(); // receipt persists across restart, unlike in-flight timing proof
    expect(await offerToolInput(sessionId, binding.conversationId, 'next', ++fixture.now)).toEqual([]);
    expect(await claimBrowserInput(row.id, 'another-page', binding.conversationId)).toBeNull();
    record.mockResolvedValue(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', historyRecorded: true });
    const calls = record.mock.calls.length;
    await listInputs();
    expect(record).toHaveBeenCalledTimes(calls);
  });
  it.each([false, true])('retains canonical commitment independently of optional image failure (committed=%s)', async committed => {
    const record = vi.fn(async (_entry: Readonly<InputEntry>, anchor: (seq: number) => void) => {
      if (committed) anchor(1);
      throw new Error(committed ? 'asset quota' : 'message write failed');
      return true;
    });
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const row = await enqueueInput(input());
    await claimBrowserInput(row.id, 'page', binding.conversationId);
    await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-message');
    const persisted = (await readDurable<InputEntry[]>('session-input'))![0]!;
    expect(persisted.historyAnchored === true).toBe(committed);
    expect(persisted.historyRecorded).not.toBe(true);
    resetInputForTests();
    const retained = (await listInputs())[0]!;
    expect(retained.historyAnchored === true).toBe(committed);
    expect(await claimBrowserInput(row.id, 'other-page', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'later', ++fixture.now)).toEqual([]);
    record.mockImplementation(async (_entry, anchor) => { anchor(1); return true; });
    expect((await listInputs())[0]).toMatchObject({ historyAnchored: true, historyRecorded: true, historySeq: 1 });
  });
});
