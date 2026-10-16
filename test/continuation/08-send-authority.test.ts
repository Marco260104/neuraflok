import { CHAT_A, CHAT_B, REPLACEMENT_CHAT_CLAIM_WINDOW_MS, SAMPLE_BRIEF, abortContinuation, attachSummary, attachedChat, beginContinuationDestinationSendNow, bindConversation, claimContinuationNow, commitContinuation, continuationForSession, createSession, dir, dispatchContinuationDestinationSendNow, finishAgent, getSession, goalObjectiveFor, openContinuationNow, primeConversation, readyContinuation, recordChatObservations, releaseQuiescentRun, repairPrimeConversationAfterRecovery, repairPrimeFromResumeShadow, resetContinuationsForTests, restoreContinuations, resumeBootstrapText, hasPendingReplacementChat, sessionForConversation, setContinuationRecoveryHooks, setGoalObjective, setWorkspaceFor, snapshotContinuations, spawn, store, swarmRunning, swarmStateForCaller, workspaceEntries } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('the window in which a replacement chat is expected', () => {
  it('keeps an early destination observation with the original session after a slow resume commit', async () => {
    const { sessionId, token } = await readyContinuation();
    const destination = '92929292-1111-4222-8333-444444444444';
    await claimContinuationNow(token, 'slow-resume-command');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const create = vi.spyOn(store, 'createSession');
    const gate = vi.spyOn(await import('../../backend/domains/sessions/continuity/replacement-chat-gate.js'), 'hasPendingReplacementChat');
    const observation = sessionForConversation(destination);
    await vi.waitFor(() => expect(gate.mock.calls.length).toBeGreaterThanOrEqual(2));
    await vi.advanceTimersByTimeAsync(6_000);

    // The command still owns its sixty-second claim. Five seconds without its ACK cannot authorize a second durable session for the destination.
    expect(hasPendingReplacementChat()).toBe(true);
    expect(await commitContinuation(token, destination)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await observation).toBe(sessionId);
    expect(create).not.toHaveBeenCalled();
    expect((await store.findSessionByConversation(destination))?.id).toBe(sessionId);
  });

  it('re-arms the destination ownership gate when Send is dispatched after a long post-claim wait', async () => {
    const { sessionId, token } = await readyContinuation();
    const destination = '93939393-2222-4333-8444-555555555555';
    await claimContinuationNow(token, 'slow-picker-resume-command');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(REPLACEMENT_CHAT_CLAIM_WINDOW_MS + 100);
    expect(hasPendingReplacementChat()).toBe(false);

    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    expect(hasPendingReplacementChat()).toBe(true);

    const create = vi.spyOn(store, 'createSession');
    const observation = sessionForConversation(destination);
    expect(await commitContinuation(token, destination)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await observation).toBe(sessionId);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps the destination ownership gate armed while an already-dispatched resume still awaits its chat id', async () => {
    const { sessionId, token } = await readyContinuation();
    const destination = '94949494-2222-4333-8444-666666666666';
    await claimContinuationNow(token, 'very-slow-resume-command');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(REPLACEMENT_CHAT_CLAIM_WINDOW_MS + 100);

    // Once dispatch is durable, ChatGPT may already hold the bootstrap in a conversation whose id the page still cannot expose. The recorder fence therefore belongs to the dispatched continuation, not to the age of the original browser-opening claim.
    expect(hasPendingReplacementChat()).toBe(true);

    const create = vi.spyOn(store, 'createSession');
    const observation = sessionForConversation(destination);
    expect(await commitContinuation(token, destination)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await observation).toBe(sessionId);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['abort', 'expiry'] as const)('releases unrelated new recording when the resume claim ends by %s', async reason => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'unfinished-resume-command');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const unrelated = reason === 'abort' ? '93939393-1111-4222-8333-444444444444' : '94949494-1111-4222-8333-444444444444';
    const gate = vi.spyOn(await import('../../backend/domains/sessions/continuity/replacement-chat-gate.js'), 'hasPendingReplacementChat');
    const observation = sessionForConversation(unrelated);
    await vi.waitFor(() => expect(gate.mock.calls.length).toBeGreaterThanOrEqual(2));
    if (reason === 'abort') abortContinuation(token, 'cancelled before destination');
    await vi.advanceTimersByTimeAsync(reason === 'expiry' ? REPLACEMENT_CHAT_CLAIM_WINDOW_MS + 100 : 100);
    const sessionId = await observation;
    expect(sessionId).toBeTruthy();
    expect((await getSession(sessionId!))?.conversationId).toBe(unrelated);
    expect(hasPendingReplacementChat()).toBe(false);
  });

  it('is armed by a claim and cleared by the commit', async () => {
    expect(hasPendingReplacementChat()).toBe(false);
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(hasPendingReplacementChat()).toBe(true);

    await commitContinuation(token, CHAT_B);
    expect(await attachedChat(sessionId)).toBe(CHAT_B);
    expect(hasPendingReplacementChat()).toBe(false);
  });

  it('is cleared by an abort as well, so a failed move does not hold new chats up', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(hasPendingReplacementChat()).toBe(true);
    abortContinuation(token, 'gave up');
    expect(hasPendingReplacementChat()).toBe(false);
  });

  it('expires on its own when the replacement chat never appears', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(hasPendingReplacementChat()).toBe(true);
    // A crash between the claim and the commit, or a browser that never opened the tab. Failing to wait costs a visible stub session; waiting forever would stop the app recording new chats at all, so this expires in the safe direction.
    expect(hasPendingReplacementChat(Date.now() + REPLACEMENT_CHAT_CLAIM_WINDOW_MS + 1)).toBe(false);
    expect(hasPendingReplacementChat()).toBe(false);
  });

  it('is not armed by a durable claim whose write failed', async () => {
    const { token } = await readyContinuation();
    const durable = await import('../../backend/persistence/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('disk full'));
    await expect(claimContinuationNow(token, CHAT_B)).rejects.toThrow(/disk full/);
    // Nothing was claimed, so nothing may be waited for. Arming before the write is what would have made every unrelated new chat pay the settle window for a claim that does not exist.
    expect(hasPendingReplacementChat()).toBe(false);
  });

  it('is re-armed for a continuation recovered still holding its claim', async () => {
    const { sessionId, token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    const snapshot = {
      version: 1 as const,
      savedAt: Date.now(),
      entries: [
        {
          token,
          sessionId,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'claimed' as const,
          summary: SAMPLE_BRIEF,
          handoffId: continuationForSession(sessionId)?.handoffId ?? null,
          claimedBy: CHAT_B,
          armed: true,
          error: null
        }
      ]
    };

    // The restart. The claim that armed the gate happened in a process that is gone, and the replacement chat may be sitting in a tab about to report in — which is exactly the restart most likely to hit the collision this exists to prevent.
    resetContinuationsForTests();
    expect(hasPendingReplacementChat()).toBe(false);
    await restoreContinuations(snapshot);
    expect(hasPendingReplacementChat()).toBe(true);
  });

  it('restores a dispatched destination as transaction-owned instead of aging it out after restart', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, 'restart-after-dispatch');
    expect((await beginContinuationDestinationSendNow(token))?.allowed).toBe(true);
    expect(await dispatchContinuationDestinationSendNow(token)).toBe(true);
    const snapshot = snapshotContinuations();

    resetContinuationsForTests();
    await restoreContinuations(snapshot);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(REPLACEMENT_CHAT_CLAIM_WINDOW_MS + 100);

    expect(hasPendingReplacementChat()).toBe(true);
  });

  it('is not re-armed for a continuation that was already finished', async () => {
    const { sessionId, token } = await readyContinuation();
    resetContinuationsForTests();
    await restoreContinuations({
      version: 1 as const,
      savedAt: Date.now(),
      entries: [
        {
          token,
          sessionId,
          from: CHAT_A,
          to: CHAT_B,
          openedAt: Date.now(),
          state: 'aborted' as const,
          summary: SAMPLE_BRIEF,
          handoffId: null,
          claimedBy: CHAT_B,
          armed: true,
          error: 'gave up'
        }
      ]
    });
    expect(hasPendingReplacementChat()).toBe(false);
  });

  it('is cleared by the test reset, so one case cannot slow the next one down', async () => {
    const { token } = await readyContinuation();
    await claimContinuationNow(token, CHAT_B);
    expect(hasPendingReplacementChat()).toBe(true);
    resetContinuationsForTests();
    expect(hasPendingReplacementChat()).toBe(false);
  });

  it('lets the exact app-opened shadow chat recover the prime after the historical collision', async () => {
    const from = '81818181-1111-2222-3333-444444444444';
    const to = '82828282-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'prime before broken resume', conversationId: from });
    setGoalObjective(from, 'finish the release from the replacement chat');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/project', real: dir });
    spawn({ workers: [{ task: 'keep the reusable worker alive' }], caller: { conversationId: from } });
    const opened = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(opened.token, 'resume-shadow-owner');

    // The buggy recorder beat the ACK and stamped B as an app-created resume session. The real continuation then refused to overwrite that session and the bridge durably aborted it.
    await createSession({
      title: 'Resumed · prime before broken resume',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-shadow-bootstrap' }
    ]);
    expect(await commitContinuation(opened.token, to)).toBe(false);
    abortContinuation(opened.token, 'the replacement chat already belongs to another local session');
    expect(primeConversation()).toBe(from);
    expect(goalObjectiveFor(from)).toBe('finish the release from the replacement chat');

    // A random recorded conversation is not repair authority. In particular it cannot steal the objective/workspace just because some other resume attempt from A once collided.
    const unrelated = '83838383-1111-2222-3333-444444444444';
    await createSession({ title: 'ordinary unrelated chat', conversationId: unrelated });
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(unrelated)).toBe(false);
    expect(goalObjectiveFor(from)).toBe('finish the release from the replacement chat');
    expect(goalObjectiveFor(unrelated)).toBe('');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([`chat:${from}`]);

    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(primeConversation()).toBe(to);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(to)).toBe('finish the release from the replacement chat');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([`chat:${to}`]);

    // The broker hook itself intentionally treats an already-satisfied replay as success. The resume-shadow wrapper reports actual projection changes, so a later browser poll is a no-op.
    expect(await repairPrimeFromResumeShadow(to)).toBe(false);

    // Same-origin-looking data without the exact authored bootstrap is not takeover authority.
    const stranger = '84848484-1111-2222-3333-444444444444';
    await createSession({
      title: 'unrelated resume-looking chat',
      conversationId: stranger,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    expect(await repairPrimeFromResumeShadow(stranger)).toBe(false);
    expect(primeConversation()).toBe(to);
  });

  it('counts two concurrent exact-shadow repair attempts as one mutation', async () => {
    const from = '81818181-aaaa-bbbb-cccc-444444444444';
    const to = '82828282-aaaa-bbbb-cccc-444444444444';
    const source = await createSession({ title: 'prime before concurrent shadow repair', conversationId: from });
    spawn({ workers: [{ task: 'keep ownership alive during the concurrent repair' }], caller: { conversationId: from } });
    const opened = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(opened.token, 'concurrent-shadow-owner');
    await createSession({
      title: 'Resumed · prime before concurrent shadow repair',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-concurrent-shadow' }
    ]);
    expect(await commitContinuation(opened.token, to)).toBe(false);
    abortContinuation(opened.token, 'the replacement chat already belongs to another local session');
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

    const results = await Promise.all([repairPrimeFromResumeShadow(to), repairPrimeFromResumeShadow(to)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(primeConversation()).toBe(to);
  });

  it('repairs a stranded Goal onto the current descendant of an aged-out resume shadow', async () => {
    const from = '85858585-1111-2222-3333-444444444444';
    const shadowChat = '86868686-1111-2222-3333-444444444444';
    const currentChat = '87878787-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source before old shadow collision', conversationId: from });
    setGoalObjective(from, 'finish the release on the current resumed descendant');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/project', real: dir });
    spawn({ workers: [{ task: 'survive long enough for the old WAL to age out' }], caller: { conversationId: from } });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'old-shadow-owner');
    const shadow = await createSession({
      title: 'Resumed · source before old shadow collision',
      conversationId: shadowChat,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(shadowChat, [
      {
        kind: 'user_message',
        time: Date.now(),
        text: resumeBootstrapText(handoff!.text).replace('previous chat', `previous\u00c2\u00a0chat`),
        messageId: 'm-old-shadow-bootstrap'
      }
    ]);
    expect(await commitContinuation(broken.token, shadowChat)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    // Model the exact live history: the old collision proof has aged out, but the shadow session itself later completed a normal Compact & Resume B→C and kept its original resume origin.
    resetContinuationsForTests();
    const descendant = await openContinuationNow(shadow.id, shadowChat);
    await attachSummary(descendant.token, SAMPLE_BRIEF);
    await claimContinuationNow(descendant.token, 'shadow-descendant-owner');
    expect(await commitContinuation(descendant.token, currentChat)).toBe(true);
    expect((await getSession(shadow.id))?.chatIds).toEqual([shadowChat, currentChat]);
    expect((await getSession(shadow.id))?.origin).toMatchObject({ kind: 'resume', fromSessionId: source.id });
    expect(goalObjectiveFor(from)).toBe('finish the release on the current resumed descendant');
    expect(goalObjectiveFor(shadowChat)).toBe('');
    expect(goalObjectiveFor(currentChat)).toBe('');

    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(currentChat)).toBe(true);
    expect(primeConversation()).toBe(currentChat);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(shadowChat)).toBe('');
    expect(goalObjectiveFor(currentChat)).toBe('finish the release on the current resumed descendant');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([
      `chat:${currentChat}`
    ]);
  });

  it('does not use a resume origin alone to repair an aged-out shadow without the exact bootstrap', async () => {
    const from = '88888888-1111-2222-3333-444444444444';
    const to = '89898989-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source with an uncommitted handoff', conversationId: from });
    setGoalObjective(from, 'do not let an unrelated resume-looking chat steal this');
    spawn({ workers: [{ task: 'keep prime ownership available for the negative check' }], caller: { conversationId: from } });
    const broken = await openContinuationNow(source.id, from);
    await attachSummary(broken.token, SAMPLE_BRIEF);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');
    await createSession({
      title: 'resume-looking but not the handoff recipient',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: 'some other user text', messageId: 'm-not-the-bootstrap' }
    ]);

    resetContinuationsForTests();
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(false);
    expect(primeConversation()).toBe(from);
    expect(goalObjectiveFor(from)).toBe('do not let an unrelated resume-looking chat steal this');
    expect(goalObjectiveFor(to)).toBe('');
  });

  it('preserves newer Goal and workspace state already learned by an exact resumed descendant', async () => {
    const from = '8a8a8a8a-1111-2222-3333-444444444444';
    const to = '8b8b8b8b-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source whose old projections are stranded', conversationId: from });
    setGoalObjective(from, 'older goal stranded on A');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/older', real: dir });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'projection-shadow-owner');
    await createSession({
      title: 'Resumed · source whose old projections are stranded',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-projection-bootstrap' }
    ]);
    expect(await commitContinuation(broken.token, to)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    // The user kept working in B/C before upgrading. Late historical healing must never replace those newer target-owned choices with stale A state; it only removes A's stale projections.
    setGoalObjective(to, 'newer goal already chosen in the resumed chat');
    setWorkspaceFor(`chat:${to}`, { virtual: '/workspace/newer', real: dir });
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(to)).toBe('newer goal already chosen in the resumed chat');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:'))).toEqual([
      { key: `chat:${to}`, virtual: '/workspace/newer' }
    ]);
  });

  it('finishes missing projection repair when the same old run already moved its prime ownership to the shadow', async () => {
    const from = '8c8c8c8c-1111-2222-3333-444444444444';
    const to = '8d8d8d8d-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'source with separately repaired ownership', conversationId: from });
    setGoalObjective(from, 'goal still stranded after ownership repaired first');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/same-run', real: dir });
    spawn({ workers: [{ task: 'prove this is the same live run' }], caller: { conversationId: from } });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'same-run-shadow-owner');
    await createSession({
      title: 'Resumed · source with separately repaired ownership',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-same-run-bootstrap' }
    ]);
    expect(await commitContinuation(broken.token, to)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    // This models the exact live machine: old code/another recovery path already repaired only swarm ownership A→B/C, while Goal/workspace stayed on A. Source A is no longer an owner.
    expect(repairPrimeConversationAfterRecovery(from, to)).toBe(true);
    expect(primeConversation()).toBe(to);
    expect(goalObjectiveFor(from)).toBe('goal still stranded after ownership repaired first');

    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(true);
    expect(primeConversation()).toBe(to);
    expect(goalObjectiveFor(from)).toBe('');
    expect(goalObjectiveFor(to)).toBe('goal still stranded after ownership repaired first');
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key)).toEqual([`chat:${to}`]);
  });

  it('refuses to merge an old parked prime into the same shadow chat after that chat starts an independent fresh run', async () => {
    const from = '8e8e8e8e-1111-2222-3333-444444444444';
    const to = '8f8f8f8f-1111-2222-3333-444444444444';
    const source = await createSession({ title: 'old parked owner before shadow', conversationId: from });
    setGoalObjective(from, 'old parked goal must stay isolated');
    setWorkspaceFor(`chat:${from}`, { virtual: '/workspace/old-owner', real: dir });
    spawn({ workers: [{ task: 'park this old owner before a fresh run starts' }], caller: { conversationId: from } });

    const broken = await openContinuationNow(source.id, from);
    const handoff = await attachSummary(broken.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    await claimContinuationNow(broken.token, 'independent-run-shadow-owner');
    await createSession({
      title: 'Resumed · old parked owner before shadow',
      conversationId: to,
      origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
    });
    await recordChatObservations(to, [
      { kind: 'user_message', time: Date.now(), text: resumeBootstrapText(handoff!.text), messageId: 'm-independent-bootstrap' }
    ]);
    expect(await commitContinuation(broken.token, to)).toBe(false);
    abortContinuation(broken.token, 'the replacement chat already belongs to another local session');

    expect(bindConversation('worker-1', 'worker-old-owner')).toBe(true);
    finishAgent({ conversationId: 'worker-old-owner' }, 'park the old owner now');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // C later begins a distinct run while A's complete history remains parked. PRIME on both conversations proves these are two owners, even though C still has the genuine old bootstrap.
    spawn({ workers: [{ task: 'fresh independent run in the descendant chat' }], caller: { conversationId: to } });
    expect(primeConversation()).toBe(to);
    setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });
    expect(await repairPrimeFromResumeShadow(to)).toBe(false);
    expect(goalObjectiveFor(from)).toBe('old parked goal must stay isolated');
    expect(goalObjectiveFor(to)).toBe('');
    // Workers now retain their exact conversation workspace while sleeping; the unrelated descendant must still receive neither the old prime nor its worker workspace.
    expect(workspaceEntries().filter((held) => held.key.startsWith('chat:')).map((held) => held.key).sort()).toEqual([`chat:${from}`, 'chat:worker-old-owner'].sort());
    expect(swarmStateForCaller({ conversationId: from }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      conversationId: 'worker-old-owner',
      state: 'sleeping'
    });
  });
});
