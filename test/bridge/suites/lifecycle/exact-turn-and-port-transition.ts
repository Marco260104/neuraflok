import { acceptGoalReplyNow, bridgePort, bridgeState, compactedSession, expect, flushDurable, getConfig, it, pair, pendingCommands, queueResume, readDurable, recordFinalForTest, redeem, request, resetGoalStateForTests, saveConfig, setSecret, sweepStaleSwarm, vi } from "../../test-context.js";

it('retires an already armed ordinary Goal repair when its conversation is now finish-only Astra', async () => {
  const previous = getConfig();
  vi.useFakeTimers();
  try {
    await saveConfig({ ...previous, ui: { ...previous.ui, finishTool: true }, goal: { ...previous.goal, enabled: true, mode: 'goal' } });
    await setSecret('openRouterApiKey', 'test-goal-key');
    await pair();
    const chat = 'a5555555-1111-4111-8111-000000000005';
    await request('POST', '/events', { body: { conversationId: chat, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', reasoningEffort: 'high', time: Date.now() },
      { kind: 'turn_start', turnId: 'legacy-goal-turn', time: Date.now() },
      { kind: 'turn_end', turnId: 'legacy-goal-turn', outcome: 'completed', time: Date.now() }
    ] } });
    const sessionId = (await request('GET', `/activity?conversationId=${chat}`)).body.sessionId;
    await recordFinalForTest(chat, 'legacy-goal-turn');
    await acceptGoalReplyNow({ conversationId: chat, sessionId, replyId: 'legacy-final', turnId: 'legacy-goal-turn', eventSeq: 100, blocked: false });
    await vi.advanceTimersByTimeAsync(120001);
    await sweepStaleSwarm(Date.now());
    expect((await request('GET', '/status')).body.repairs).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: chat, reason: 'goal' })]));
    const { observeSessionModel } = await import("../../../../backend/domains/sessions/history/store.js");
    await observeSessionModel(sessionId, chat, 'gpt-6-pro', Date.now(), 'pro');
    await sweepStaleSwarm(Date.now());
    expect(((await request('GET', '/status')).body.repairs ?? []).filter((r: any) => r.conversationId === chat)).toEqual([]);
    await vi.advanceTimersByTimeAsync(20 * 60000);
    await sweepStaleSwarm(Date.now());
    expect(((await request('GET', '/status')).body.repairs ?? []).filter((r: any) => r.conversationId === chat)).toEqual([]);
  } finally { resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); vi.useRealTimers(); }
});

it('preserves pending commands and durable ACK receipts across a port switch', async () => {
  await pair();
  const failed = await compactedSession('ea000001-1111-4222-8333-444444444444', 'Receipt retained');
  const failedCommand = queueResume(failed.sessionId, failed.token)!;
  await redeem(failedCommand.id, 'port-switch-client');
  const ackBody = { id: failedCommand.id, client: 'port-switch-client', status: 'failed', error: 'fixture tab closed' };
  const ack = await request('POST', '/commands/ack', { body: ackBody });
  expect(ack.status).toBe(200);
  const queued = await compactedSession('ea000002-1111-4222-8333-444444444444', 'Pending command retained');
  queueResume(queued.sessionId, queued.token);
  await flushDurable();
  const before = await readDurable('bridge-commands'); const pending = pendingCommands();
  expect((before as any).receipts.length).toBeGreaterThan(0);
  const ports = await import("../../../../backend/domains/browser/bridge-ports.js");
  const selection = vi.spyOn(ports, 'bridgePortSelection').mockReturnValue({ candidates: [0], overridden: false });
  try {
    const { updateConfig } = await import("../../../../backend/infrastructure/settings/config.js");
    const { publishBridgePortChange } = await import("../../../../backend/domains/browser/bridge.js");
    await updateConfig(config => ({ ...config, ui: { ...config.ui, browserBridgePort: 8767 } }), undefined, publishBridgePortChange);
    bridgeState.base = `http://127.0.0.1:${bridgePort()}`;
    expect(pendingCommands()).toEqual(pending);
    expect(await readDurable('bridge-commands')).toEqual(before);
    expect((await request('POST', '/commands/ack', { body: ackBody })).body).toEqual(ack.body);
  } finally { selection.mockRestore(); }
});
