import {
  attributedMcp,
  createSession,
  input,
  message,
  post,
  randomUUID,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('projects and delivers a direct correction through the real recorder, bridge claim and native receipt', async () => {
  const { sessionControlsFor } = await import('../../backend/domains/browser/bridge.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Tool-free correction', conversationId });
  const time = Date.now();
  await post('/events', { conversationId, events: [
    { kind: 'model_selection', model: 'gpt-5.6-sol', reasoningEffort: 'high', time },
    { kind: 'user_message', messageId: 'plain-user', text: 'Explain the idea without tools', time },
    { kind: 'turn_start', turnId: 'plain-turn', time: time + 1 }
  ] });
  expect(await sessionControlsFor(session.id)).toMatchObject({ canInject: false, canSendDirectly: true });
  const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
  expect(row.directTurn?.id).toBe('plain-turn');
  const claim = await post('/input/claim', { id: row.id, owner: 'direct-page', conversationId, requiresAuthorization: true });
  expect(claim.body.input).toMatchObject({ id: row.id, directTurn: { id: 'plain-turn' } });
  await post('/events', { conversationId, events: [
    { kind: 'turn_end', turnId: 'plain-turn', outcome: 'stopped', time: time + 2 }
  ] });
  expect((await post('/input/claim', { id: row.id, owner: 'direct-page', conversationId, authorize: true })).body.ok).toBe(true);
  expect((await post('/input/ack', { id: row.id, owner: 'direct-page', conversationId, messageId: 'direct-user' })).body.ok).toBe(true);
  expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'sent', messageId: 'direct-user' });
});

it.each(['interim', 'native-tool', 'mcp', 'final', 'replay'] as const)('releases failed input immediately and reconciles later %s', async activity => {
  const bridge = await import('../../backend/domains/browser/bridge.js');
  const store = await import('../../backend/domains/sessions/history/store.js');
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID();
    const session = await createSession({ title: 'Failed view lifecycle', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'user_message', messageId: 'question', text: 'Work', authoredNow: true, time: now },
      { kind: 'turn_start', turnId: 'failed-view', time: now }
    ] });
    await attributedMcp(conversationId);
    now++;
    const failure = { kind: 'turn_end', turnId: 'failed-view', reason: 'thinking_failed', outcome: 'failed', time: now };
    await post('/events', { conversationId, events: [failure] });
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({canInject: false, browserAllowed: true});
    const manual = await input.enqueueInput({...message(session.id, 'off'), mode: 'auto'});
    expect((await input.pendingBrowserInputs()).some(row => row.id === manual.id)).toBe(true);
    await input.cancelInput(manual.id);
    const queued = await input.enqueueInput({...message(session.id, 'off'), mode: 'after-turn'});
    now += 1000;
    if (activity === 'mcp') await attributedMcp(conversationId);
    else await post('/events', { conversationId, events: [activity === 'replay' ? failure : activity === 'native-tool'
      ? {kind: 'page_tool', turnId: 'failed-view', messageId: 'new-tool', text: 'Searching files', time: now}
      : {kind: 'assistant_message', turnId: 'failed-view', messageId: 'new-answer', providerMessageId: 'abababab-1111-2222-3333-444444444444',
          text: 'Fresh answer', state: activity === 'final' ? 'final' : 'streaming', final: activity === 'final', activeNow: true, time: now}] });
    const resumed = activity !== 'final' && activity !== 'replay';
    expect((await store.getSession(session.id))?.activeTurnId).toBe(resumed ? 'failed-view' : null);
    if (resumed) {
      await post('/events', {conversationId, events: [failure]});
      expect((await store.getSession(session.id))?.activeTurnId).toBe('failed-view');
    }
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({canInject: resumed, browserAllowed: !resumed});
    now += 29_000;
    await bridge.sweepStaleSwarm(now);
    const repairs = (await post('/status', {openConversations: [conversationId]})).body.repairs;
    expect(repairs.some((row: any) => row.conversationId === conversationId)).toBe(false);
    expect((await input.pendingBrowserInputs()).some(row => row.id === queued.id)).toBe(activity === 'final');
    now += 270_000;
    await bridge.sweepStaleSwarm(now);
    expect((await post('/status', {openConversations: [conversationId]})).body.repairs
      .some((row: any) => row.conversationId === conversationId && row.reason === 'silence')).toBe(activity === 'replay');
  } finally { clock.mockRestore(); }
});

it.each(['timestamp', 'provider-alias'] as const)('keeps failed manual delivery available after a %s-only interim revision', async revision => {
  const store = await import('../../backend/domains/sessions/history/store.js');
  const conversationId = randomUUID();
  const session = await createSession({ title: 'Failed metadata replay', conversationId });
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const interim = { kind: 'assistant_message', turnId: 'metadata-turn', messageId: 'original-interim',
      providerMessageId: 'abababab-1111-2222-3333-444444444444', text: 'Geometry still needs work',
      state: 'streaming', activeNow: true, time: now };
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-6-pro', time: now },
      { kind: 'turn_start', turnId: interim.turnId, time: now }, interim
    ] });
    now++;
    await post('/events', { conversationId, events: [
      { kind: 'turn_end', turnId: interim.turnId, outcome: 'failed', reason: 'thinking_failed', time: now }
    ] });
    now += 62;
    await post('/events', { conversationId, events: [{ ...interim, time: now,
      ...(revision === 'timestamp' ? { authoredTime: true } : { messageId: 'replacement-fiber-alias' }) }] });
    expect((await store.getSession(session.id))?.activeTurnId).toBeNull();
    expect(await input.sessionInputPolicy(session.id)).toMatchObject({ canInject: false, browserAllowed: true });
    const row = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto' });
    const claim = await input.claimBrowserInput(row.id, 'native-page', conversationId, true);
    expect(claim?.id).toBe(row.id);
    expect(await input.authorizeBrowserInput(row.id, 'native-page', conversationId)).toBe(true);
    expect(await input.acknowledgeBrowserInput(row.id, 'native-page', conversationId, 'next-question')).toBe(true);
    expect((await input.listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
  } finally { clock.mockRestore(); }
});
