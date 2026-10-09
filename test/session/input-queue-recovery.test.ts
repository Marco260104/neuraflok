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
import { promises as fs } from 'node:fs';
import { flushDurable, readDurable, writeDurableNow } from '../../backend/persistence/durable.js';
import {
  inputArgs,
  acknowledgeBrowserInput,
  cancelInput,
  claimBrowserInput,
  enqueueInput,
  failBrowserInput,
  listInputs,
  acknowledgeToolInput,
  pendingBrowserInputs,
  resetInputForTests,
  configureInputDelivery,
  hasEligibleToolInput,
  authorizeBrowserInput,
} from '../../backend/domains/sessions/input/input.js';
import type { InputEntry } from '../../backend/domains/sessions/input/input.js';

describe('durable input receipts and queue recovery', () => {
  it('anchors both companion receipts through their one combined canonical message', async () => {
    const root: InputEntry = { ...input(), state: 'sent', owner: 'page', createdAt: fixture.now, deliveredAt: fixture.now,
      conversationId: binding.conversationId, messageId: 'shared-native' };
    const companion: InputEntry = { ...root, id: '20000000-0000-4000-8000-000000000002', text: 'Companion' };
    root.companionInputId = companion.id;
    await writeDurableNow('session-input', [root, companion]);
    resetInputForTests();
    const record = vi.fn(async (entry: Readonly<InputEntry>, anchor: (seq: number) => void) => {
      expect(entry.id).toBe(root.id);
      expect(entry.text).toContain('Companion');
      anchor(1);
      throw new Error('optional asset failed');
      return true;
    });
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const rows = await listInputs();
    expect(record).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ historyAnchored: true, historySeq: 1 });
    for (const row of (await readDurable<InputEntry[]>('session-input'))!) expect(row.historyRecorded).not.toBe(true);
  });
  it('reprojects a wrapped recorded receipt after restart without reopening delivery', async () => {
    const record = vi.fn(async (_entry: InputEntry) => true);
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const args = input({ text: 'hello' });
    const receipt: InputEntry = { ...args, state: 'sent', owner: null, createdAt: fixture.now,
      conversationId: binding.conversationId, deliveryText: 'hello\n\nInternal instructions',
      deliveredAt: fixture.now, messageId: 'native-message', historyRecorded: true };
    await writeDurableNow('session-input', [receipt]);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', historyRecorded: true });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ text: 'hello', deliveryText: receipt.deliveryText, messageId: 'native-message' });
    expect(await claimBrowserInput(receipt.id, 'another-page', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next', ++fixture.now)).toEqual([]);
    await listInputs();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('legacy queue: offers images in the held turn, bounds each offer to ten, and preserves the receipt boundary', async () => {
    binding.activeTurnId = 'held-turn';
    const images = Array.from({ length: 10 }, (_, index) => ({ name: `${index}.webp`, dataUrl: 'data:image/webp;base64,YQ==' }));
    expect(inputArgs.safeParse(input({ images: [...images, images[0]!] })).success).toBe(false);
    const first = await seedLegacyInput(input({ images }));
    await seedLegacyInput(input({ images: images.slice(0, 1) }));
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect(await claimBrowserInput(first.id, 'page', binding.conversationId)).toBeNull();
    const offered = await offerToolInput(sessionId, binding.conversationId, 'turn-id', 0);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.images).toEqual(images);
    expect(await offerToolInput(sessionId, binding.conversationId, 'turn-id', 0)).toEqual(offered);
    fixture.now += 1;
    const next = await offerToolInput(sessionId, binding.conversationId, 'turn-id', fixture.now);
    expect(next).toHaveLength(1);
    expect(next[0]?.images).toHaveLength(1);
    expect((await listInputs()).find(row => row.id === first.id)?.state).toBe('sent');
  });
  it('retains the image byte budget when ten individually bounded images exceed it', async () => {
    binding.activeTurnId = 'held-turn';
    const images = Array.from({ length: 10 }, (_, index) => ({ name: `${index}.webp`, dataUrl: 'data:image/webp;base64,' + 'A'.repeat(512000) }));
    expect(inputArgs.safeParse(input({ images })).success).toBe(true);
    await expect(enqueueInput(input({ images, delivery: 'tool' }))).rejects.toThrow('The image queue is full');
    expect(await listInputs()).toEqual([]);
  });
  it('keeps input in tool delivery during a proven active turn even when the browser looks idle', async () => {
    binding.activeTurnId = 'real-turn';
    const row = await enqueueInput(input());
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'idle-looking-document', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-tool', 0)).toHaveLength(1);
    await offerToolInput(sessionId, binding.conversationId, 'ack-tool', fixture.now + 1);
    const after = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
    expect(await claimBrowserInput(after.id, 'idle-looking-document', binding.conversationId)).toBeNull();
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'real-turn', time: fixture.now + 1 };
    await offerToolInput(sessionId, binding.conversationId, 'ack', fixture.now + 1);
    expect((await pendingBrowserInputs()).some(entry => entry.id === after.id)).toBe(true);
  });
  it('applies scheduled automation only at handout and never replays it on ACK', async () => {
    const row = await enqueueInput(input({ automation: 'loop', dueAt: 2000 }));
    expect(automate).not.toHaveBeenCalled();
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'early', 0)).toEqual([]);
    expect(automate).not.toHaveBeenCalled();
    fixture.now = 2000;
    await claimBrowserInput(row.id, 'owner', binding.conversationId);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'loop', 'before-send', undefined, undefined);
    await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId);
    await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId);
    expect(automate).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalled();
  });
  it('applies tool input automation before disclosure and never repeats on overlapping offers', async () => {
    await enqueueInput(input({ automation: 'off' }));
    expect(await offerToolInput(sessionId, binding.conversationId, 'first', 0)).toHaveLength(1);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'off', 'before-send', undefined, undefined);
    expect(await offerToolInput(sessionId, binding.conversationId, 'overlapping', 0)).toHaveLength(1);
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('does not retry an interrupted automation attempt after restart or late ACK', async () => {
    const row = await enqueueInput(input({ automation: 'goal' }));
    automate.mockRejectedValueOnce(new Error('settings persistence failed'));
    await expect(claimBrowserInput(row.id, 'owner', binding.conversationId)).rejects.toThrow('settings persistence failed');
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('not sent') });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later', 2001)).toEqual([]);
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('keeps a spent automation attempt inert if the final delivery commit fails', async () => {
    const row = await enqueueInput(input({ automation: 'goal' }));
    automate.mockImplementationOnce(async () => {
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('final commit failed'));
    });
    await expect(claimBrowserInput(row.id, 'owner', binding.conversationId)).rejects.toThrow('final commit failed');
    await flushDurable();
    resetInputForTests();
    expect((await listInputs())[0]?.state).toBe('failed');
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('binds a fresh send to its exact conversation and recording without changing authored identity', async () => {
    const args = input({ sessionId: null, automation: 'goal', objective: 'Build the requested project and test it' });
    const row = await enqueueInput(args);
    expect(await claimBrowserInput(row.id, 'owner', null)).toMatchObject({ automation: 'goal' });
    expect(await acknowledgeBrowserInput(row.id, 'owner')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'other', binding.conversationId)).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'goal', 'after-send', 'Build the requested project and test it', undefined);
    expect((await listInputs())[0]).toMatchObject({ sessionId: row.sessionId, deliveredSessionId: row.sessionId, conversationId: binding.conversationId, state: 'sent' });
    expect(await enqueueInput(args)).toMatchObject({ state: 'sent', automation: 'goal' });
    expect(await acknowledgeBrowserInput(row.id, 'owner', 'conversation-other')).toBe(false);
    expect(automate).toHaveBeenCalledTimes(1);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ deliveredSessionId: row.sessionId, objective: 'Build the requested project and test it' });
  });
  it('retains its reserved session when a new send ACK precedes recorder creation', async () => {
    binding.recorded = false;
    const row = await enqueueInput(input({ sessionId: null, automation: 'loop' }));
    await claimBrowserInput(row.id, 'owner', null);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect((await listInputs())[0]?.deliveredSessionId).toBe(row.sessionId);
    binding.recorded = true;
  binding.activeTurnId = null;
    expect((await listInputs())[0]?.deliveredSessionId).toBe(row.sessionId);
    binding.conversationId = 'conversation-resumed';
    expect((await listInputs())[0]?.deliveredSessionId).toBe(row.sessionId);
  });
  it('deduplicates exact ids, rejects changed input, and returns detached rows', async () => {
    const args = input();
    const row = await enqueueInput(args);
    row.text = 'mutated';
    expect((await enqueueInput(args)).text).toBe(args.text);
    await expect(enqueueInput({ ...args, text: 'changed' })).rejects.toThrow('different input');
    expect(await listInputs()).toHaveLength(1);
  });
  it('uses the durable session current binding after resume and refuses retired callers', async () => {
    const row = await enqueueInput(input());
    binding.conversationId = 'conversation-b';
    expect(await offerToolInput(sessionId, 'conversation-a', 'old', 0)).toEqual([]);
    expect(await claimBrowserInput(row.id, 'page-a', 'conversation-a')).toBeNull();
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: 'conversation-b', supersededConversationId: 'conversation-a' }]);
    expect(await claimBrowserInput(row.id, 'page-b', 'conversation-b')).toMatchObject({ state: 'browser' });
  });
  it('legacy queue: elects one browser owner and excludes tools for that session', async () => {
    const row = await seedLegacyInput(input());
    const claims = await Promise.all(['one', 'two'].map(owner => claimBrowserInput(row.id, owner, binding.conversationId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await seedLegacyInput(input());
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', 0)).toEqual([]);
    expect(await acknowledgeBrowserInput(row.id, 'two')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'one')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'one')).toBe(true);
  });
  it('legacy queue: allows independent new-chat inputs to claim separately', async () => {
    const a = await seedLegacyInput(input({ sessionId: null }));
    const b = await seedLegacyInput(input({ sessionId: null }));
    expect(await claimBrowserInput(a.id, 'a', null)).not.toBeNull();
    expect(await claimBrowserInput(b.id, 'b', null)).not.toBeNull();
  });
  it('legacy queue: preserves insertion order for messages sharing the same scheduled millisecond', async () => {
    const a = await seedLegacyInput(input());
    const b = await seedLegacyInput(input());
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId)).toBeNull();
    expect(await claimBrowserInput(a.id, 'page', binding.conversationId)).not.toBeNull();
    await acknowledgeBrowserInput(a.id, 'page');
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId)).not.toBeNull();
  });
  it('does not acknowledge a message from an overlapping request, including slow commit', async () => {
    const row = await enqueueInput(input());
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      fixture.now = 2000;
      await realRename(from, to);
    });
    expect(await offerToolInput(sessionId, binding.conversationId, 'first', 500)).toHaveLength(1);
    expect(await offerToolInput(sessionId, binding.conversationId, 'parallel', 1500)).toHaveLength(1);
    expect((await listInputs())[0]?.state).toBe('tool');
    expect(await claimBrowserInput(row.id, 'browser', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'later', 2001)).toEqual([]);
    expect((await listInputs())[0]?.state).toBe('sent');
  });
  it('legacy queue: acknowledges a later invocation with the same server-turn request id and unblocks after-turn input', async () => {
    const row = await seedLegacyInput(input());
    const after = await seedLegacyInput(input({ mode: 'after-turn' }));
    const first = await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', 500);
    expect(first[0]?.text).toBe(row.text);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', 500)).toEqual(first);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', fixture.now)).toEqual(first);
    fixture.now += 1;
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', fixture.now)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'fresh-end', time: fixture.now };
    expect(await claimBrowserInput(after.id, 'after-turn-page', binding.conversationId)).toMatchObject({ id: after.id });
  });
  it('reoffers the same input after restart, retaining its internal id rather than treating old timestamps as receipt', async () => {
    const row = await enqueueInput(input());
    await offerToolInput(sessionId, binding.conversationId, 'first', 0);
    resetInputForTests();
    fixture.now = 5000;
    expect((await offerToolInput(sessionId, binding.conversationId, 'after-restart', 4000))[0]?.text).toBe(row.text);
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'tool' });
  });
  it('honors due times without letting an after-turn wait block immediate tool input', async () => {
    const later = await seedLegacyInput(input({ dueAt: 2000 }));
    const after = await seedLegacyInput(input({ mode: 'after-turn', dueAt: 500 }));
    const auto = await seedLegacyInput(input({ dueAt: 600 }));
    expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([auto.id]);
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect((await offerToolInput(sessionId, binding.conversationId, 'request', 0)).map(row => row.text)).toEqual([auto.text]);
    expect(await pendingBrowserInputs()).not.toContainEqual({ id: after.id, conversationId: binding.conversationId });
    expect(await claimBrowserInput(later.id, 'page', binding.conversationId)).toBeNull();
    expect((await listInputs()).find(row => row.id === after.id)?.state).toBe('queued');
    expect((await listInputs()).find(row => row.id === later.id)?.state).toBe('queued');
  });
  it('injects explicit tool messages behind an after-turn task and retains that task across restart', async () => {
    binding.model = 'gpt-5-6-pro'; binding.activeTurnId = 'active-pro-turn';
    const after = await enqueueInput(input({ mode: 'after-turn', text: 'After the answer' }));
    const first = await enqueueInput(input({ mode: 'auto', text: 'Immediate first' }));
    const second = await enqueueInput(input({ mode: 'auto', text: 'Immediate second' }));
    expect(first.transportIntent).toBe('tool'); expect(second.transportIntent).toBe('tool');
    resetInputForTests();
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect(await offerToolInput(sessionId, 'wrong-conversation', 'request', fixture.now)).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', fixture.now)).toEqual([
      { text: first.text, images: [] }, { text: second.text, images: [] }
    ]);
    fixture.now += 1;
    await acknowledgeToolInput(sessionId, binding.conversationId, 'request', fixture.now);
    expect(await hasEligibleToolInput(sessionId)).toBe(false);
    expect((await listInputs()).map(row => ({ id: row.id, state: row.state }))).toEqual([
      { id: after.id, state: 'queued' }, { id: first.id, state: 'sent' }, { id: second.id, state: 'sent' }
    ]);
  });
  it('keeps claimed browser input inert across restart and bounds failure text', async () => {
    const row = await enqueueInput(input());
    await claimBrowserInput(row.id, 'owner', binding.conversationId);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await failBrowserInput(row.id, 'other', 'failure')).toBe(false);
    expect(await failBrowserInput(row.id, 'owner', 'x'.repeat(500))).toBe(true);
    expect((await listInputs())[0]?.error).toHaveLength(200);
  });
  it('legacy queue: releases all three orphan browser claims on explicit cancellation without replay after restart', async () => {
    const rows = [];
    for (let index = 0; index < 3; index++) {
      const row = await seedLegacyInput(input({ sessionId: null }));
      await claimBrowserInput(row.id, `old-page-${index}`, null);
      rows.push(row);
    }
    resetInputForTests();
    const independent = await enqueueInput(input({ sessionId: null }));
    await cancelInput(independent.id);
    for (const row of rows) expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input({ sessionId: null }))).resolves.toMatchObject({ state: 'queued' });
  });
  it('reports confirmed non-delivery when cancelled before the browser receives Send authority', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'owner', null, true);
    expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('Not sent:') });
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input({ sessionId: null }))).resolves.toMatchObject({ state: 'queued' });
  });
  it('cancels an ambiguous browser claim across restart and retains a late receipt without automation or stages', async () => {
    const row = await enqueueInput(input({ sessionId: null, automation: 'goal', stages: ['Later task'] }));
    await claimBrowserInput(row.id, 'owner', null);
    expect(await authorizeBrowserInput(row.id, 'other', null)).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'owner', 'wrong-conversation')).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
    resetInputForTests();
    expect(await cancelInput(row.id)).toBe(true);
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'owner', null)).toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'other', binding.conversationId, 'native-id')).toBe(false);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('may already') });
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'native-id')).toBe(true);
    expect(automate).not.toHaveBeenCalled();
    resetInputForTests();
    const rows = await listInputs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'cancelled', messageId: 'native-id', error: expect.stringContaining('later confirmed') });
    expect(await enqueueInput(input({ ...row, sessionId: null }))).toMatchObject({ state: 'cancelled' });
    // Explicit notice dismissal is idempotent and cannot erase a late receipt.
    expect(await cancelInput(row.id)).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', messageId: 'native-id', error: expect.stringContaining('later confirmed') });
  });
  it('does not publish a rejected enqueue through a background durable retry', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(enqueueInput(input())).rejects.toThrow('disk busy');
    await flushDurable();
    expect(await readDurable('session-input')).toEqual([]);
    expect(await listInputs()).toEqual([]);
  });
  it('does not disclose input when durable claim fails and leaves it claimable', async () => {
    const row = await enqueueInput(input());
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(claimBrowserInput(row.id, 'first', binding.conversationId)).rejects.toThrow('disk busy');
    await flushDurable();
    resetInputForTests();
    expect(await claimBrowserInput(row.id, 'second', binding.conversationId)).toMatchObject({ owner: 'second' });
  });
  it('legacy queue: refuses blocked or unidentified callers and caps aggregate tool output', async () => {
    configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text.repeat(2) });
    for (let i = 0; i < 3; i++) await seedLegacyInput(input({ text: 'é'.repeat(16000) }));
    await expect(enqueueInput(input())).rejects.toThrow('One message');
    expect(await offerToolInput(null, binding.conversationId, 'request', 0)).toEqual([]);
    binding.blocked = true;
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', 0)).toEqual([]);
    binding.blocked = false;
    const result = await offerToolInput(sessionId, binding.conversationId, 'request', 0);
    expect(result.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.map(row => row.text).join(''))).toBeLessThanOrEqual(128000);
    expect((await listInputs()).some(row => row.state === 'queued')).toBe(true);
  });
});
