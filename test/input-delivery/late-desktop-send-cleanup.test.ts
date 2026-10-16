import {
  createSession,
  defaultConfig,
  finishInstruction,
  input,
  message,
  post,
  randomUUID,
  saveConfig,
  writeDurableNow,
} from './context.js';
import { expect, it, vi } from 'vitest';

it.each(['auto', 'finish'] as const)('adds one short reminder to every later Astra %s browser send without changing authored text', async mode => {
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: 3 } });
  const conversationId = randomUUID();
  const chat = await createSession({ title: 'Later Astra delivery', conversationId });
  const t = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: t },
    { kind: 'turn_start', turnId: 'previous-astra', time: t },
    { kind: 'assistant_message', turnId: 'previous-astra', messageId: 'previous-astra-final', text: 'The previous request is complete.', state: 'final', final: true, time: t + 999 },
    { kind: 'turn_end', turnId: 'previous-astra', outcome: 'completed', time: t + 1000 }
  ] });
  const request = { ...message(chat.id, 'off'), mode, afterTurn: true } as Parameters<typeof input.enqueueInput>[0];
  await input.enqueueInput(request);
  const claimed = await input.claimBrowserInput(request.id, 'later-page', conversationId, true);
  expect(claimed!.text).toBe(request.text + '\n\n' + finishInstruction(3));
  expect(claimed?.text).not.toContain('The user just sent');
  input.resetInputForTests();
  const restored = (await input.listInputs()).find(row => row.id === request.id)!;
  expect(restored.text).toBe(request.text);
  expect(restored.deliveryText).toBe(claimed?.text);
  expect(restored.deliveryText?.split(finishInstruction(3))).toHaveLength(2);
  await input.cancelInput(request.id);
  await saveConfig(config);
});

it('retires a late-confirmed cancelled desktop send after two minutes even as the only managed chat', async () => {
  const conversationId = randomUUID();
  const row = await input.enqueueInput({ ...message(null, 'off'), mode: 'auto' });
  expect((await post('/input/claim', { id: row.id, owner: 'cancelled-send-document', conversationId: null })).status).toBe(200);
  await input.cancelInput(row.id);
  expect((await post('/input/ack', { id: row.id, owner: 'cancelled-send-document', conversationId })).status).toBe(200);
  expect((await input.listInputs()).find(item => item.id === row.id)).toMatchObject({ state: 'cancelled', conversationId, deliveredAt: expect.any(Number) });
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 119_000);
  try {
    const before = (await post('/status', { openConversations: [conversationId] })).body;
    expect(before.managedConversations).toContain(conversationId);
    expect(before.retiredConversations).not.toContain(conversationId);
    clock.mockReturnValue(now + 120_001);
    const after = (await post('/status', { openConversations: [conversationId] })).body;
    expect(after.retiredConversations).toContain(conversationId);
    expect(after.closableConversations).toContain(conversationId);
    const session = { id: row.sessionId! };
    const previous = (await input.listInputs()).find(item => item.id === row.id)!;
    await writeDurableNow('session-input', [previous, { ...previous, id: randomUUID(), sessionId: session.id,
      opening: undefined, state: 'sent', createdAt: now + 121_000, deliveredAt: now + 121_000, historyRecorded: true }]);
    input.resetInputForTests(); clock.mockReturnValue(now + 242_001);
    const resumed = (await post('/status', { openConversations: [conversationId] })).body;
    expect(resumed.retiredConversations).not.toContain(conversationId);
    expect(resumed.closableConversations).not.toContain(conversationId);
  } finally { clock.mockRestore(); }
});
