import {
  appendEvent,
  createSession,
  decision,
  defaultConfig,
  goal,
  observeSessionModel,
  readRecentEvents,
  recordLoopMcpProof,
  saveConfig,
  settled,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('preserves the Astra delivery preference across Goal/Loop, restart and finish-setting changes', async () => {
  const config = (await import('../../backend/infrastructure/settings/config.js')).getConfig();
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true } });
  const id = 'pro-loop-delivery-test';
  const session = await createSession({ conversationId: id });
  await observeSessionModel(session.id, id, 'gpt-6-pro', Date.now(), 'pro');
  await goal.setGoalSwitchNow(id, 'loop', true);
  expect(await goal.astraFinishOnly(session.id, id)).toBe(true);
  await goal.setGoalSwitchNow(id, 'loop', true, true);
  expect(await goal.astraFinishOnly(session.id, id)).toBe(false);
  const saved = goal.snapshotGoalSwitches();
  goal.restoreGoalSwitches(saved);
  expect(goal.loopAfterTurnFor(id)).toBe(true);
  await goal.setGoalSwitchNow(id, 'loop', false);
  expect(goal.loopAfterTurnFor(id)).toBe(false);
  await goal.setGoalSwitchNow(id, 'loop', true);
  expect(goal.loopAfterTurnFor(id)).toBe(true);
  await goal.setGoalSwitchNow(id, 'goal', true);
  expect(await goal.astraFinishOnly(session.id, id)).toBe(false);
  await goal.setGoalSwitchNow(id, 'goal', true, false);
  expect(await goal.astraFinishOnly(session.id, id)).toBe(true);
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: false } });
  expect(await goal.astraFinishOnly(session.id, id)).toBe(false);
  expect(goal.loopAfterTurnFor(id)).toBe(true);
  expect(goal.goalSwitchFor(id).afterTurn).toBe(false);
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true } });
  expect(await goal.astraFinishOnly(session.id, id)).toBe(true);
});

it('keeps a withdrawn synthetic reply revoked when the deletion write fails and Goal is re-armed', async () => {
  const conversationId = 'deletion-failure-pro';
  const session = await createSession({ conversationId, title: 'Synthetic revocation' });
  await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'silence:old', turnId: 'g-silence-old', eventSeq: 1, blocked: false });
  goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'g-silence-old', deferStart: true });
  const durable = await import('../../backend/persistence/durable.js');
  const write = durable.writeDurableNow;
  const spy = vi.spyOn(durable, 'writeDurableNow').mockImplementationOnce(write).mockRejectedValueOnce(new Error('deletion write failed'));
  try {
    await expect(goal.withdrawSilenceGoalReplyNow(conversationId, 'silence:old')).rejects.toThrow('deletion write failed');
    await goal.setGoalReplyActiveNow(conversationId, false);
    await goal.setGoalReplyActiveNow(conversationId, true);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(goal.goalViewFor(conversationId)).toBeNull();
  } finally { spy.mockRestore(); }
});

it.each(['activity-cancel', 'ready-ack'] as const)('accepts the next quiet source after %s and rejects the old ACK', async cancellation => {
  const conversationId = `quiet-after-${cancellation}`;
  const session = await createSession({ conversationId });
  await goal.setGoalSwitchNow(conversationId, 'loop', true);
  await appendEvent(session.id, { source: 'extension', time: 1000, kind: 'user_message', message: { text: 'Continue this task', chars: 18, truncated: false } });
  await recordLoopMcpProof(session.id, 'source-work');
  const firstSeq = (await readRecentEvents(session.id, 1))[0]!.seq;
  await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, silenceSourceTurnId: 'source-work', replyId: 'silence:first', turnId: 'g-silence-first', eventSeq: firstSeq, blocked: false });
  globalThis.fetch = vi.fn(async () => decision('continue', 'Check the remaining work'));
  goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'g-silence-first' });
  const first = await settled(conversationId);
  expect(first.stage).toBe('ready');
  if (cancellation === 'activity-cancel') goal.retireGoalDraftsFor(conversationId);
  else await goal.ackGoalDraftNow(conversationId, first.token);
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  // The next genuine MCP activity and its later quiet boundary are new debt, even when the failed/cancelled helper belonged to the same source turn.
  await recordLoopMcpProof(session.id, 'source-work');
  const nextSeq = (await readRecentEvents(session.id, 1))[0]!.seq;
  await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, silenceSourceTurnId: 'source-work', replyId: 'silence:next', turnId: 'g-silence-next', eventSeq: nextSeq, blocked: false });
  expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe('silence:next');
  goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'g-silence-next', deferStart: true });
  expect(await goal.ackGoalDraftNow(conversationId, first.token)).toBe(false);
  expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe('silence:next');
});

it('projects the driver for each mode and preserves the active draft identity', async () => {
  const config = defaultConfig();
  await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', backend: 'api',
    loopBackend: 'web', model: 'z-ai/glm-5.3-flash' } });
  expect(goal.goalProgressFor('loop')).toMatchObject({ backend: 'web', model: 'DeepSeek' });
  expect(goal.goalProgressFor('goal')).toMatchObject({ backend: 'api', model: 'z-ai/glm-5.3-flash', provider: 'openrouter' });
  const conversationId = 'progress-driver-snapshot';
  const session = await createSession({ conversationId, title: 'Progress identity' });
  goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'progress-turn', deferStart: true });
  const draft = goal.goalViewFor(conversationId);
  expect(draft).toMatchObject({ backend: 'web', model: 'DeepSeek' });
  await saveConfig({ ...config, goal: { ...config.goal, backend: 'api', loopBackend: 'api', model: 'local-model' },
    providers: { api: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } } });
  expect(goal.goalProgressFor('loop', draft)).toMatchObject({ backend: 'web', model: 'DeepSeek' });
  expect(goal.goalProgressFor('loop')).toMatchObject({ backend: 'api', model: 'local-model', provider: 'custom' });
});
