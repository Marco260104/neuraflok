import { CHAT_A, CONTINUATION_PRO_WRITING_TTL_MS, CONTINUATION_TTL_MS, CONTINUATION_WRITING_TTL_MS, SAMPLE_BRIEF, attachSummary, beginContinuationSourceSendNow, bindContinuationSourceMessageNow, continuationByToken, continuationForSession, createSession, dispatchContinuationSourceSendNow, openContinuationNow, resetContinuationsForTests, restoreContinuations, snapshotContinuations, store } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('an exact handoff response owns its waiting deadline', () => {
  it('survives growing output and restart but expires after unchanged snapshots', async () => {
    vi.useFakeTimers();
    try {
      const session = await createSession({ title: 'long handoff', conversationId: CHAT_A });
      const opened = await openContinuationNow(session.id, CHAT_A);
      await beginContinuationSourceSendNow(opened.token);
      await dispatchContinuationSourceSendNow(opened.token);
      await bindContinuationSourceMessageNow(opened.token, 'exact-user-message');
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS - 60_000);
      expect(await bindContinuationSourceMessageNow(opened.token, 'wrong-message', 500)).toBe(false);
      expect(await bindContinuationSourceMessageNow('wrong-token', 'exact-user-message', 500)).toBe(false);
      expect(await bindContinuationSourceMessageNow(opened.token, 'exact-user-message', 500)).toBe(true);
      vi.setSystemTime(Date.now() + 2 * 60_000);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');
      const snapshot = snapshotContinuations();
      resetContinuationsForTests();
      await restoreContinuations(snapshot);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');
      expect(await bindContinuationSourceMessageNow(opened.token, 'exact-user-message', 500)).toBe(true);
      vi.setSystemTime(Date.now() + CONTINUATION_WRITING_TTL_MS);
      expect(continuationByToken(opened.token)?.state).toBe('aborted');
      expect(await bindContinuationSourceMessageNow(opened.token, 'exact-user-message', 1000)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { name: 'a pro effort selection', model: 'gpt-6', effort: 'pro', pro: true },
    { name: 'a pro model slug', model: 'gpt-5.6-pro', effort: null, pro: true },
    { name: 'an ordinary model', model: 'gpt-5.6-sol', effort: 'high', pro: false },
    { name: 'an unobserved selection', model: null, effort: null, pro: false }
  ] as const)('uses a retry-safe writing deadline for ordinary and Pro handoff selections ($name)', async ({ model, effort, pro }) => {
    vi.useFakeTimers();
    try {
      const session = await createSession({ title: 'writing deadline identity', conversationId: CHAT_A });
      if (model !== null) await store.observeSessionModel(session.id, CHAT_A, model, 10, effort ?? undefined);
      const opened = await openContinuationNow(session.id, CHAT_A);
      await beginContinuationSourceSendNow(opened.token);
      await dispatchContinuationSourceSendNow(opened.token);
      expect(await bindContinuationSourceMessageNow(opened.token, 'exact-user-message')).toBe(true);

      const sentAt = Date.now();

      // All handoff briefs get time for three five-minute browser pickups. Pro reasoning is not visible transcript growth, so its frozen selection still receives the longer window.
      vi.setSystemTime(sentAt + CONTINUATION_WRITING_TTL_MS - 1);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');
      vi.setSystemTime(sentAt + CONTINUATION_WRITING_TTL_MS + 1);
      expect(continuationByToken(opened.token)?.state).toBe(pro ? 'awaiting-summary' : 'aborted');

      // The Pro writing clock is still a clock: a genuinely silent ticket expires.
      vi.setSystemTime(Date.now() + CONTINUATION_PRO_WRITING_TTL_MS);
      expect(continuationForSession(session.id)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('restores a Pro ticket still inside its writing window instead of dropping it as ancient', async () => {
    vi.useFakeTimers();
    try {
      const session = await createSession({ title: 'pro restore', conversationId: CHAT_A });
      await store.observeSessionModel(session.id, CHAT_A, 'gpt-5.6-pro', 10);
      const opened = await openContinuationNow(session.id, CHAT_A);
      await beginContinuationSourceSendNow(opened.token);
      await dispatchContinuationSourceSendNow(opened.token);
      await bindContinuationSourceMessageNow(opened.token, 'exact-user-message');

      // Past twice the ordinary manual TTL: the restore-time retention window used to drop this record silently even though the live sweep would still have kept it.
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 2 + 1);
      const snapshot = snapshotContinuations();
      resetContinuationsForTests();
      await restoreContinuations(snapshot);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');

      // Past the Pro writing clock after restore, it expires on the same terms as live.
      vi.setSystemTime(Date.now() + CONTINUATION_PRO_WRITING_TTL_MS);
      expect(continuationByToken(opened.token)?.state).toBe('aborted');
    } finally { vi.useRealTimers(); }
  });

  it('returns a captured Pro brief to the ordinary clock for the app-paced phases', async () => {
    vi.useFakeTimers();
    try {
      const session = await createSession({ title: 'pro captured', conversationId: CHAT_A });
      await store.observeSessionModel(session.id, CHAT_A, 'gpt-5.6-pro', 10);
      const opened = await openContinuationNow(session.id, CHAT_A);
      await beginContinuationSourceSendNow(opened.token);
      await dispatchContinuationSourceSendNow(opened.token);
      await bindContinuationSourceMessageNow(opened.token, 'exact-user-message');
      // Twenty minutes of invisible Pro reasoning must not lose the ticket.
      vi.setSystemTime(Date.now() + 20 * 60_000);
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-summary');

      expect(await attachSummary(opened.token, SAMPLE_BRIEF)).not.toBeNull();
      expect(continuationByToken(opened.token)?.state).toBe('awaiting-chat');
      // Opening the replacement is app-paced work; the ordinary ten-minute clock is back.
      vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS + 1);
      expect(continuationByToken(opened.token)?.state).toBe('aborted');
    } finally { vi.useRealTimers(); }
  });
});
