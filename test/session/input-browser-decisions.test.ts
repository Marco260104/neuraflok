import {
  fixture,
  binding,
  automate,
  changed,
  sessionId,
  input,
  seedLegacyInput,
  offerToolInput,
} from './input-context.js';
import { describe, expect, it, vi } from 'vitest';
import { REASONING_EFFORTS } from '../../contracts/session.js';
import { promises as fs } from 'node:fs';
import { flushDurable, writeDurableNow } from '../../backend/persistence/durable.js';
import {
  fileSilenceInput,
  inputArgs,
  acknowledgeBrowserInput,
  cancelInput,
  claimBrowserInput,
  completeBrowserDecision,
  enqueueInput,
  failBrowserInput,
  listInputs,
  acknowledgeToolInput,
  pendingBrowserInputs,
  requestBrowserDecision,
  resetInputForTests,
  configureInputDelivery,
  authorizeBrowserHelperRetry,
  pausedBrowserHelpers,
  hasEligibleToolInput,
  editQueuedInput,
  authorizeBrowserInput,
  nextAfterTurnLocalInput,
} from '../../backend/domains/sessions/input/input.js';
import type { InputEntry } from '../../backend/domains/sessions/input/input.js';
import { trackInFlight, emptyEvidence } from '../../backend/infrastructure/tool-gateway/protocol/call-context.js';

