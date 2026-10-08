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
import { describe, expect, it } from 'vitest';
import {
  acknowledgeBrowserInput,
  cancelInput,
  claimBrowserInput,
  enqueueInput,
  listInputs,
  offerToolInput as offerToolInputBatch,
  acknowledgeToolInput,
  pendingBrowserInputs,
  resetInputForTests,
  configureInputDelivery,
  editQueuedInput,
  reorderQueuedInputs,
  authorizeBrowserInput,
  sessionInputPolicy,
} from '../../backend/domains/sessions/input/input.js';
import type { InputEntry } from '../../backend/domains/sessions/input/input.js';

describe('Astra delivery boundaries and stacked direct input', () => {
  it('maps active Astra after-turn to finish durably and preserves original retry identity', async () => {
    binding.activeTurnId = 'active-astra';
    const args = input({ mode: 'after-turn' });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ queueAtFinish: true, canInject: true, browserAllowed: false });
    expect(await enqueueInput(args)).toMatchObject({ mode: 'finish', requestedMode: 'after-turn' });
    binding.activeTurnId = null;
    resetInputForTests();
    expect(await enqueueInput(args)).toMatchObject({ mode: 'finish', requestedMode: 'after-turn' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'ordinary', fixture.now)).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'finish', fixture.now, true)).toHaveLength(1);
  });
  it.each(['disabled', 'worker', 'helper', 'non-astra'])('does not map after-turn for %s', async condition => {
    binding.activeTurnId = 'active';
    if (condition === 'disabled') binding.finishEnabled = false;
    if (condition === 'worker' || condition === 'helper') binding.origin = condition;
    if (condition === 'non-astra') binding.model = 'gpt-5.6-pro';
    expect((await sessionInputPolicy(sessionId)).queueAtFinish).toBe(false);
    expect((await enqueueInput(input({ mode: 'after-turn' }))).mode).toBe('after-turn');
  });
  it('rechecks newer bridge activity at the final browser authorization boundary', async () => {
    let active = false;
    configureInputDelivery({ applyAutomation: automate, changed, activity: () => ({ possible: active, exact: active }) });
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    active = true;
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ queueAtFinish: true, canInject: true, browserAllowed: false });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
    active = false;
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
  });
  it.each([null, { kind: 'turn_end', outcome: 'unknown', turnId: 'unknown', time: 1000 }])('delivers explicit input in an idle adopted Astra chat without manufacturing completion (%j)', async end => {
    binding.end = end;
    const checkpoint = await enqueueInput(input({ mode: 'after-turn', text: 'Automatic checkpoint' }));
    const row = await enqueueInput(input());
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ browserAllowed: true, settled: false });
    expect((await pendingBrowserInputs()).map(entry => entry.id)).toEqual([row.id]);
    resetInputForTests();
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
    expect(await claimBrowserInput(checkpoint.id, 'page', binding.conversationId)).toBeNull();
    expect((await listInputs()).find(entry => entry.id === checkpoint.id)?.state).toBe('queued');
  });
  it('retains non-Astra browser behavior with unknown terminal evidence', async () => {
    binding.model = 'gpt-5.6-sol'; binding.end = null;
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).not.toBeNull();
  });
  it('batches all direct instructions in order while leaving finish stages for a separate boundary', async () => {
    binding.activeTurnId = 'active';
    const stage = await enqueueInput(input({ mode: 'finish', text: 'Stage' }));
    const rows: InputEntry[] = [];
    for (let n = 0; n < 66; n++) rows.push(await enqueueInput(input({ text: `Instruction ${n}` })));
    const offered = await offerToolInputBatch(sessionId, binding.conversationId, 'poll', fixture.now, true);
    expect(offered.messages).toHaveLength(66);
    expect(offered.messages.map(row => row.text)).toEqual(rows.map(row => row.text));
    expect(JSON.stringify(offered).match(/Use session_finish/g)).toHaveLength(1);
    for (const row of rows) expect(JSON.stringify(offered)).not.toContain(row.id);
    expect((await listInputs()).find(row => row.id === stage.id)?.state).toBe('queued');
    expect(await offerToolInputBatch(sessionId, binding.conversationId, 'same', fixture.now, true)).toEqual(offered);
    fixture.now++;
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same', fixture.now);
    expect((await listInputs()).filter(row => row.state === 'sent')).toHaveLength(66);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same', fixture.now, true)).toHaveLength(1);
  });
  it('keeps the one pending normal browser send limit when no turn is active', async () => {
    await enqueueInput(input());
    await expect(enqueueInput(input())).rejects.toThrow('One message');
  });
  it('bounds a multibyte batch with one reminder and delivers the remaining input on the next invocation', async () => {
    binding.activeTurnId = 'active';
    const rows: InputEntry[] = [];
    for (let index = 0; index < 3; index++) rows.push(await enqueueInput(input({ text: `${index}:` + '界'.repeat(15998) })));
    const first = await offerToolInputBatch(sessionId, binding.conversationId, 'request', fixture.now);
    expect(first.messages.map(row => row.text)).toEqual(rows.slice(0, 2).map(row => row.text));
    const envelope = '\n--- New instructions from the user ---\n' + first.messages.map(row => row.text).join('\n\n') + '\n\n' + first.reminder;
    expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(128000);
    expect((await listInputs()).find(row => row.id === rows[2]!.id)?.state).toBe('queued');
    const second = await offerToolInputBatch(sessionId, binding.conversationId, 'request', ++fixture.now);
    expect(second.messages.map(row => row.text)).toEqual([rows[2]!.text]);
    expect(second.reminder).toBe(first.reminder);
    expect((await listInputs()).filter(row => row.state === 'sent')).toHaveLength(2);
  });
});

