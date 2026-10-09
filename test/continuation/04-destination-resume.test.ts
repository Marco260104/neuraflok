import { CHAT_A, CHAT_B, CONTINUATION_TTL_MS, SAMPLE_BRIEF, abortContinuation, abortContinuationNow, attachSummary, attachedChat, claimContinuationNow, commitContinuation, continuationByToken, continuationForSession, createSession, openContinuationNow, readyContinuation, store } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('the commit lock', () => {
  it('keeps a commit behind an earlier automatic cancellation until its refusal is durable', async () => {
    const summary = await createSession({ title: 'cancel before commit', conversationId: CHAT_A });
    const ticket = await openContinuationNow(summary.id, CHAT_A, true);
    await attachSummary(ticket.token, SAMPLE_BRIEF);
    await claimContinuationNow(ticket.token, 'tab-1');
    const refuse = store.refuseAutomaticCompactionNow;
    let entered = false;
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(store, 'refuseAutomaticCompactionNow').mockImplementationOnce(async (...args) => {
      entered = true;
      await held;
      return refuse(...args);
    });
    const cancel = abortContinuationNow(ticket.token, 'cancelled');
    await vi.waitFor(() => expect(entered).toBe(true));
    const commit = commitContinuation(ticket.token, CHAT_B);
    release();
    expect(await cancel).toBe(true);
    expect(await commit).toBe(false);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
    expect(continuationByToken(ticket.token)?.state).toBe('aborted');
  });

  it('does not cancel a commit while its staged intent is still being written', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    const durable = await import('../../backend/persistence/durable.js');
    const real = durable.writeDurableNow;
    let entered = false;
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(durable, 'writeDurableNow').mockImplementationOnce(async (...args) => {
      entered = true;
      await held;
      return real(...args);
    });
    const commit = commitContinuation(token, CHAT_B);
    await vi.waitFor(() => expect(entered).toBe(true));
    const cancel = abortContinuationNow(token, 'cancelled');
    release();
    expect(await commit).toBe(true);
    expect(await cancel).toBe(false);
    expect(continuationByToken(token)?.state).toBe('committed');
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  /** Runs `body` while the durable write is suspended, then lets the commit finish. */
  async function duringDurableWrite(
    token: string,
    to: string,
    body: () => void | Promise<void>
  ): Promise<boolean> {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });
    const commit = commitContinuation(token, to);
    await Promise.resolve();
    await body();
    release();
    return commit;
  }

  it('cannot be aborted once the durable write has started', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      // An abort here would clear the frozen prime handover under a write that is still going to land — the split this transaction exists to make impossible.
      expect(abortContinuation(token, 'user changed their mind')).toBe(false);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('is not swept away by a lookup that happens to cross the deadline', async () => {
    vi.useFakeTimers();
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    const committed = await duringDurableWrite(token, CHAT_B, () => {
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS + 1_000);
      // Any passing lookup runs the sweep. It must not expire a commit already in flight.
      continuationForSession(sessionId);
    });

    expect(committed).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});