describe('browser decision lifetime', () => {
  it('does not redeem a fresh scheduled marker before its due time', async () => {
    const entry = await enqueueInput(input({ sessionId: null, dueAt: fixture.now + 60000 }));
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(entry.id, 'fresh-marker-document', null)).toBeNull();
    fixture.now += 60000;
    expect(await pendingBrowserInputs()).toEqual([{ id: entry.id, conversationId: null }]);
    expect(await claimBrowserInput(entry.id, 'fresh-marker-document', null)).toMatchObject({ id: entry.id, state: 'browser' });
  });
  it('requires a deliberate exact-source retry and never revives the previous owner', async () => {
    const first = requestBrowserDecision('Choose', new AbortController().signal, { sourceSessionId: sessionId });
    const rejected = expect(first).rejects.toThrow('cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'old-document', null);
    // Only a person's cancellation of a claimed helper pauses it for a deliberate retry.
    expect(await cancelInput(row.id)).toBe(true); await rejected;
    expect(await pausedBrowserHelpers()).toEqual([{ id: row.id, sourceSessionId: sessionId }]);
    expect(await authorizeBrowserHelperRetry(row.id, 'wrong-source')).toBe(false);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(authorizeBrowserHelperRetry(row.id, sessionId)).rejects.toThrow('disk busy');
    await flushDurable();
    expect(await pausedBrowserHelpers()).toHaveLength(1);
    expect(await authorizeBrowserHelperRetry(row.id, sessionId)).toBe(true);
    expect(await authorizeBrowserHelperRetry(row.id, sessionId)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'old-document', 'late')).toBe(false);
    expect(await pausedBrowserHelpers()).toEqual([]);
    const second = requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId });
    const next = (await listInputs()).find(entry => entry.state === 'queued')!;
    expect(next.id).not.toBe(row.id);
    await claimBrowserInput(next.id, 'new-document', null);
    expect(await completeBrowserDecision(next.id, 'new-document', 'accepted', 'helper-new-chat')).toBe(true);
    await expect(second).resolves.toBe('accepted');
  });
  it('reuses the exact helper target and keeps source input out of its queue', async () => {
    binding.activeTurnId = 'source-still-running';
    const controller = new AbortController();
    const answer = requestBrowserDecision('New source response', controller.signal, {
      sourceSessionId: sessionId, lifetime: 'temporary-planner', provider: 'kimi', providerConversationId: 'km-helper-conversation'
    });
    const row = (await listInputs())[0]!;
    expect(row).toMatchObject({ sessionId: null, decisionSourceSessionId: sessionId, decisionProvider: 'kimi',
      decisionConversationId: 'km-helper-conversation', model: null, reasoningEffort: null });
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: null, lifetime: 'temporary-planner' }]);
    expect(await claimBrowserInput(row.id, 'wrong', binding.conversationId)).toBeNull();
    expect(await claimBrowserInput(row.id, 'helper', null)).not.toBeNull();
    expect(await completeBrowserDecision(row.id, 'wrong', 'reply')).toBe(false);
    expect(await completeBrowserDecision(row.id, 'helper', 'reply')).toBe(true);
    await expect(answer).resolves.toBe('reply');
  });
  it('blocks a duplicate helper while one runs, and after a person cancelled a claimed one', async () => {
    const answer = requestBrowserDecision('Choose', new AbortController().signal, { sourceSessionId: sessionId });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await expect(requestBrowserDecision('Again', new AbortController().signal, { sourceSessionId: sessionId })).rejects.toThrow('goal_browser_busy');
    await claimBrowserInput(row.id, 'document', null);
    expect(await cancelInput(row.id)).toBe(true);
    await rejected;
    await expect(requestBrowserDecision('Retry', new AbortController().signal, { sourceSessionId: sessionId })).rejects.toThrow('goal_browser_send_unconfirmed');
    expect(await listInputs()).toHaveLength(1);
  });
  it('starts the next helper on its own after the app cancelled a claimed one (user decision 2026-10-09)', async () => {
    // VM 2026-10-09: a new turn superseded a claimed Loop helper, and every later decision failed with "Helper delivery was not confirmed" until someone pressed "Start a new helper".
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    controller.abort();
    await rejected;
    expect(await pausedBrowserHelpers()).toEqual([]);
    const next = requestBrowserDecision('Retry', new AbortController().signal, { sourceSessionId: sessionId });
    const fresh = (await listInputs()).find(entry => entry.state === 'queued')!;
    expect(fresh.id).not.toBe(row.id);
    await claimBrowserInput(fresh.id, 'new-document', null);
    expect(await completeBrowserDecision(fresh.id, 'new-document', 'accepted', 'helper-new-chat')).toBe(true);
    await expect(next).resolves.toBe('accepted');
  });
  it('lets a source retry after a confirmed temporary helper send timed out', async () => {
    // 2026-10-02, live: a Temporary Chat helper confirmed its prompt, its answer was never taken, and the draft timed out. The retry was then refused as "could not confirm whether ChatGPT received the helper prompt" although it had been confirmed, and Goal stopped for good. Only a cancellation before any receipt is ambiguous enough to block a second helper.
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId, lifetime: 'temporary-planner' });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    expect(await claimBrowserInput(row.id, 'document', null)).not.toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'document', null, 'helper-user-message')).toBe(true);
    controller.abort();
    await rejected;
    const retry = requestBrowserDecision('Retry', new AbortController().signal, { sourceSessionId: sessionId, lifetime: 'temporary-planner' });
    void retry.catch(() => undefined);
    await vi.waitFor(async () => expect((await listInputs()).filter(entry => entry.state === 'queued')).toHaveLength(1));
  });

  it('accepts only its exact claimant answer, with idempotent send ACK', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    expect(await acknowledgeBrowserInput(row.id, 'document')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'document')).toBe(true);
    expect(await completeBrowserDecision(row.id, 'other', 'wrong')).toBe(false);
    expect(await completeBrowserDecision(row.id, 'document', 'accepted')).toBe(true);
    await expect(answer).resolves.toBe('accepted');
    expect(await completeBrowserDecision(row.id, 'document', 'accepted')).toBe(true);
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
  });
  it('rejects a late answer immediately after cancellation', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    controller.abort();
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
    await rejection;
    expect((await listInputs())[0]?.state).toBe('cancelled');
  });
  it('rejects a pre-send failure without waiting for timeout', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_send_failed: composer missing');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    await failBrowserInput(row.id, 'document', 'composer missing');
    await rejection;
    expect((await listInputs())[0]?.state).toBe('failed');
  });
  it('rejects cancellation that races a persisted answer', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      controller.abort();
      await realRename(from, to);
    });
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
    await rejection;
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', response: undefined });
  });
  it('handles cancellation during slow enqueue without leaking an unhandled rejection', async () => {
    const controller = new AbortController();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      controller.abort();
      await realRename(from, to);
    });
    await expect(requestBrowserDecision('Choose one', controller.signal)).rejects.toThrow();
    expect((await listInputs())[0]?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('cancels orphan decisions on restart before advertising them', async () => {
    const row: InputEntry = { ...input({ sessionId: null }), purpose: 'decision', state: 'queued', owner: null, createdAt: 1, conversationId: null };
    await writeDurableNow('session-input', [row]);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await listInputs())[0]?.state).toBe('cancelled');
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
  });
});

