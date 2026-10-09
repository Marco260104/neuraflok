import { COMMAND_DEADLINE_MS, describe, expect, finishAgent, getLog, it, opened, pair, PRIME_CHAT, redeem, request, REVIVAL_DEADLINE_MS, spawn, vi, waitForRevival, wake } from '../../test-context.js';

// ------------------------------------------------- where a command stopped (#882 worker-11)

describe('a command that runs out of time says how far its page got', () => {
  const giveUp = (prior: Set<unknown>, prefix: string) =>
    getLog().find(entry => !prior.has(entry) && entry.message.includes(`gave up on ${prefix}`))?.message ?? '';
  const step = (id: string, step: string, client = 'tab-1') => request('POST', '/commands/step', { body: { id, client, step } });

  it('names the last step a worker page reported', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      expect((await step(bootstrap.id, 'composer')).body).toEqual({ ok: true });
      expect((await step(bootstrap.id, 'model')).body).toEqual({ ok: true });
      const prior = new Set(getLog());
      await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS + 1_000);
      const message = giveUp(prior, 'worker:');
      expect(message).toContain('did not report back in time');
      expect(message).toContain('last step: choosing the model and reasoning');
      expect(message).not.toContain('write the audit');
    } finally { vi.useRealTimers(); }
  });

  it('ignores a step from a page that does not own the command, and unknown steps', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      expect((await step(bootstrap.id, 'model', 'another-tab')).body).toEqual({ ok: false });
      expect((await step(bootstrap.id, 'reading your files')).body).toEqual({ ok: false });
      expect((await step('no-such-command', 'model')).body).toEqual({ ok: false });
      const prior = new Set(getLog());
      await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS + 1_000);
      expect(giveUp(prior, 'worker:')).toContain('the page picked up its task, then reported nothing more');
    } finally { vi.useRealTimers(); }
  });

  it('says when the chat was opened but no page picked up its task', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
      const prior = new Set(getLog());
      await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS + 1_000);
      expect(giveUp(prior, 'worker:')).toContain('opened through the operating system, and no page with the extension picked up its task');
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['revival-busy', 'its chat was still answering'],
    ['revival-draft', 'its message box was not empty'],
    ['revival-editor', 'its page never showed a usable message box']
  ])('names why a wake waited: %s', async (reason, text) => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'dededede-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', { body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' } });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'continue with the second half' }]);
      const { id } = await waitForRevival();
      expect((await step(id, 'revival-busy', 'revival-document')).body).toEqual({ ok: true });
      expect((await step(id, reason, 'revival-document')).body).toEqual({ ok: true });
      const prior = new Set(getLog());
      await vi.advanceTimersByTimeAsync(REVIVAL_DEADLINE_MS + 1_000);
      expect(giveUp(prior, 'revive:')).toContain(`the browser did not claim this command before its deadline (${text})`);
    } finally { vi.useRealTimers(); }
  });

  it('says a wake waited for a busy chat or a non-empty message box', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'dededede-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', { body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' } });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'continue with the second half' }]);
      const { id } = await waitForRevival();
      expect((await step(id, 'revival-waiting', 'revival-document')).body).toEqual({ ok: true });
      const prior = new Set(getLog());
      await vi.advanceTimersByTimeAsync(REVIVAL_DEADLINE_MS + 1_000);
      const message = giveUp(prior, 'revive:');
      expect(message).toContain('the browser did not claim this command before its deadline');
      expect(message).toContain('its chat was still answering or its message box was not empty');
      expect(message).not.toContain('continue with the second half');
    } finally { vi.useRealTimers(); }
  });
});
