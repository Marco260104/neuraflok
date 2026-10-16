import {
  appendEvent,
  createSession,
  delta,
  goal,
  settled,
  stream,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('one draft per generation', () => {
  /** The idempotency that keeps a retried POST, a reloaded tab or two observers of one settle from putting two messages into one conversation. */
  it('answers a repeated request for the same turn with the draft that exists', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-once' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'carry on', truncated: false, chars: 8 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stream([delta('and the docs'), 'data: [DONE]\n']);
    }) as never;

    const first = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-once', turnId: 'g-1' });
    const second = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-once', turnId: 'g-1' });
    expect(second.token).toBe(first.token);
    await settled('c-once');
    expect(calls).toBe(1);

    // A *different* generation supersedes it: the answer the old one was about is no longer the last thing said.
    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-once', turnId: 'g-2' });
    expect(goal.goalViewFor('c-once')!.turnId).toBe('g-2');
  });

  it('gives one browser tab exclusive authority to type an unspent draft', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-tab-owner' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'finish this once', truncated: false, chars: 16 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stream([delta('one follow-up only'), 'data: [DONE]\n']);
    }) as never;

    const first = goal.startGoalDraft({
      sessionId: session.id,
      conversationId: 'c-tab-owner',
      turnId: 'tab-a-generation',
      clientId: 'tab-a'
    } as any);
    await settled('c-tab-owner');

    expect(goal.goalViewFor('c-tab-owner', 'tab-a' as any)?.token).toBe(first.token);
    // A second tab polling the same conversation must not receive the ready payload. The old conversation-only view returned it to both tabs, while each tab's sessionStorage receipt was private, so both could cross ChatGPT's irreversible send boundary independently.
    expect(goal.goalViewFor('c-tab-owner', 'tab-b' as any)).toBeNull();
    // Its page-local generation id must not supersede/abort the owner's draft either.
    expect(() =>
      goal.startGoalDraft({
        sessionId: session.id,
        conversationId: 'c-tab-owner',
        turnId: 'tab-b-generation',
        clientId: 'tab-b'
      } as any)
    ).toThrow('goal_owned_elsewhere');
    expect(goal.ackGoalDraft('c-tab-owner', first.token, 'tab-b' as any)).toBe(false);
    expect(calls).toBe(1);
  });

  /** The reply is handed over only while it is still the thing to do. Once the page has said it acted on it, polling again must not find a message to type a second time. */
  it('stops offering a draft the page has acknowledged', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-ack' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'again', truncated: false, chars: 5 }
    });
    globalThis.fetch = (async () => stream([delta('one more thing'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-ack', turnId: 'g-1' });
    const view = await settled('c-ack');
    expect(view.reply).toBe('one more thing');

    expect(goal.ackGoalDraft('c-ack', view.token)).toBe(true);
    expect(goal.goalViewFor('c-ack')).toBeNull();
    // A wrong token is not an acknowledgement of anything.
    expect(goal.ackGoalDraft('c-ack', 'not-the-token')).toBe(false);
    // …and the turn is still spent, so nothing re-drafts it.
    expect(goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-ack', turnId: 'g-1' }).token).toBe(
      view.token
    );
  });

  it('stops an in-flight OpenRouter request when the browser retires the draft', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-ack-running' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });

    // Held on an object rather than in a plain `let`: the only assignment is inside a callback, so control-flow analysis narrows the variable to `null` at every read below and `signal?.aborted` stops compiling. A property is not narrowed that way.
    const opened: { signal: AbortSignal | null } = { signal: null };
    let fetchStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      opened.signal = init?.signal ?? null;
      fetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as never;

    const started = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-ack-running', turnId: 'g-1' });
    await entered;
    expect(opened.signal?.aborted).toBe(false);

    expect(goal.ackGoalDraft('c-ack-running', started.token)).toBe(true);
    expect(opened.signal?.aborted).toBe(true);
    expect(goal.goalViewFor('c-ack-running')).toBeNull();
  });

  it('stops every in-flight request on master Off and discharges its pending work', async () => {
    const session = await createSession({ title: 'goal revoke', conversationId: 'c-goal-revoke' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });

    let calls = 0;
    const opened: { signal: AbortSignal | null } = { signal: null };
    let fetchStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      opened.signal = init?.signal ?? null;
      fetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as never;

    const first = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-goal-revoke', turnId: 'g-revoke' });
    await entered;
    expect(opened.signal?.aborted).toBe(false);
    expect(goal.retireGoalDrafts(true)).toBe(1);
    expect(opened.signal?.aborted).toBe(true);
    expect(goal.goalViewFor('c-goal-revoke')).toBeNull();

    expect(goal.ackGoalDraft('c-goal-revoke', first.token)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it('keeps a retired generation spent instead of drafting the same turn a second time', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-cancel-once' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });

    let calls = 0;
    const opened: { signal: AbortSignal | null } = { signal: null };
    let fetchStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      opened.signal = init?.signal ?? null;
      fetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as never;

    const first = goal.startGoalDraft({
      sessionId: session.id,
      conversationId: 'c-cancel-once',
      turnId: 'g-cancelled'
    });
    await entered;
    expect(calls).toBe(1);

    expect(goal.ackGoalDraft('c-cancel-once', first.token)).toBe(true);
    expect(opened.signal?.aborted).toBe(true);
    expect(goal.goalViewFor('c-cancel-once')).toBeNull();

    // Cancellation means this generation was deliberately retired. A retry/reload that asks for the same turn must get the same spent identity back, not spend the OpenRouter key on a second request for work the page explicitly abandoned.
    const retried = goal.startGoalDraft({
      sessionId: session.id,
      conversationId: 'c-cancel-once',
      turnId: 'g-cancelled'
    });
    expect(retried.token).toBe(first.token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it('does not forget a spent generation when its visible draft ages past the ten-minute TTL', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-expired-once' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return stream([delta('one last correction'), 'data: [DONE]\n']);
    }) as never;

    const first = goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-expired-once', turnId: 'g-expired' });
    const ready = await settled('c-expired-once');
    expect(ready.stage).toBe('ready');
    expect(calls).toBe(1);

    // This is the dangerous lost-ACK shape: ChatGPT may already have accepted the user message, while the app still holds the ready draft as unacknowledged. The browser receipt is keyed by this token. Expiring the *payload* must not expire the generation identity and mint a different token that the browser cannot recognise as already sent.
    const afterTtl = Date.now() + 11 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(afterTtl);
    try {
      expect(goal.goalViewFor('c-expired-once')).toBeNull();
      const retried = goal.startGoalDraft({
        sessionId: session.id,
        conversationId: 'c-expired-once',
        turnId: 'g-expired'
      });
      expect(retried.token).toBe(first.token);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