it('delivers one finish task per boundary, keeps normal inputs unblocked, and permits edits only before handout', async () => {
  const first = await enqueueInput(input({ mode: 'finish', text: 'Stage one' }));
  const second = await enqueueInput(input({ mode: 'finish', text: 'Stage two' }));
  expect(await editQueuedInput(second.id, 'Stage two revised')).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(first.id, 'browser', binding.conversationId)).toBeNull();
  expect(await offerToolInput(sessionId, binding.conversationId, 'ordinary', 0)).toEqual([]);
  expect(await hasEligibleToolInput(sessionId)).toBe(false);
  expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
  const one = await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  expect(one).toHaveLength(1); expect(one[0]?.text).toContain('Stage one');
  expect(await editQueuedInput(first.id, 'Too late')).toBe(false);
  expect(await offerToolInput(sessionId, binding.conversationId, 'overlap', 0, true)).toEqual(one);
  expect((await listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  const two = await offerToolInput(sessionId, binding.conversationId, 'next-finish', fixture.now + 1, true);
  expect(two).toHaveLength(1); expect(two[0]?.text).toContain('Stage two revised');
  expect((await listInputs()).find(row => row.id === first.id)?.state).toBe('sent');
});

it('a queued finish task does not prevent a normal browser message from being claimed', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  const ordinary = await enqueueInput(input());
  expect(await claimBrowserInput(ordinary.id, 'browser', binding.conversationId)).toMatchObject({ id: ordinary.id });
});

it.each(['other-turn', 'other-conversation', 'cancelled', 'legacy', 'new-turn'] as const)('does not borrow delayed completion for a queued input after %s', async change => {
  binding.model = 'gpt-5.6-sol';
  binding.activeTurnId = 'queued-source';
  binding.end = { kind: 'turn_start', outcome: '', turnId: 'queued-source', time: fixture.now - 10 };
  const row = await enqueueInput(input({ mode: 'after-turn' }));
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'queued-source', time: fixture.now - 1 };
  if (change === 'other-turn') binding.end.turnId = 'older-turn';
  if (change === 'other-conversation') binding.conversationId = 'conversation-b';
  if (change === 'cancelled') await cancelInput(row.id);
  if (change === 'new-turn') binding.activeTurnId = 'newer-turn';
  if (change === 'legacy') {
    const legacy = { ...row }; delete legacy.queuedTurn;
    await writeDurableNow('session-input', [legacy]);
  }
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).toBeNull();
});

it.each(['finish', 'after-turn'] as const)('sends only one queued %s after each exact completed turn, including across restart', async mode => {
  binding.model = 'gpt-5.6-sol';
  binding.finishEnabled = false;
  const first = await enqueueInput(input({ mode, text: 'Second stage' }));
  const second = await enqueueInput(input({ mode, text: 'Third stage' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-one', time: fixture.now + 1 };
  expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: binding.conversationId }]);
  await claimBrowserInput(first.id, 'page', binding.conversationId, true);
  await expect(enqueueInput(input())).rejects.toThrow('One message');
  await authorizeBrowserInput(first.id, 'page', binding.conversationId);
  expect(await pendingBrowserInputs()).toEqual([]);
  await acknowledgeBrowserInput(first.id, 'page', binding.conversationId, 'stage-user-one');
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(second.id, 'page', binding.conversationId, true)).toBeNull();
  binding.activeTurnId = 'turn-two';
  expect(await pendingBrowserInputs()).toEqual([]);
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-two', time: fixture.now + 2 };
  expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: binding.conversationId }]);
});

it('offers a local executor only the FIFO after-turn head at its exact completed boundary', async () => {
  binding.model = 'gpt-5.6-sol';
  binding.finishEnabled = false;
  binding.activeTurnId = 'local-turn';
  binding.end = { kind: 'turn_start', outcome: 'unknown', turnId: 'local-turn', time: fixture.now - 1 };
  const first = await enqueueInput(input({ mode: 'after-turn', text: 'First deferred message' }));
  fixture.now += 1;
  const second = await seedLegacyInput(input({ mode: 'after-turn', text: 'Second deferred message' }));
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'local-turn', time: fixture.now + 1 };

  expect(await nextAfterTurnLocalInput(sessionId, binding.conversationId, 'another-turn')).toBeNull();
  expect(await nextAfterTurnLocalInput(sessionId, binding.conversationId, 'local-turn')).toMatchObject({ id: first.id, text: first.text });
  expect((await listInputs()).find(row => row.id === second.id)?.state).toBe('queued');

  binding.end = { kind: 'turn_end', outcome: 'stopped', turnId: 'local-turn', time: fixture.now + 2 };
  expect(await nextAfterTurnLocalInput(sessionId, binding.conversationId, 'local-turn')).toBeNull();
});

