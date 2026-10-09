import {
  appendEvent,
  createSession,
  decision,
  goal,
  observeSessionModel,
  recordLoopMcpProof,
  saveConfig,
  settled,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('publishes actual opening response deltas before one validated final result', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  let requested: any;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    requested = JSON.parse(String(init.body));
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as never;
  const updates = vi.fn();
  const result = goal.draftOpeningMessage('Inspect then implement', 'goal', updates);
  await vi.waitFor(() => expect(requested?.stream).toBe(true));
  const encoder = new TextEncoder();
  const emit = (content: string) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
  emit('{"action":"continue","reply":"Inspect');
  await vi.waitFor(() => expect(updates).toHaveBeenCalledWith({ phase: 'generating', text: '{"action":"continue","reply":"Inspect' }));
  let completed = false; void result.then(() => { completed = true; });
  expect(completed).toBe(false);
  emit(' then implement"}'); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  expect(await result).toMatchObject({ reply: 'Inspect then implement' });
});

it('keeps Astra Goal finish-only while the finish tool is enabled and after-turn is not selected', async () => {
  const config = (await import('../../backend/infrastructure/settings/config.js')).getConfig();
  await saveConfig({ ...config, ui: { ...config.ui, finishTool: true } });
  const conversationId = 'aaaaaaaa-1111-4222-8333-123456789abc';
  const session = await createSession({ conversationId, title: 'Astra finish-only' });
  await observeSessionModel(session.id, conversationId, 'gpt-6-pro', Date.now());
  await goal.setGoalSwitchNow(conversationId, 'goal', true);
  await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'astra-final', turnId: 'astra-turn', eventSeq: 1, blocked: false });
  expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  const fetch = vi.fn(); globalThis.fetch = fetch;
  const draft = goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'astra-turn' });
  goal.beginGoalDraft(conversationId, draft.token);
  await vi.waitFor(() => expect(goal.goalViewFor(conversationId)?.stage).toBe('no-reply'));
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['goal', 'loop'] as const)('runs Astra %s through its ordinary decision after a turn when finish is disabled or after-turn is selected', async mode => {
  const config = (await import('../../backend/infrastructure/settings/config.js')).getConfig();
  for (const finishTool of [false, true]) {
    await saveConfig({ ...config, ui: { ...config.ui, finishTool } });
    const conversationId = `astra-${mode}-${finishTool}`;
    const session = await createSession({ conversationId });
    await observeSessionModel(session.id, conversationId, 'gpt-6-pro', Date.now());
    await goal.setGoalSwitchNow(conversationId, mode, true, finishTool);
    await appendEvent(session.id, { kind: 'user_message', source: 'extension', time: Date.now(),
      message: { text: 'Finish the requested checks', chars: 27, truncated: false } });
    await recordLoopMcpProof(session.id, 'astra-turn');
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'astra-final', turnId: 'astra-turn', eventSeq: 10, blocked: false });
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe('astra-final');
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.messages[0].content).toBe(mode === 'goal' ? config.goal.prompt : config.goal.loopPrompt);
      return decision(mode === 'goal' ? 'stop' : 'continue', mode === 'loop' ? 'Continue the requested checks' : '');
    });
    globalThis.fetch = fetcher as typeof fetch;
    goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'astra-turn' });
    expect((await settled(conversationId)).stage).toBe(mode === 'goal' ? 'no-reply' : 'ready');
    expect(fetcher).toHaveBeenCalledOnce();
  }
});
