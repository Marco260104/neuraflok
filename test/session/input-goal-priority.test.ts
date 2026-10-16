import {
  fixture,
  binding,
  sessionId,
  input,
  offerToolInput,
} from './input-context.js';
import { describe, expect, it } from 'vitest';
import {
  fileSilenceInput,
  inputBeforeGoal,
  acknowledgeBrowserInput,
  cancelInput,
  claimBrowserInput,
  enqueueInput,
  listInputs,
  pendingBrowserInputs,
  resetInputForTests,
  hasEligibleToolInput,
  reorderQueuedInputs,
  authorizeBrowserInput,
} from '../../backend/domains/sessions/input/input.js';

describe('visible input priority before Goal', () => {
  it('keeps an ineligible future finish-only head ahead of Goal without affecting another session', async () => {
    const row = await enqueueInput(input({ mode: 'finish', dueAt: fixture.now + 60_000 }));
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await inputBeforeGoal(sessionId, 'previous-turn')).toBe('queued');
    expect(await inputBeforeGoal('session-two', 'previous-turn')).toBeNull();
    expect(await cancelInput(row.id)).toBe(true);
    expect(await inputBeforeGoal(sessionId, 'previous-turn')).toBeNull();
  });

  it.each(['browser', 'tool'] as const)('keeps unresolved %s custody ahead of Goal across input restore', async transport => {
    const row = await enqueueInput(input());
    if (transport === 'browser') expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    else expect(await offerToolInput(sessionId, binding.conversationId, 'offer', fixture.now)).toHaveLength(1);
    resetInputForTests();
    expect(await inputBeforeGoal(sessionId, 'previous-turn')).toBe('queued');
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe(transport);
  });

  it('keeps a consumed completion ahead of Goal after its last user card is sent and restored', async () => {
    const row = await enqueueInput(input({ mode: 'after-turn' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'source-final', time: fixture.now + 1 };
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    expect(await inputBeforeGoal(sessionId, 'source-final')).toBe('queued');
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'accepted-question')).toBe(true);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await inputBeforeGoal(sessionId, 'source-final')).toBe('consumed');
    expect(await inputBeforeGoal(sessionId, 'different-final')).toBeNull();
    expect(await inputBeforeGoal('session-two', 'source-final')).toBeNull();
  });

  it('does not let a tool-only finish checkpoint overtake an after-turn head', async () => {
    const head = await enqueueInput(input({ mode: 'after-turn', text: 'First via browser' }));
    await enqueueInput(input({ mode: 'finish', text: 'Later checkpoint' }));
    expect(await hasEligibleToolInput(sessionId, true)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'finish', fixture.now, true)).toEqual([]);
    expect((await listInputs()).every(row => row.state === 'queued')).toBe(true);
    expect(await cancelInput(head.id)).toBe(true);
    expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
    expect((await offerToolInput(sessionId, binding.conversationId, 'next-finish', fixture.now + 1, true))[0]?.text).toContain('Later checkpoint');
  });

  it('moves an unclaimed silence boundary to the newly elected visible head without resetting its wait', async () => {
    const a = await enqueueInput(input({ mode: 'after-turn', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'after-turn', text: 'B' }));
    binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-source', time: fixture.now, seq: 12 };
    const listenUntil = fixture.now + 300_000;
    expect(await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true, listenUntil)).toBe(true);
    expect(await reorderQueuedInputs(sessionId, [b.id, a.id])).toBe(true);
    resetInputForTests();
    const reordered = await listInputs();
    expect(reordered.find(row => row.id === a.id)?.silenceBoundary).toBeUndefined();
    expect(reordered.find(row => row.id === b.id)?.silenceBoundary).toMatchObject({ turnId: 'failed-source', listenUntil });
    expect(await pendingBrowserInputs()).toEqual([]);
    fixture.now = listenUntil;
    expect(await pendingBrowserInputs()).toEqual([{ id: b.id, conversationId: binding.conversationId, silenceTurnId: 'failed-source' }]);
    expect(await claimBrowserInput(a.id, 'page', binding.conversationId, true)).toBeNull();
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId, true)).not.toBeNull();
  });
});
it('rechecks Astra finish-only policy at final browser authorization after a model change', async () => {
  binding.model = 'gpt-5.6-pro';
  const row = await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'ordinary-ended', time: fixture.now + 1 };
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
  binding.model = 'gpt-6-astra';
  expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
});

it('delivers a legacy finish checkpoint after an ordinary turn without restoring its old Pro selection', async () => {
  const args = input({ mode: 'finish', model: '6', reasoningEffort: 'pro', text: 'Final checkpoint' });
  const row = await enqueueInput(args);
  resetInputForTests();
  binding.model = 'gpt-5.6-sol';
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'ordinary-completed', time: fixture.now + 1 };
  expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
  const claimed = await claimBrowserInput(row.id, 'page', binding.conversationId, true);
  expect(claimed).toMatchObject({ model: null, reasoningEffort: null, text: 'Final checkpoint' });
  expect(claimed?.deliveryText).not.toContain('session_finish');
  expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
  // Authored identity remains valid even though browser delivery inherits selection.
  expect(await enqueueInput(args)).toMatchObject({ id: row.id, model: '6', reasoningEffort: 'pro' });
  await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-checkpoint');
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
});

