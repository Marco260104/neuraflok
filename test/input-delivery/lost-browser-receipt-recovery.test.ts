import {
  createSession,
  input,
  message,
  post,
  randomUUID,
} from './context.js';
import { expect, it, vi } from 'vitest';

it('retires a lost authorized browser receipt so the session accepts and delivers the next user message', async () => {
  let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const conversationId = randomUUID(), turnId = randomUUID();
    const session = await createSession({ title: 'Lost send receipt', conversationId });
    await post('/events', { conversationId, events: [
      { kind: 'model_selection', model: 'gpt-5.6-sol', time: now },
      { kind: 'turn_start', turnId, time: now },
      { kind: 'assistant_message', messageId: randomUUID(), turnId, text: 'Done.', state: 'final', final: true, time: ++now },
      { kind: 'turn_end', turnId, outcome: 'completed', time: ++now }
    ] });
    const lost = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text: 'First request' });
    expect(await input.claimBrowserInput(lost.id, 'lost-document', conversationId, true)).not.toBeNull();
    expect(await input.authorizeBrowserInput(lost.id, 'lost-document', conversationId)).toBe(true);
    // The receipt never arrives, so the uncertain claim still owns the whole session.
    await expect(input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text: 'Second request' }))
      .rejects.toThrow('One message is already awaiting delivery');
    now += 899_999;
    input.resetInputForTests();
    expect((await input.listInputs()).find(item => item.id === lost.id)?.state).toBe('browser');
    await expect(input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text: 'Second request' }))
      .rejects.toThrow('One message is already awaiting delivery');
    // The bounded wait elapses across a restart, and the lost outcome is now visible.
    now += 1;
    input.resetInputForTests();
    expect((await input.listInputs()).find(item => item.id === lost.id)).toMatchObject({
      state: 'cancelled',
      error: 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.'
    });
    // A terminal row is never offered or replayed, so at-most-once delivery is unchanged.
    expect((await input.pendingBrowserInputs()).map(item => item.id)).not.toContain(lost.id);
    expect(await input.claimBrowserInput(lost.id, 'replacement-document', conversationId, true)).toBeNull();
    const next = await input.enqueueInput({ ...message(session.id, 'off'), mode: 'auto', text: 'Second request' });
    expect(await input.claimBrowserInput(next.id, 'replacement-document', conversationId, true)).not.toBeNull();
  } finally { clock.mockRestore(); }
});