it.each(['finish', 'after-turn'] as const)('does not advance %s on interruption, unknown outcome, error, or stale completion', async mode => {
  binding.model = 'gpt-5.6-sol';
  const row = await enqueueInput(input({ mode }));
  for (const outcome of ['interrupted', 'unknown', 'error', 'failed', 'stopped', 'stalled']) {
    binding.end = { kind: 'turn_end', outcome, turnId: 'turn-one', time: fixture.now + 1 };
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).toBeNull();
  }
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'old-turn', time: fixture.now - 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
});

it.each(['finish', 'after-turn'] as const)('spends a settled Thinking failed once for ten queued %s messages across restart', async mode => {
  const rows = [];
  for (let n = 0; n < 10; n++) rows.push(await enqueueInput(input({ mode, afterTurn: true, text: `Checkpoint ${n}` })));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: fixture.now + 1, seq: 12 };
  expect(await pendingBrowserInputs()).toEqual([]);
  await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true);
  expect(await pendingBrowserInputs()).toEqual([{ id: rows[0]!.id, conversationId: binding.conversationId, silenceTurnId: binding.end.turnId }]);
  expect(await claimBrowserInput(rows[1]!.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(rows[0]!.id, 'page', binding.conversationId, true)).not.toBeNull();
  expect(await authorizeBrowserInput(rows[0]!.id, 'page', binding.conversationId)).toBe(true);
  expect(await acknowledgeBrowserInput(rows[0]!.id, 'page', binding.conversationId, 'next-native-user')).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect((await listInputs()).filter(row => row.state === 'queued')).toHaveLength(9);
  binding.end = { ...binding.end, turnId: 'next-failed-pro-turn', time: fixture.now + 2 };
  await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true);
  expect(await pendingBrowserInputs()).toEqual([{ id: rows[1]!.id, conversationId: binding.conversationId, silenceTurnId: binding.end.turnId }]);
});

it.each(['late-tool', 'running-tool', 'new-turn', 'different-end', 'blocked'])('revokes a Thinking failed claim before Send after %s', async change => {
  const row = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: fixture.now + 1, seq: 12 };
  await fileSilenceInput(sessionId, binding.conversationId, binding.end.turnId, () => true);
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
  if (change === 'late-tool') binding.lastToolCallAt = fixture.now + 2;
  if (change === 'new-turn') binding.activeTurnId = 'resumed-turn';
  if (change === 'different-end') binding.end = { ...binding.end, turnId: 'other-turn' };
  if (change === 'blocked') binding.blocked = true;
  if (change === 'running-tool') {
    await trackInFlight({ startedAt: fixture.now + 2, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { requestId: 'resumed-work', conversationId: binding.conversationId, transportKey: null } }, async () => {
      expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
    });
  } else expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
});

it('keeps Astra finish-only tasks queued after Thinking failed without explicit after-turn opt-in', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: fixture.now + 1, seq: 12 };
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('does not drain another stage while a finish-tool receipt is outstanding', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  await enqueueInput(input({ mode: 'finish' }));
  await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-one', time: fixture.now + 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
});
it('preserves more than 100 finish tasks through restart without consuming the one direct slot', async () => {
  const ids = [];
  for (let index = 0; index < 110; index++) ids.push((await enqueueInput(input({ mode: 'finish', text: `Stage ${index}` }))).id);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish').map(row => row.id)).toEqual(ids);
  const direct = await enqueueInput(input());
  await expect(enqueueInput(input())).rejects.toThrow('One message');
  await cancelInput(direct.id);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish')).toHaveLength(110);
});

