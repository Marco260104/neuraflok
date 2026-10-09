import {
  appendEvent,
  createSession,
  delta,
  goal,
  setSecret,
  settled,
  stream,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('when OpenRouter refuses', () => {
  const seed = async (conversationId: string): Promise<string> => {
    const session = await createSession({ title: 'goal', conversationId });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'go on', truncated: false, chars: 5 }
    });
    return session.id;
  };

  /** The status codes a person can act on, said in words rather than as a number. */
  it('names the reason, and never quotes the key back', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'no', 'auth_rejected'],
      [402, 'no', 'out_of_credit'],
      [404, 'no', 'unknown_model'],
      [429, 'no', 'rate_limited'],
      [503, 'no', 'http_503']
    ];
    for (const [index, [status, _body, expected]] of cases.entries()) {
      const id = `c-fail-${index}`;
      const sessionId = await seed(id);
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'upstream said no' } }), { status })) as never;
      goal.startGoalDraft({ sessionId, conversationId: id, turnId: 'g-1' });
      const view = await settled(id);
      expect(view.stage, String(status)).toBe('failed');
      expect(view.error, String(status)).toContain(expected);
      expect(view.error).not.toContain('sk-or-test');
    }
  });

  it('keeps a failure the page cannot retry on screen after the page acknowledged it (#584)', async () => {
    // 402: nothing will change until the user adds credit, so the page does not retry. It shows the reason and acknowledges the draft. The failure must stay the chat's Goal state: hiding it left only the still-owed reply, which read as "Answer settling" forever.
    const sessionId = await seed('c-no-credit');
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 })) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-no-credit', turnId: 'g-1' });
    const failed = await settled('c-no-credit');
    expect(failed.stage).toBe('failed');
    expect(goal.ackGoalDraft('c-no-credit', failed.token)).toBe(true);
    expect(goal.goalViewFor('c-no-credit')).toMatchObject({ stage: 'failed', error: expect.stringContaining('out_of_credit'), reply: '' });
    // Still there once the draft's payload would otherwise expire.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    try {
      expect(goal.goalViewFor('c-no-credit')).toMatchObject({ stage: 'failed', error: expect.stringContaining('out_of_credit') });
    } finally { clock.mockRestore(); }

    // A failure the page retries on its own clock is still hidden once acknowledged.
    const retrySession = await seed('c-busy');
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 })) as never;
    goal.startGoalDraft({ sessionId: retrySession, conversationId: 'c-busy', turnId: 'g-1' });
    const busy = await settled('c-busy');
    expect(goal.ackGoalDraft('c-busy', busy.token)).toBe(true);
    expect(goal.goalViewFor('c-busy')).toBeNull();
  });

  it('does not read an arbitrarily large OpenRouter error body just to produce a short status', async () => {
    const sessionId = await seed('c-huge-error');
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'small visible detail' } }), {
        status: 503,
        headers: { 'content-length': String(64 * 1024 + 1) }
      })) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-huge-error', turnId: 'g-1' });
    const view = await settled('c-huge-error');
    expect(view.stage).toBe('failed');
    expect(view.error).toContain('http_503');
    expect(view.error).toMatch(/body.*too large/i);
  });

  it('refuses before spending anything when there is no key', async () => {
    const sessionId = await seed('c-nokey');
    await setSecret('openRouterApiKey', '');
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return stream(['data: [DONE]\n']);
    }) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-nokey', turnId: 'g-1' });
    const view = await settled('c-nokey');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_api_key');
    expect(called).toBe(false);
    expect(await goal.goalKeyPresent()).toBe(false);
  });

  /** An empty answer is a failure, not a message. Typing nothing into a chat would send the turn on with no content at all, which is worse than saying the request failed. */
  it('treats an empty answer as a failure rather than as a message', async () => {
    const sessionId = await seed('c-empty');
    globalThis.fetch = (async () => stream([delta('   '), 'data: [DONE]\n'])) as never;
    goal.startGoalDraft({ sessionId, conversationId: 'c-empty', turnId: 'g-1' });
    const view = await settled('c-empty');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('empty_reply');
  });

  it('does not promote a partial reply when a later SSE record is malformed', async () => {
    const sessionId = await seed('c-malformed-stream');
    globalThis.fetch = (async () => stream([delta('unfinished thought'), 'data: {not-json}\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-malformed-stream', turnId: 'g-1' });
    const view = await settled('c-malformed-stream');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('request_failed: malformed_stream_record');
    expect(view.reply).toBe('');
  });

  it('refuses an over-long generated user reply instead of streaming an unbounded composer payload', async () => {
    const sessionId = await seed('c-too-long');
    globalThis.fetch = (async () => stream([delta('x'.repeat(12_001)), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId, conversationId: 'c-too-long', turnId: 'g-1' });
    const view = await settled('c-too-long');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('reply_too_long');
    expect(view.reply).toBe('');
  });

  /** A chat with no local recording has no conversation to reason about. */
  it('says so when there is nothing recorded to continue from', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-silent' });
    globalThis.fetch = (async () => stream(['data: [DONE]\n'])) as never;
    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-silent', turnId: 'g-1' });
    const view = await settled('c-silent');
    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_conversation');
  });
});
