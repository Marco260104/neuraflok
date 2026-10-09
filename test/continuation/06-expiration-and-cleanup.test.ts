import { AUTOMATIC_HANDOVER_TTL_MS, CHAT_A, CHAT_B, CHAT_C, CONTINUATION_TTL_MS, SAMPLE_BRIEF, attachedChat, beginContinuationSourceSendNow, commitContinuation, compactingConversation, continuationByToken, continuationForSession, createSession, dispatchContinuationSourceSendNow, openContinuationNow, primeConversationGone, resetContinuationsForTests, restoreContinuations, snapshotContinuations, spawn, store, supersededSourceConversations, swarmRunning } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('restart lifetime recovery', () => {
  it('gives up an automatic handover that never lands, so the source chat gets its tools back', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'stuck auto handover', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A, true);

    // Intended but not yet asked for: the chat may be mid-turn for as long as it likes.
    vi.setSystemTime(Date.now() + AUTOMATIC_HANDOVER_TTL_MS * 2);
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect(compactingConversation(CHAT_A)).toBeNull();

    // Asked for: from here chat A is refused every tool until the handover lands, so this is where the clock starts. A handover the model never finishes must not fence A for good.
    expect((await beginContinuationSourceSendNow(opened.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(opened.token)).toBe(true);
    expect(compactingConversation(CHAT_A)?.token).toBe(opened.token);
    vi.setSystemTime(Date.now() + AUTOMATIC_HANDOVER_TTL_MS - 1);
    expect(compactingConversation(CHAT_A)?.token).toBe(opened.token);
    const saved = snapshotContinuations();

    vi.setSystemTime(Date.now() + 2);
    expect(compactingConversation(CHAT_A)).toBeNull();
    expect(continuationForSession(summary.id)).toBeNull();

    // The same verdict when a restart finds the record on disk.
    resetContinuationsForTests();
    await restoreContinuations(saved);
    expect(compactingConversation(CHAT_A)).toBeNull();
    expect(continuationForSession(summary.id)).toBeNull();
  });

  it('keeps a committed record committed when the session has since moved on again', async () => {
    const now = Date.now();
    const summary = await createSession({ title: 'moved twice', conversationId: CHAT_A });
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);
    expect(await store.rebindSession(summary.id, CHAT_B, CHAT_C)).toBe(true);

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'first-move-token-0',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - 1_000,
          state: 'committed',
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    // A later handover out of B does not make the first move any less real: A stays a superseded chat rather than the record being aborted for an "unexpected" attachment.
    expect(continuationByToken('first-move-token-0')?.state).toBe('committed');
    expect(supersededSourceConversations()).toContain(CHAT_A);
    expect(await attachedChat(summary.id)).toBe(CHAT_C);
  });

  it('does not roll an expired pre-commit record back into a fresh transfer', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const summary = await createSession({ title: 'expired committing restore', conversationId: CHAT_A });
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId: CHAT_A } });

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'expired-commit-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - CONTINUATION_TTL_MS - 1,
          state: 'committing',
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    // The session still being on A proves the durable move never landed. Recovery may not convert that expired intent back to `claimed` and mint a new transfer lifetime.
    expect(continuationByToken('expired-commit-token')?.state).toBe('aborted');
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });

  it('keeps a terminal commit replayable during the second TTL window', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const summary = await createSession({ title: 'committed restore', conversationId: CHAT_A });
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);

    await restoreContinuations({
      version: 1,
      savedAt: now,
      entries: [
        {
          token: 'terminal-replay-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: now - CONTINUATION_TTL_MS - 1,
          state: 'committed',
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    });

    expect(await commitContinuation('terminal-replay-token', CHAT_B)).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
  });
});
