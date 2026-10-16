import { CHAT_B, SAMPLE_BRIEF, attachedChat, claimContinuationNow, commitContinuation, continuationForSession, readyContinuation, store } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('claiming', () => {
  it('serves one claimant and refuses a second', async () => {
    const { token } = await readyContinuation();

    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
    expect(await claimContinuationNow(token, 'tab-2')).toBeNull();
    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
  });

  it('does not move the state backwards while a commit is in flight', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    // Hold the durable write open, so the commit is provably mid-flight.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = store.rebindSession;
    const spy = vi.spyOn(store, 'rebindSession').mockImplementation(async (...args) => {
      await held;
      return real(...args);
    });

    const commit = commitContinuation(token, CHAT_B);
    await Promise.resolve();
    expect(continuationForSession(sessionId)?.state).toBe('committing');

    // The retrying claimant wants its brief; what it must not get is the state put back to `claimed`, which was the one way a second commit could enter behind the first.
    expect((await claimContinuationNow(token, 'tab-1'))?.summary).toContain(SAMPLE_BRIEF);
    expect(continuationForSession(sessionId)?.state).toBe('committing');
    const second = await commitContinuation(token, 'chat-c');
    expect(second).toBe(false);

    release();
    expect(await commit).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });
});