it('replays an unacknowledged finish task after restart without draining the next stage', async () => {
  const first = await enqueueInput(input({ mode: 'finish', text: 'First stage' }));
  const second = await enqueueInput(input({ mode: 'finish', text: 'Second stage' }));
  const original = await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  resetInputForTests();
  const replay = await offerToolInput(sessionId, binding.conversationId, 'restart', fixture.now + 10, true);
  expect(replay).toEqual(original);
  expect((await listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  expect(await editQueuedInput(first.id, 'Cannot change claimed text')).toBe(false);
});

it('keeps future finish tasks after the normal send expiry', async () => {
  const row = await enqueueInput(input({ mode: 'finish' }));
  fixture.now += 60 * 60000;
  expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
});

it('rejects an oversized full plan before admission instead of silently starving tool delivery', async () => {
  const args = input({ text: '界'.repeat(16000), objective: 'Complete task', stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) });
  await expect(enqueueInput(args)).rejects.toThrow('12,000');
  expect(await listInputs()).toEqual([]);
});
it('reports oversized legacy prepared tool input as failed without blocking later instructions', async () => {
  await seedLegacyInput(input({ text: '界'.repeat(16000), objective: 'Complete task', stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) }));
  const next = await seedLegacyInput(input({ text: 'A deliverable instruction' }));
  const offered = await offerToolInput(sessionId, binding.conversationId, 'request', fixture.now);
  expect(offered).toHaveLength(1);
  expect(offered[0]?.text).toContain(next.text);
  expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('delivery limit') });
});
it('accepts a full 16k original request and a workflow within the UI 12k limit', async () => {
  const row = await enqueueInput(input({ sessionId: null, objective: '界'.repeat(16000), text: '界'.repeat(5000), stages: ['界'.repeat(6900)] }));
  const claimed = await claimBrowserInput(row.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(row.objective);
  expect(Buffer.byteLength(claimed!.deliveryText!)).toBeLessThan(128000);
});
it('rejects an oversized restored plan before browser handout and leaves a visible failure', async () => {
  const row = await seedLegacyInput(input({ sessionId: null, text: '界'.repeat(16000), stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) }));
  await expect(claimBrowserInput(row.id, 'page', null, true)).rejects.toThrow('delivery limit');
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed', owner: null, error: expect.stringContaining('delivery limit') });
  expect(await pendingBrowserInputs()).toEqual([]);
});
it.each(['goal', 'loop'] as const)('delivers the complete saved %s objective even when its generated opening omits constraints', async automation => {
  configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text + '\nHarness reminder' });
  const first = await enqueueInput(input({ sessionId: null, automation, objective: 'Report numbered arithmetic replies. Use no tools, files or workers.', text: 'LOOP_CEDAR_1' }));
  const claimed = await claimBrowserInput(first.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(first.objective);
  expect(claimed?.deliveryText).toContain(first.text);
  expect(claimed?.deliveryText).toContain('Harness reminder');
  expect((await listInputs()).find(row => row.id === first.id)?.text).toBe(first.text);
  resetInputForTests();
  expect((await listInputs()).find(row => row.id === first.id)?.deliveryText).toBe(claimed?.deliveryText);
});
it('delivers the original objective and complete workflow in the first plan message', async () => {
  configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text + '\nHarness reminder' });
  const first = await enqueueInput(input({ sessionId: null, objective: 'Build the whole requested application with two subagents.', text: 'Implement all requirements; delegate immediately.', stages: ['Exercise the app with computer use and fix failures.', 'Independent code review and final acceptance.'] }));
  const claimed = await claimBrowserInput(first.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(first.objective);
  for (const stage of [first.text, ...first.stages!]) expect(claimed?.deliveryText).toContain(stage);
  expect(claimed?.deliveryText).toContain('Harness reminder');
  expect((await listInputs()).find(row => row.id === first.id)?.text).toBe(first.text);
  resetInputForTests();
  expect((await listInputs()).find(row => row.id === first.id)?.deliveryText).toBe(claimed?.deliveryText);
});
it('durably queues all finish-plan stages immediately and keeps manual deletion and edits independent', async () => {
  const args = input({ mode: 'finish', text: 'First checkpoint', stages: ['Delete this checkpoint', 'Last checkpoint'] });
  const first = await enqueueInput(args);
  expect(first.stagesApplied).toBe(true);
  const initial = await listInputs();
  expect(initial.map(row => row.text)).toEqual([args.text, ...args.stages!]);
  expect(initial.every(row => row.state === 'queued' && row.mode === 'finish')).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  resetInputForTests();
  await enqueueInput(args); // An admission retry must not duplicate the children.
  expect((await listInputs()).map(row => row.id)).toEqual(initial.map(row => row.id));
  await cancelInput(initial[1]!.id);
  await editQueuedInput(initial[2]!.id, 'Edited last checkpoint');
  const offered = await offerToolInput(sessionId, binding.conversationId, 'finish-first', fixture.now, true);
  expect(offered).toHaveLength(1);
  expect(offered[0]!.text).toBe('First checkpoint');
  fixture.now++;
  await acknowledgeToolInput(sessionId, binding.conversationId, 'next-request', fixture.now);
  resetInputForTests();
  const remaining = (await listInputs()).filter(row => row.state === 'queued');
  expect(remaining.map(row => row.text)).toEqual(['Edited last checkpoint']);
  expect((await listInputs()).filter(row => row.text === 'Delete this checkpoint')).toHaveLength(1);
});

