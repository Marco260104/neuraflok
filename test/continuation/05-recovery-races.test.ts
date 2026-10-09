import { CHAT_A, CHAT_B, CHAT_C, CONTINUATION_TTL_MS, CONTINUATION_WRITING_TTL_MS, SAMPLE_BRIEF, WORKER_CONTEXT_CEILING_TOKENS, attachSummary, attachedChat, beginPrimeTransfer, bindConversation, cancelPrimeTransfer, claimContinuationNow, commitContinuation, commitPrimeTransfer, continuationByToken, continuationForSession, createSession, finishAgent, freezePrimeTransfer, getSession, goalObjectiveFor, noteAgentContextTokens, openContinuationNow, pendingWorkerRevivals, primeConversation, primeConversationGone, readyContinuation, releaseQuiescentRun, repairPrimeConversationAfterRecovery, resetAgentsForTests, resetContinuationsForTests, resetGoalStateForTests, restoreContinuations, restoreSwarm, sendMessage, setContinuationRecoveryHooks, setGoalObjective, snapshotContinuations, snapshotSwarm, spawn, store, swarmRunning, swarmStateForCaller, thawPrimeTransfer } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('the swarm handover', () => {
  const startSwarm = (conversationId: string): void => {
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId } });
  };

  it('moves a parked prime worker history to the replacement chat and revives the exact old worker', async () => {
    const summary = await createSession({ title: 'parked reusable workers', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    expect(bindConversation('worker-1', 'worker-history-chat')).toBe(true);
    finishAgent({ conversationId: 'worker-history-chat' }, 'first piece complete');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-history-chat'
    });

    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'replacement-tab');
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);

    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-history-chat'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);

    sendMessage({ conversationId: CHAT_B }, 'worker-1', 'continue from the exact chat you already know');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: 'worker-history-chat' })
    ]);
  });

  it('carries the same Goal and dormant worker history through repeated overnight resumptions', async () => {
    const summary = await createSession({ title: 'overnight chain', conversationId: CHAT_A });
    setGoalObjective(CHAT_A, 'finish every requested release task overnight');
    startSwarm(CHAT_A);
    expect(bindConversation('worker-1', 'worker-overnight-chat')).toBe(true);
    finishAgent({ conversationId: 'worker-overnight-chat' }, 'sleep until the prime needs me again');
    expect(releaseQuiescentRun()).toBe(true);

    const first = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(first.token, SAMPLE_BRIEF);
    await claimContinuationNow(first.token, 'replacement-tab-b');
    expect(await commitContinuation(first.token, CHAT_B)).toBe(true);
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('finish every requested release task overnight');
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-overnight-chat'
    });

    const second = await openContinuationNow(summary.id, CHAT_B);
    await attachSummary(second.token, SAMPLE_BRIEF);
    await claimContinuationNow(second.token, 'replacement-tab-c');
    expect(await commitContinuation(second.token, CHAT_C)).toBe(true);

    expect(goalObjectiveFor(CHAT_B)).toBe('');
    expect(goalObjectiveFor(CHAT_C)).toBe('finish every requested release task overnight');
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents).toEqual([]);
    expect(swarmStateForCaller({ conversationId: CHAT_C }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-overnight-chat'
    });

    sendMessage({ conversationId: CHAT_C }, 'worker-1', 'wake after the second resume');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: 'worker-overnight-chat' })
    ]);
  });

  it('repairs parked worker ownership after a crash between durable session move and projection publish', async () => {
    const summary = await createSession({ title: 'parked crash recovery', conversationId: CHAT_A });
    setGoalObjective(CHAT_A, 'keep the recovery objective attached to this work');
    spawn({
      workers: [{ task: 'reusable recovery history' }, { task: 'terminal recovery history' }],
      caller: { conversationId: CHAT_A }
    });
    expect(bindConversation('worker-1', 'worker-recovery-chat')).toBe(true);
    expect(bindConversation('worker-2', 'worker-recovery-terminal')).toBe(true);
    finishAgent({ conversationId: 'worker-recovery-chat' }, 'ready for later reuse');
    noteAgentContextTokens('worker-recovery-terminal', WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: 'worker-recovery-terminal' }, 'terminal before crash');
    expect(releaseQuiescentRun()).toBe(true);
    const swarmSnapshot = snapshotSwarm()!;

    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'replacement-tab');
    const continuationSnapshot = snapshotContinuations();
    const saved = continuationSnapshot.entries.find((entry) => entry.token === opened.token)!;
    saved.state = 'committing';
    saved.to = CHAT_B;

    // This is the exact crash boundary continuation recovery is designed for: durable session authority already says B, but the in-memory worker ownership projection still says A.
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);
    expect((await getSession(summary.id))?.lastCommittedResumeHandoffId).toBeNull();
    resetAgentsForTests();
    restoreSwarm(swarmSnapshot);
    resetGoalStateForTests();
    // This suite deliberately uses short synthetic chat ids (`chat-a`/`chat-b`) that the Goal persistence validator would reject as unlike real ChatGPT ids. Goal's own restart test covers durable decode with a valid id; seed the equivalent restored A projection here so this integration test isolates the continuation recovery move A→B.
    setGoalObjective(CHAT_A, 'keep the recovery objective attached to this work');
    resetContinuationsForTests();
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

    await restoreContinuations(continuationSnapshot);

    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect((await getSession(summary.id))?.lastCommittedResumeHandoffId).toBe(saved.handoffId);
    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-recovery-chat'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'worker-recovery-terminal'
    });
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('keep the recovery objective attached to this work');
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);
  });

  it('carries the full sleeping and terminal worker history plus Goal through repeated overnight resumes', async () => {
    const summary = await createSession({ title: 'overnight owner chain', conversationId: CHAT_A });
    spawn({
      workers: [{ task: 'reusable history' }, { task: 'terminal history' }],
      caller: { conversationId: CHAT_A }
    });
    expect(bindConversation('worker-1', 'worker-chain-sleeper')).toBe(true);
    expect(bindConversation('worker-2', 'worker-chain-terminal')).toBe(true);
    finishAgent({ conversationId: 'worker-chain-sleeper' }, 'sleep and reuse me later');
    noteAgentContextTokens('worker-chain-terminal', WORKER_CONTEXT_CEILING_TOKENS);
    finishAgent({ conversationId: 'worker-chain-terminal' }, 'this chat is genuinely full');
    expect(releaseQuiescentRun()).toBe(true);
    setGoalObjective(CHAT_A, 'finish the overnight release without losing any requested work');

    const move = async (from: string, to: string, claimant: string): Promise<void> => {
      const opened = await openContinuationNow(summary.id, from);
      await attachSummary(opened.token, SAMPLE_BRIEF);
      await claimContinuationNow(opened.token, claimant);
      expect(await commitContinuation(opened.token, to)).toBe(true);
    };

    await move(CHAT_A, CHAT_B, 'overnight-tab-b');
    expect(goalObjectiveFor(CHAT_A)).toBe('');
    expect(goalObjectiveFor(CHAT_B)).toBe('finish the overnight release without losing any requested work');
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-chain-sleeper'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'worker-chain-terminal'
    });

    await move(CHAT_B, CHAT_C, 'overnight-tab-c');
    expect(goalObjectiveFor(CHAT_B)).toBe('');
    expect(goalObjectiveFor(CHAT_C)).toBe('finish the overnight release without losing any requested work');
    const finalHistory = swarmStateForCaller({ conversationId: CHAT_C }).agents;
    expect(finalHistory.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'worker-chain-sleeper'
    });
    expect(finalHistory.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'worker-chain-terminal'
    });
    expect(swarmStateForCaller({ conversationId: CHAT_A }).agents).toEqual([]);
    expect(swarmStateForCaller({ conversationId: CHAT_B }).agents).toEqual([]);

    // Revival authority follows the owner chain but the worker conversation itself never moves.
    sendMessage({ conversationId: CHAT_C }, 'worker-1', 'resume in the exact old worker chat');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: 'worker-chain-sleeper' })
    ]);
    expect(() => sendMessage({ conversationId: CHAT_C }, 'worker-2', 'do not revive terminal history')).toThrow(
      /finished|cannot be messaged|context/i
    );
  });

  it('moves the prime with the session', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('commits a handover however long the handoff turn took', async () => {
    // 2026-09-01: an automatic compaction opened its continuation, the handoff turn then took eleven minutes to produce the brief, and the swarm handover — which had a ten-minute clock of its own — was already expired when the replacement chat committed. The commit was refused with a perfectly live continuation, and the session was stranded between A and B. The handover has no clock now: the continuation is the only authority over it.
    vi.useFakeTimers();
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A, true);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');
    vi.setSystemTime(Date.now() + 60_000);

    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    expect(await commitContinuation(opened.token, CHAT_B)).toBe(true);
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect(primeConversation()).toBe(CHAT_B);
  });

  it('refuses the whole commit when the prime session has no usable handover', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    startSwarm(CHAT_A);
    const opened = await openContinuationNow(summary.id, CHAT_A);
    await attachSummary(opened.token, SAMPLE_BRIEF);
    await claimContinuationNow(opened.token, 'tab-1');

    // The handover is gone while the continuation itself is still perfectly live — so the refusal below can only be the swarm preflight, never generic expiry. (In production this is the run ending, or being reset, between the button and the new chat.)
    cancelPrimeTransfer(CHAT_A);
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');

    expect(await commitContinuation(opened.token, CHAT_B)).toBe(false);
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
    expect(primeConversation()).toBe(CHAT_A);
    // Refused before anything was written: still claimable, and its error says why.
    expect(continuationForSession(summary.id)?.state).toBe('claimed');
    expect(continuationForSession(summary.id)?.error).toMatch(/handover/);
  });

  it('commits a session that owns no swarm at all', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, 'tab-1');

    expect(freezePrimeTransfer(CHAT_A)).toBe('absent');
    expect(await commitContinuation(token, CHAT_B)).toBe(true);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
  });

  it('keeps reusable workers attached to the run across an ordinary prime pause and a handover', async () => {
    startSwarm(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);

    resetAgentsForTests();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
  });

  it('keeps a handover open until the continuation commits or cancels it', () => {
    vi.useFakeTimers();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    // Frozen means committed-to: the move cannot decline.
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(commitPrimeTransfer(CHAT_A, CHAT_B)).toBe(true);
    expect(primeConversation()).toBe(CHAT_B);

    resetAgentsForTests();
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    thawPrimeTransfer(CHAT_A);
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    // A thawed handover is still open, however long ago it was opened.
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(freezePrimeTransfer(CHAT_A)).toBe('frozen');
    thawPrimeTransfer(CHAT_A);
    // Only the continuation ends it.
    cancelPrimeTransfer(CHAT_A);
    expect(freezePrimeTransfer(CHAT_A)).toBe('unavailable');
  });

  it('will not hand a swarm to a chat that is not the one being replaced', () => {
    startSwarm(CHAT_A);
    beginPrimeTransfer(CHAT_A);

    expect(commitPrimeTransfer('someone-else', CHAT_B)).toBe(false);
    expect(primeConversation()).toBe(CHAT_A);
  });

  it('does not revive an already-expired waiting continuation after restart', async () => {
    vi.useFakeTimers();
    const openedAt = Date.now();
    const summary = await createSession({ title: 'expired restore', conversationId: CHAT_A });
    spawn({ workers: [{ task: 'read the tests' }], caller: { conversationId: CHAT_A } });

    vi.setSystemTime(openedAt + CONTINUATION_WRITING_TTL_MS + 1);
    await restoreContinuations({
      version: 1,
      savedAt: openedAt,
      entries: [
        {
          token: 'expired-wait-token',
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt,
          state: 'awaiting-summary',
          summary: '',
          handoffId: null,
          claimedBy: null,
          armed: false,
          error: null
        }
      ]
    });

    // Recovery must not mint a fresh transfer lease for a transaction whose writing deadline already elapsed. The reusable worker run is independent of that expired continuation, so losing the prime browser view pauses the run rather than destroying it.
    expect(continuationByToken('expired-wait-token')).toBeNull();
    expect(primeConversationGone(CHAT_A)).toBe(false);
    expect(swarmRunning()).toBe(true);
  });

  it('keeps an automatic ticket open past ordinary continuation deadlines and restart', async () => {
    vi.useFakeTimers();
    const summary = await createSession({ title: 'durable auto ticket', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A, true);
    const saved = snapshotContinuations();

    vi.setSystemTime(Date.now() + CONTINUATION_TTL_MS * 6);
    expect(continuationByToken(opened.token)).toMatchObject({
      state: 'awaiting-summary',
      automatic: true
    });

    resetContinuationsForTests();
    await restoreContinuations(saved);
    expect(continuationByToken(opened.token)).toMatchObject({
      state: 'awaiting-summary',
      automatic: true
    });
  });
});
