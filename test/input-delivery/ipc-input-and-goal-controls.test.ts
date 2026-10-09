import {
  OFFLINE_GOAL_MARKER_INSTRUCTION,
  createSession,
  defaultConfig,
  finishInstruction,
  goal,
  handlers,
  input,
  message,
  post,
  randomUUID,
  rebindSession,
  saveConfig,
  userPromptText,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('IPC input delivery and Goal control integration', () => {
  it.each([3, 5])('adds the shared %s-minute finish instruction to Astra opening input and excludes other models', async lead => {
    const config = defaultConfig();
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const request = { ...message(null, 'off'), model: 'gpt-6-pro', reasoningEffort: 'pro' };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    const claimed = await input.claimBrowserInput(request.id, 'opening', null);
    expect(userPromptText(claimed!.text)).toBe(request.text + '\n\n' + finishInstruction(lead));
    expect((await input.listInputs()).find(row => row.id === request.id)?.text).toBe(request.text);
    await saveConfig(config);
    input.resetInputForTests();
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);

    const ordinary = message(null, 'off');
    await input.enqueueInput(ordinary as Parameters<typeof input.enqueueInput>[0]);
    expect(userPromptText((await input.claimBrowserInput(ordinary.id, 'disabled', null))!.text)).toBe(ordinary.text);
    await input.cancelInput(ordinary.id);
    await saveConfig({ ...config, ui: { ...config.ui, finishTool: true, finishLeadMinutes: lead } });
    const sol = { ...message(null, 'off'), model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    await input.enqueueInput(sol as Parameters<typeof input.enqueueInput>[0]);
    expect(userPromptText((await input.claimBrowserInput(sol.id, 'sol', null))!.text)).toBe(sol.text);
    await input.cancelInput(sol.id);
    const chat = await createSession({ title: 'Existing native chat', conversationId: randomUUID() });
    const later = message(chat.id, 'off');
    await input.enqueueInput(later as Parameters<typeof input.enqueueInput>[0]);
    expect((await input.claimBrowserInput(later.id, 'later', chat.conversationId))!.text).toBe(later.text);
    await input.cancelInput(later.id);
  });
  it('releases only the expected actual turn through IPC', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'End turn control', conversationId });
    await saveConfig({ ...defaultConfig(), ui: { ...defaultConfig().ui, finishTool: true } });
    // The extension's accepted observation route owns live activity, not a durable recorder row alone. Exercise that authority before asking IPC for live controls.
    const first = await post('/events', { conversationId,
      events: [{ kind: 'turn_start', turnId: 'first-held-turn', time: Date.now() }] });
    expect(first.status).toBe(200);
    expect(first.body.sessionId).toBe(session.id);
    const current = await handlers.get('sessions:controls')!(null, { id: session.id });
    expect(current.data).toMatchObject({ activeTurnId: 'first-held-turn', finishHeld: true });
    expect((await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'stale-turn' })).ok).toBe(false);
    const released = await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'first-held-turn' });
    expect(released.data.finishHeld).toBe(false);
    const second = await post('/events', { conversationId,
      events: [{ kind: 'turn_start', turnId: 'second-held-turn', time: Date.now() + 1 }] });
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(session.id);
    expect((await handlers.get('sessions:releaseFinish')!(null, { id: session.id, expectedTurnId: 'first-held-turn' })).ok).toBe(false);
    expect((await handlers.get('sessions:controls')!(null, { id: session.id })).data.finishHeld).toBe(true);
  });
  it('shares selected-chat objectives with the extension and projects objective-only Goal', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Objective control', conversationId });
    const call = (name: string, extra = {}) => handlers.get(name)!(null, { id: session.id, ...extra });
    await goal.setGoalObjectiveNow(conversationId, 'Legacy objective');
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: false, own: false });
    expect((await call('sessions:controls')).data).toMatchObject({ objective: 'Legacy objective', automation: 'goal' });
    const saved = await call('sessions:objective', { text: '  Follow this objective  ', mode: 'loop' });
    expect(saved.ok).toBe(true);
    expect(saved.data).toMatchObject({ objective: 'Follow this objective', automation: 'loop' });
    expect(goal.goalObjectiveFor(conversationId)).toBe('Follow this objective');
    expect(goal.goalSwitchFor(conversationId)).toMatchObject({ enabled: true, mode: 'loop', own: true });
    const extension = await post('/goal/objective', { conversationId, text: 'Updated in browser', mode: 'goal' });
    expect(extension.status).toBe(200);
    expect((await call('sessions:controls')).data).toMatchObject({ objective: 'Updated in browser', automation: 'goal' });
    const destination = randomUUID();
    expect(await rebindSession(session.id, conversationId, destination)).toBe(true);
    expect((await call('sessions:objective', { text: 'Current destination', mode: 'loop' })).data.conversationId).toBe(destination);
    expect(goal.goalObjectiveFor(conversationId)).toBe('Updated in browser');
    const { setChatBlocked } = await import('../../backend/domains/sessions/continuity/blocked-chats.js');
    setChatBlocked(destination, true);
    expect((await call('sessions:objective', { text: 'Forbidden replacement', mode: 'goal' })).error).toBe('chat_blocked');
    expect(goal.goalObjectiveFor(destination)).toBe('Current destination');
    expect((await call('sessions:objective', { text: '', mode: 'goal' })).data).toMatchObject({ objective: '', automation: 'off' });
    expect(goal.goalSwitchFor(destination)).toMatchObject({ enabled: false, mode: 'loop' });
    setChatBlocked(destination, false);
    await goal.registerGoalDecisionChat(destination);
    expect((await call('sessions:objective', { text: 'Not a source', mode: 'goal' })).error).toBe('goal_worker_chat');
  });
  it('controls exact durable sessions and withdraws Goal without sending new input', async () => {
    const id = randomUUID();
    const session = await createSession({ title: 'Controls', conversationId: id });
    const call = (name: string, extra = {}) => handlers.get(name)!(null, { id: session.id, ...extra });
    const before = (await input.listInputs()).length;
    expect((await call('sessions:automation', { automation: 'goal' })).data.automation).toBe('goal');
    expect((await call('sessions:automation', { automation: 'loop' })).data.automation).toBe('loop');
    expect((await call('sessions:automation', { automation: 'off' })).data.automation).toBe('off');
    expect((await input.listInputs()).length).toBe(before);
    const destination = randomUUID();
    expect(await rebindSession(session.id, id, destination)).toBe(true);
    expect((await call('sessions:automation', { automation: 'goal' })).data.conversationId).toBe(destination);
    expect(goal.goalSwitchFor(id).enabled).toBe(false);
    for (const channel of ['sessions:controls', 'sessions:automation', 'sessions:compact', 'sessions:cancelCompaction']) {
      expect((await handlers.get(channel)!(null, { id: randomUUID(), automation: 'goal' })).ok).toBe(false);
    }
  });
  it('rejects a superseded current attachment before changing either control ledger', async () => {
    const store = await import('../../backend/domains/sessions/history/store.js');
    const session = await createSession({ title: 'Superseded control fence', conversationId: randomUUID() });
    const proof = vi.spyOn(store, 'conversationWasSuperseded').mockResolvedValue(true);
    try {
      for (const channel of ['sessions:controls', 'sessions:automation', 'sessions:compact', 'sessions:cancelCompaction']) {
        expect((await handlers.get(channel)!(null, { id: session.id, automation: 'goal' })).error).toBe('conversation_superseded');
      }
      expect(goal.goalSwitchFor(session.conversationId!).own).toBe(false);
    } finally { proof.mockRestore(); }
  });
  it('uses one idempotent continuation ticket and permits cancellation while blocked', async () => {
    const { setChatBlocked } = await import('../../backend/domains/sessions/continuity/blocked-chats.js');
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Compact controls', conversationId });
    const first = await handlers.get('sessions:compact')!(null, { id: session.id });
    expect(first.ok).toBe(true);
    expect(first.data.job.token).toBeTruthy();
    const repeated = await handlers.get('sessions:compact')!(null, { id: session.id });
    expect(repeated.data.job.token).toBe(first.data.job.token);
    setChatBlocked(conversationId, true);
    expect((await handlers.get('sessions:compact')!(null, { id: session.id })).error).toBe('chat_blocked');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'goal' })).error).toBe('chat_blocked');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'off' })).ok).toBe(true);
    expect((await handlers.get('sessions:cancelCompaction')!(null, { id: session.id })).ok).toBe(true);
    setChatBlocked(conversationId, false);
  });
  it('fences durable decision helpers from Goal and compaction after reload', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Decision controls', conversationId });
    await goal.registerGoalDecisionChat(conversationId);
    expect((await handlers.get('sessions:controls')!(null, { id: session.id })).data.blocked).toBe('worker');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'loop' })).error).toBe('worker_goal_disabled');
    expect((await handlers.get('sessions:compact')!(null, { id: session.id })).error).toBe('worker_compaction_disabled');
    expect((await handlers.get('sessions:automation')!(null, { id: session.id, automation: 'off' })).ok).toBe(true);
  });
  it('prepares fresh offline Goal before global activation and preserves authored enqueue identity', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, backend: 'templates' } });
    const request = message(null, 'goal');
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    const claimed = await input.claimBrowserInput(request.id, 'offline-document', null);
    expect(userPromptText(claimed!.text)).toBe(request.text + OFFLINE_GOAL_MARKER_INSTRUCTION);
    expect((await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0])).text).toBe(request.text);
    expect((await input.listInputs()).find(row => row.id === request.id)?.deliveryText).toBe(claimed?.text);
    await input.cancelInput(request.id);
    for (const automation of ['off', 'loop'] as const) {
      const manual = message(null, automation);
      await input.enqueueInput(manual as Parameters<typeof input.enqueueInput>[0]);
      expect(userPromptText((await input.claimBrowserInput(manual.id, automation, null))!.text)).toBe(manual.text);
      await input.cancelInput(manual.id);
    }
  });
  it('prepares scheduled tool input with the delivery backend and freezes retries across backend changes', async () => {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Scheduled offline', conversationId });
    const request = { ...message(session.id, 'goal'), dueAt: Date.now() + 60000 };
    await input.enqueueInput(request as Parameters<typeof input.enqueueInput>[0]);
    expect(await input.offerToolInput(session.id, conversationId, 'early', 0)).toEqual({ messages: [], reminder: '' });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: false, backend: 'templates' } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(request.dueAt + 1);
    try {
      const offered = await input.offerToolInput(session.id, conversationId, 'first', 0);
      expect(offered.messages[0]?.text).toContain(request.text + OFFLINE_GOAL_MARKER_INSTRUCTION);
      await saveConfig(defaultConfig());
      input.resetInputForTests();
      expect(await input.offerToolInput(session.id, conversationId, 'repeat', 0)).toEqual(offered);
    } finally { clock.mockRestore(); }
  });
});