it('admits active direct injections independently across chats and preserves all of them', async () => {
  binding.activeTurnId = 'active';
  const a = await enqueueInput(input({ sessionId, text: 'A' }));
  const b = await enqueueInput(input({ sessionId: 'session-two', text: 'B' }));
  const again = await enqueueInput(input({ sessionId, text: 'A2' }));
  expect([a, b, again].every(row => row.transportIntent === 'tool')).toBe(true);
  fixture.now += 60001;
  binding.activeTurnId = null;
  resetInputForTests();
  expect((await listInputs()).filter(row => row.state === 'queued')).toHaveLength(3);
  expect(await offerToolInput(sessionId, 'conversation-a', 'tool-a', fixture.now)).toHaveLength(2);
  expect(await offerToolInput('session-two', 'conversation-b', 'tool-b', fixture.now)).toHaveLength(1);
});
it('keeps a migrated legacy initial browser attempt queued past its old startup deadline', async () => {
  const row = await seedLegacyInput(input({ sessionId: null, dueAt: fixture.now + 120000 }));
  fixture.now += 179999;
  resetInputForTests();
  expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
  fixture.now++;
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued', opening: true, sessionId: row.id });
  expect(await claimBrowserInput(row.id, 'late', null)).toMatchObject({ id: row.id, state: 'browser' });
});
it('never times out an intentional after-turn wait or a finish stage', async () => {
  binding.activeTurnId = 'active';
  binding.finishEnabled = false;
  const after = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
  const stage = await enqueueInput(input({ mode: 'finish' }));
  fixture.now += 86400000;
  resetInputForTests();
  expect((await listInputs()).filter(row => [after.id, stage.id].includes(row.id)).every(row => row.state === 'queued')).toBe(true);
});
it('allows one browser send alongside other-chat tool input but prevents same-chat competing browser sends', async () => {
  binding.activeTurnId = 'active';
  const tool = await enqueueInput(input());
  binding.activeTurnId = null;
  // No terminal proof for the previously active turn: the tool route is still held.
  binding.end = null;
  const browser = await enqueueInput(input({ sessionId: null }));
  expect(browser.transportIntent).toBe('browser');
  expect(await pendingBrowserInputs()).toEqual([{ id: browser.id, conversationId: null }]);
  const independent = await enqueueInput(input({ sessionId: null }));
  await cancelInput(independent.id);
  await cancelInput(browser.id);
  await expect(enqueueInput(input())).rejects.toThrow('One message');
  expect((await listInputs()).find(row => row.id === tool.id)?.state).toBe('queued');
});

it('recovers only an unoffered tool intent after the target is positively settled', async () => {
  binding.activeTurnId = 'old-active';
  const row = await enqueueInput(input());
  expect(row.transportIntent).toBe('tool');
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'old-active', time: fixture.now + 1 };
  const claimed = await claimBrowserInput(row.id, 'recovery-page', binding.conversationId, true);
  expect(claimed).toMatchObject({ state: 'browser', transportIntent: 'browser' });
  expect(await offerToolInput(sessionId, binding.conversationId, 'competing-tool', fixture.now + 2)).toEqual([]);
  expect(await authorizeBrowserInput(row.id, 'recovery-page', binding.conversationId)).toBe(true);
});

it('never redirects a tool input whose offer may already have reached the model', async () => {
  binding.activeTurnId = 'active-tool-turn';
  const row = await enqueueInput(input());
  expect(await offerToolInput(sessionId, binding.conversationId, 'offered-request', fixture.now)).toHaveLength(1);
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'active-tool-turn', time: fixture.now + 1 };
  expect(await claimBrowserInput(row.id, 'other-page', binding.conversationId, true)).toBeNull();
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'tool', offeredAt: fixture.now });
});

it('keeps Astra finish-only tasks off browser transport across restart and permits explicit per-task opt-in', async () => {
  const row = await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'astra-ended', time: fixture.now + 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).toBeNull();
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await editQueuedInput(row.id, row.text, true)).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
  expect(await editQueuedInput(row.id, row.text, false)).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await offerToolInput(sessionId, binding.conversationId, 'finish-only-test', fixture.now, true)).toHaveLength(1);
});
it('keeps a finish-only head ahead of opted-in browser tasks until explicitly reordered', async () => {
  const blocked = await enqueueInput(input({ mode: 'finish', text: 'Finish-only implementation' }));
  const after = await enqueueInput(input({ mode: 'finish', text: 'Inspect the current result', afterTurn: true }));
  const later = await enqueueInput(input({ mode: 'finish', text: 'Inspect again', afterTurn: true }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'astra-ended', time: fixture.now + 1 };
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(blocked.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(later.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(after.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await reorderQueuedInputs(sessionId, [after.id, blocked.id, later.id])).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([{ id: after.id, conversationId: binding.conversationId }]);
  expect(await claimBrowserInput(after.id, 'page', binding.conversationId, true)).not.toBeNull();
  expect(await authorizeBrowserInput(after.id, 'page', binding.conversationId)).toBe(true);
  expect(await acknowledgeBrowserInput(after.id, 'page', binding.conversationId, 'message-after')).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect((await listInputs()).find(row => row.id === blocked.id)?.state).toBe('queued');
});

