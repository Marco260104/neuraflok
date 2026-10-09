import { CHAT_A, CHAT_B, CHAT_C, attachedChat, beginContinuationDestinationSendNow, bindContinuationDestinationMessageNow, claimContinuationNow, commitContinuation, continuationByToken, continuationForSession, dir, dispatchContinuationDestinationSendNow, getSession, goalObjectiveFor, goalPendingReplyFor, goalSwitchFor, readyContinuation, releaseContinuationDestinationSendNow, repairPrimeConversationAfterRecovery, restoreContinuations, restoreGoalReplies, sessionForConversation, setContinuationRecoveryHooks, setGoalObjective, setGoalSwitchNow, setWorkspaceFor, snapshotContinuations, store, workspaceEntries } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('committing', () => {
  it('moves the session, its history, workspace and saved Goal objective together', async () => {
    const { sessionId, token } = await readyContinuation();
    const before = await sessionForConversation(CHAT_A);
    expect(before).toBe(sessionId);
    setWorkspaceFor(`chat:${CHAT_A}`, { virtual: '/workspace/project', real: dir });
    setGoalObjective(CHAT_A, 'finish the overnight release');
    await setGoalSwitchNow(CHAT_A, 'loop', true, true);
    restoreGoalReplies({ version: 1, savedAt: Date.now(), replies: [{ conversationId: CHAT_A,
      sessionId, replyId: 'source-final', turnId: 'source-turn', eventSeq: 1, acceptedAt: Date.now(), state: 'pending' }] });
    await claimContinuationNow(token, 'tab-1');
    const committedHandoffId = continuationForSession(sessionId)?.handoffId;

    expect(await commitContinuation(token, CHAT_B)).toBe(true);

    const moved = await getSession(sessionId);
    expect(moved?.conversationId).toBe(CHAT_B);
    expect(moved?.lastCommittedResumeHandoffId).toBe(committedHandoffId);
    // Same durable session, with chat A kept as lineage rather than replaced.
    expect(moved?.chatIds).toEqual([CHAT_A, CHAT_B]);
    // The context meter is per attached chat, or the next turn would re-compact immediately.
    expect(moved?.contextTokens).toBe(0);
    expect(await sessionForConversation(CHAT_B)).toBe(sessionId);
    expect(workspaceEntries().map((held) => held.key)).toEqual([`chat:${CHAT_B}`]);
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('finish the overnight release');
    expect(goalSwitchFor(CHAT_B)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
    expect(goalSwitchFor(CHAT_A).own).toBe(false);
    expect(goalPendingReplyFor(CHAT_A)).toBeNull();
    expect(goalPendingReplyFor(CHAT_B)).toBeNull();
    // An app start replays this committed handoff. With the broker's hooks installed, as the app installs them, a chat that never led sub-agents has nothing to warn about (2026-10-06: every start warned "recovered without a broker prime repair hook" per kept handoff).
    const { getLog } = await import('../../backend/infrastructure/settings/logger.js');
    const { primeFleetIn } = await import('../../backend/domains/automation/agents.js');
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery, hasPrimeFleet: primeFleetIn });
    const logged = getLog().length;
    await restoreContinuations(snapshotContinuations());
    expect(getLog().slice(logged).filter(entry => /prime repair hook|fleet is still led/.test(entry.message))).toEqual([]);
    expect(goalSwitchFor(CHAT_B)).toMatchObject({ enabled: true, mode: 'loop', afterTurn: true });
  });

  it('refuses a chat B that is not a distinct conversation', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(await commitContinuation(token, '')).toBe(false);
    expect(await commitContinuation(token, CHAT_A)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
  });

  it('leaves the session in chat A when the durable write fails, and stays retryable', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    const committedHandoffId = continuationForSession(sessionId)?.handoffId;
    const spy = vi.spyOn(store, 'rebindSession').mockResolvedValueOnce(false);

    expect(await commitContinuation(token, CHAT_B)).toBe(false);
    expect(await attachedChat(sessionId)).toBe(CHAT_A);
    expect((await getSession(sessionId))?.lastCommittedResumeHandoffId).toBeNull();
    expect(continuationForSession(sessionId)?.state).toBe('claimed');
    expect(workspaceEntries()).toEqual([]);

    spy.mockRestore();
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
    expect((await getSession(sessionId))?.lastCommittedResumeHandoffId).toBe(committedHandoffId);
  });

  it('treats a repeated ack as the commit that already landed', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect((await getSession(sessionId))?.chatIds).toEqual([CHAT_A, CHAT_B]);
  });

  it('records the sent resume message of the committed chat when its first call committed first', async () => {
    // 2026-09-30, live: B's first attributed tool call committed the resume 50 ms before the page reported the message it typed, and the report was refused as a conflict. Without it the feed knows no resume boundary, and A's reload notice sat above B's first message.
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);

    expect(await bindContinuationDestinationMessageNow(token, CHAT_A, 'resume-message-b')).toBe(false);
    expect(await bindContinuationDestinationMessageNow(token, 'some-other-chat', 'resume-message-b')).toBe(false);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'resume-message-b')).toBe(true);
    expect(continuationByToken(token)).toMatchObject({
      state: 'committed',
      destinationSend: { state: 'sent', conversationId: CHAT_B, messageId: 'resume-message-b' }
    });
    // Once recorded it is the proof, and a different message is still a conflict.
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'another-message')).toBe(false);
  });

  it('hands an armed replacement dispatch back on proof that nothing left the page, never once sent', async () => {
    // 2026-09-02: the brief landed in the replacement chat and the user's Escape emptied the composer in the same instant. The armed dispatch then sat for its six hours.
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(false);

    expect(await releaseContinuationDestinationSendNow(token)).toBe(true);
    expect(continuationByToken(token)).toMatchObject({
      state: 'awaiting-chat',
      destinationSend: { state: 'not-attempted' }
    });
    // A fresh command claims what the retired one held; the release is what makes that legal.
    expect(await claimContinuationNow(token, 'cmd-2')).not.toBeNull();
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'resume-message-b')).toBe(true);
    // Sent is past the point of no return: the marked message or a cancel ends it, not a page.
    expect(await releaseContinuationDestinationSendNow(token)).toBe(false);
    expect(continuationByToken(token)?.destinationSend.state).toBe('sent');
    expect(await releaseContinuationDestinationSendNow('0000000000000000000000000000dead')).toBe(false);
  });

  it.each(['unattempted', 'attempted', 'dispatched', 'sent'])('command retirement only releases its own unattempted claim (%s)', async state => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'old-command');
    expect(await releaseContinuationDestinationSendNow(token, 'foreign-command')).toBe(false);
    if (state !== 'unattempted') await beginContinuationDestinationSendNow(token);
    if (state === 'dispatched' || state === 'sent') await dispatchContinuationDestinationSendNow(token);
    if (state === 'sent') await bindContinuationDestinationMessageNow(token, CHAT_B, 'exact-resume-message');
    const before = snapshotContinuations();
    expect(await releaseContinuationDestinationSendNow(token, 'old-command')).toBe(state === 'unattempted');
    if (state === 'unattempted') {
      expect(await claimContinuationNow(token, 'new-command')).not.toBeNull();
      expect(await releaseContinuationDestinationSendNow(token, 'old-command')).toBe(false);
      expect(snapshotContinuations().entries.find(row => row.token === token)?.claimedBy).toBe('new-command');
    } else expect(snapshotContinuations().entries).toEqual(before.entries);
  });

  it('retains the old claimant when retiring its claim cannot be saved', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'old-command');
    const durable = await import('../../backend/persistence/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
    await expect(releaseContinuationDestinationSendNow(token, 'old-command')).rejects.toThrow('disk full');
    expect(snapshotContinuations().entries.find(row => row.token === token)?.claimedBy).toBe('old-command');
    expect(await claimContinuationNow(token, 'new-command')).toBeNull();
  });

  it('re-proves the exact destination message after the continuation already committed', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'resume-message-b')).toBe(true);
    expect(await commitContinuation(token, CHAT_B)).toBe(true);

    // A reloaded replacement document has lost its page-local proof, but the WAL still names the exact message that committed B. Reading that exact tuple back is safe and idempotent; any other chat or message remains a contradiction.
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'resume-message-b')).toBe(true);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_C, 'resume-message-b')).toBe(false);
    expect(await bindContinuationDestinationMessageNow(token, CHAT_B, 'other-message')).toBe(false);
  });
});