it('materializes remaining plan stages once after exact delivery, across restart', async () => {
  const first = input({ sessionId: null, model: 'gpt-5.6-sol', reasoningEffort: 'high', stages: ['Implement remaining work', 'Verify acceptance'] });
  await enqueueInput(first);
  expect((await listInputs()).filter(row => row.mode === 'finish')).toHaveLength(0);
  await claimBrowserInput(first.id, 'plan-tab', null);
  await acknowledgeBrowserInput(first.id, 'plan-tab', binding.conversationId);
  resetInputForTests();
  const initial = (await listInputs()).filter(row => row.mode === 'finish');
  expect(initial.map(row => row.text)).toEqual(first.stages);
  expect(initial.every(row => row.sessionId === first.id)).toBe(true);
  expect(initial.every(row => row.model === null && row.reasoningEffort === null)).toBe(true);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish').map(row => row.id)).toEqual(initial.map(row => row.id));
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('publishes browser decision partials only to the current exact waiter without completing it', async () => {
  const { publishBrowserDecision } = await import('../../backend/domains/sessions/input/input.js');
  const abort = new AbortController(), publish = vi.fn();
  const answer = requestBrowserDecision('Exact helper question', abort.signal, { publish });
  await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
  const entry = (await listInputs())[0]!;
  const claimed = await claimBrowserInput(entry.id, 'helper-owner', null);
  expect(claimed).not.toBeNull();
  await acknowledgeBrowserInput(entry.id, 'helper-owner', 'helper-conversation');
  expect(await publishBrowserDecision(entry.id, 'wrong-owner', 'helper-conversation', 'partial')).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'other-conversation', 'partial')).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'x'.repeat(8001))).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'Actual partial')).toBe(true);
  expect(publish).toHaveBeenCalledExactlyOnceWith('Actual partial');
  abort.abort(); await expect(answer).rejects.toThrow('goal_browser_cancelled');
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'late')).toBe(false);
});


it.each(REASONING_EFFORTS)('preserves canonical effort %s through validation and durable browser pickup', async reasoningEffort => {
  const args = inputArgs.parse(input({ model: 'observed-model', reasoningEffort }));
  const entry = await enqueueInput(args);
  await flushDurable();
  resetInputForTests();
  expect(await claimBrowserInput(entry.id, 'page', binding.conversationId)).toMatchObject({ model: 'observed-model', reasoningEffort });
});

it.each(['default', 'instant', 'High', 'invented', 1, {}])('rejects noncanonical wire effort %j', reasoningEffort => {
  expect(inputArgs.safeParse({ ...input(), reasoningEffort }).success).toBe(false);
});


it('binds decision helper provenance from exact ACK and restores it from the durable receipt', async () => {
  const bindHelper = vi.fn(async () => undefined);
  configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  const controller = new AbortController();
  const answer = requestBrowserDecision('Plan this', controller.signal, { sourceSessionId: sessionId });
  await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
  const [row] = await listInputs();
  await claimBrowserInput(row!.id, 'helper-page', null);
  expect(await acknowledgeBrowserInput(row!.id, 'helper-page', 'exact-helper-chat')).toBe(true);
  expect(bindHelper).toHaveBeenCalledWith('exact-helper-chat', sessionId);
  controller.abort(); await expect(answer).rejects.toThrow('goal_browser_cancelled');
  await flushDurable(); resetInputForTests();
  bindHelper.mockClear(); configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  await listInputs();
  expect(bindHelper).toHaveBeenCalledWith('exact-helper-chat', sessionId);
});

