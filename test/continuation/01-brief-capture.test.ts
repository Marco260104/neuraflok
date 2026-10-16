import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CHAT_A, CHAT_B, CHAT_C, SAMPLE_BRIEF, abortContinuationNow, abortContinuationSourceBeforeSendNow, attachSummary, attachedChat, beginContinuationSourceSendNow, bindContinuationSourceMessageNow, claimContinuationNow, continuationByToken, continuationForSession, createSession, dispatchContinuationSourceSendNow, getSession, handoffContinuationId, handoffCount, openContinuationNow, prepareHandoff, readyContinuation, resetContinuationsForTests, resetSessionStoreForTests, restoreContinuations, sessionsRoot, snapshotContinuations, store } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('capturing the brief', () => {
  it('freezes exact source model intent across selection changes and durable restore', async () => {
    const summary = await createSession({ title: 'model transfer', conversationId: CHAT_A });
    await store.observeSessionModel(summary.id, CHAT_A, 'gpt-5.6-sol', 10, 'high');
    const opened = await openContinuationNow(summary.id, CHAT_A);
    expect(opened.requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    opened.requestedModel!.model = 'caller-mutated';
    await store.observeSessionModel(summary.id, CHAT_A, 'gpt-6-astra', 20, 'ultra');
    expect((await openContinuationNow(summary.id, CHAT_A)).requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    const snapshot = snapshotContinuations();
    resetContinuationsForTests();
    await restoreContinuations(snapshot);
    expect(continuationByToken(opened.token)?.requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
  });

  it('does not borrow selection from another conversation or invent missing effort', async () => {
    const summary = await createSession({ title: 'source evidence', conversationId: CHAT_A });
    await store.observeSessionModel(summary.id, CHAT_A, 'gpt-5.6-sol', 10);
    expect((await openContinuationNow(summary.id, CHAT_A)).requestedModel).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: null });
    resetContinuationsForTests();
    await store.rebindSession(summary.id, CHAT_A, CHAT_B);
    expect((await openContinuationNow(summary.id, CHAT_B)).requestedModel).toBeNull();
  });

  it.each([undefined, { model: '<invalid>', reasoningEffort: 'high' }, { model: 'gpt-5.6-sol', reasoningEffort: 'invented' }])(
    'keeps legacy or invalid restored model intent unknown (%j)', async requestedModel => {
      const { token } = await readyContinuation();
      const snapshot = snapshotContinuations();
      Object.assign(snapshot.entries[0]!, { requestedModel });
      resetContinuationsForTests();
      await restoreContinuations(snapshot);
      expect(continuationByToken(token)?.requestedModel).toBeNull();
    }
  );

  it('keeps a pre-send automatic refusal across restart, scoped to its original turn', async () => {
    const summary = await createSession({ title: 'refused turn', conversationId: CHAT_A });
    await store.appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 'refused' });
    const ticket = await openContinuationNow(summary.id, CHAT_A, true);
    expect(await abortContinuationSourceBeforeSendNow(ticket.token, 'handoff_never_sent')).toBe(true);
    await store.flushSessions();
    await resetSessionStoreForTests();
    const restored = (await getSession(summary.id))!;
    expect(store.autoCompactionReady({ ...restored, contextTokens: 1_000_000 })).toBe(false);
    await store.appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_start', turnId: 'next' });
    expect(store.autoCompactionReady({ ...(await getSession(summary.id))!, contextTokens: 1_000_000 })).toBe(true);
  });

  it.each([false, true])('keeps an explicit automatic cancellation after a handoff turn across restart (handoff=%s)', async handoffStarted => {
    const summary = await createSession({ title: 'cancel automatic handoff', conversationId: CHAT_A });
    await store.appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 'work' });
    const ticket = await openContinuationNow(summary.id, CHAT_A, true);
    if (handoffStarted) {
      await beginContinuationSourceSendNow(ticket.token);
      await dispatchContinuationSourceSendNow(ticket.token);
      await bindContinuationSourceMessageNow(ticket.token, 'handoff-message');
      await store.appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_start', turnId: 'handoff' });
    }
    expect(await abortContinuationNow(ticket.token, 'cancelled')).toBe(true);
    expect(await dispatchContinuationSourceSendNow(ticket.token)).toBe(false);
    await store.flushSessions();
    await resetSessionStoreForTests();
    const restored = (await getSession(summary.id))!;
    expect(restored.autoCompactionRefusal).toMatchObject({ conversationId: CHAT_A, turnId: handoffStarted ? 'handoff' : 'work' });
    expect(store.autoCompactionReady({ ...restored, contextTokens: 1_000_000 })).toBe(false);
    await store.appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', turnId: handoffStarted ? 'handoff' : 'work', outcome: 'completed' });
    expect(store.autoCompactionReady({ ...(await getSession(summary.id))!, contextTokens: 1_000_000 })).toBe(false);
    await store.appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_start', turnId: 'new-request' });
    expect(store.autoCompactionReady({ ...(await getSession(summary.id))!, contextTokens: 1_000_000 })).toBe(true);
  });

  it('does not add an automatic refusal when cancelling a manual handoff', async () => {
    const { sessionId, token } = await readyContinuation();
    expect(await abortContinuationNow(token, 'cancelled')).toBe(true);
    expect((await getSession(sessionId))?.autoCompactionRefusal).toBeUndefined();
  });

  it('retains the automatic ticket if its cancellation refusal cannot be persisted', async () => {
    const summary = await createSession({ title: 'cancel write failure', conversationId: CHAT_A });
    const ticket = await openContinuationNow(summary.id, CHAT_A, true);
    vi.spyOn(store, 'refuseAutomaticCompactionNow').mockRejectedValueOnce(new Error('disk full'));
    await expect(abortContinuationNow(ticket.token, 'cancelled')).rejects.toThrow('disk full');
    expect(continuationForSession(summary.id)?.token).toBe(ticket.token);
    expect(await abortContinuationNow(ticket.token, 'cancelled')).toBe(true);
  });

  it('does not let a late handoff write revive a cancelled continuation', async () => {
    const summary = await createSession({ title: 'late handoff', conversationId: CHAT_A });
    const ticket = await openContinuationNow(summary.id, CHAT_A);
    const handoffs = await import('../../backend/domains/sessions/continuity/handoff.js');
    const prepare = handoffs.prepareHandoff;
    let entered = false;
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(handoffs, 'prepareHandoff').mockImplementationOnce(async input => {
      entered = true;
      await held;
      return prepare(input);
    });
    const capture = attachSummary(ticket.token, SAMPLE_BRIEF);
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await abortContinuationNow(ticket.token, 'cancelled')).toBe(true);
    release();
    expect(await capture).toBeNull();
    expect(continuationByToken(ticket.token)).toMatchObject({ state: 'aborted', handoffId: null });
    expect(await claimContinuationNow(ticket.token, 'late-page')).toBeNull();
  });

  it('aborts only while the source checkpoint still proves no prompt was sent', async () => {
    const untouched = await createSession({ title: 'untouched source', conversationId: CHAT_A });
    const untouchedContinuation = await openContinuationNow(untouched.id, CHAT_A, true);
    expect(await abortContinuationSourceBeforeSendNow(untouchedContinuation.token, 'handoff_never_sent')).toBe(true);
    expect(continuationByToken(untouchedContinuation.token)).toMatchObject({
      state: 'aborted',
      error: 'handoff_never_sent'
    });

    const claimed = await createSession({ title: 'claimed source', conversationId: CHAT_B });
    const claimedContinuation = await openContinuationNow(claimed.id, CHAT_B, true);
    expect((await beginContinuationSourceSendNow(claimedContinuation.token))?.allowed).toBe(true);
    expect(await abortContinuationSourceBeforeSendNow(claimedContinuation.token, 'handoff_never_sent')).toBe(true);
    expect(continuationByToken(claimedContinuation.token)?.state).toBe('aborted');

    const armed = await createSession({ title: 'armed source', conversationId: CHAT_C });
    const armedContinuation = await openContinuationNow(armed.id, CHAT_C, true);
    expect((await beginContinuationSourceSendNow(armedContinuation.token))?.allowed).toBe(true);
    expect(await dispatchContinuationSourceSendNow(armedContinuation.token)).toBe(true);
    expect(await abortContinuationSourceBeforeSendNow(armedContinuation.token, 'handoff_never_sent')).toBe(false);
    expect(continuationByToken(armedContinuation.token)).toMatchObject({
      state: 'awaiting-summary',
      sourceSend: { state: 'dispatched-unresolved' }
    });
  });

  it('answers a repeated capture with the handoff it already wrote', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    const first = await attachSummary(opened.token, SAMPLE_BRIEF);
    // The connector loses tool results, so the page reports the same finished generation again. That retry must read as the success it is, not as a failure worth another flow.
    const again = await attachSummary(opened.token, SAMPLE_BRIEF);

    expect(first).not.toBeNull();
    expect(again?.id).toBe(first?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('writes one handoff even when two captures race', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    // Both see `awaiting-summary` before either write lands. Without a lock taken before the first await, both would write, and the second brief would silently win.
    const [first, second] = await Promise.all([
      attachSummary(opened.token, SAMPLE_BRIEF),
      attachSummary(opened.token, SAMPLE_BRIEF)
    ]);

    expect(first?.id).toBe(second?.id);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('gives every waiter the same retryable answer when the write fails', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const spy = vi.spyOn(store, 'saveHandoff').mockRejectedValueOnce(new Error('disk full'));

    // The duplicate joins the attempt already in flight. It must not receive a rejected promise for a step that simply has to be done again.
    const both = await Promise.all([
      attachSummary(opened.token, SAMPLE_BRIEF),
      attachSummary(opened.token, SAMPLE_BRIEF)
    ]);
    expect(both).toEqual([null, null]);

    spy.mockRestore();
    expect(await attachSummary(opened.token, SAMPLE_BRIEF)).not.toBeNull();
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('does not publish a handoff whose continuation WAL transition was rejected', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const durable = await import('../../backend/persistence/durable.js');
    vi.spyOn(durable, 'writeDurableNow').mockRejectedValueOnce(new Error('continuation state disk full'));

    // The handoff file write succeeds; only the semantic continuation transition fails. A failed compaction must remain invisible as the session's "latest handoff", otherwise a fresh chat can recover a brief this transaction explicitly rejected.
    expect(await attachSummary(opened.token, SAMPLE_BRIEF)).toBeNull();
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect((await getSession(summary.id))?.lastHandoffId).toBeNull();
  });

  it('repairs a handoff event after a crash between continuation WAL commit and session publication', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const recoveryToken = 'recovery-handoff-token';
    const prepared = await prepareHandoff({
      sessionId: summary.id,
      text: SAMPLE_BRIEF,
      continuationToken: recoveryToken,
      sourceConversationId: CHAT_A
    });
    expect((await getSession(summary.id))?.lastHandoffId).toBeNull();

    // This is the exact durable state after the continuation WAL landed but before the following session handoff event could be appended. Recovery must publish that event once, rather than losing handoff discovery or aborting a semantically committed capture.
    await restoreContinuations({
      version: 1,
      savedAt: Date.now(),
      entries: [
        {
          token: recoveryToken,
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'awaiting-chat',
          summary: SAMPLE_BRIEF,
          handoffId: prepared.id,
          claimedBy: null,
          armed: true,
          error: null
        }
      ]
    });

    expect((await getSession(summary.id))?.lastHandoffId).toBe(prepared.id);
    // Idempotent recovery must not append a second handoff event or reorder the timeline.
    await restoreContinuations({
      version: 1,
      savedAt: Date.now(),
      entries: [
        {
          token: recoveryToken,
          sessionId: summary.id,
          from: CHAT_A,
          to: null,
          openedAt: Date.now(),
          state: 'awaiting-chat',
          summary: SAMPLE_BRIEF,
          handoffId: prepared.id,
          claimedBy: null,
          armed: true,
          error: null
        }
      ]
    });
    const handoffEvents = (await store.readEvents(summary.id, { kinds: ['handoff'] })).filter(
      (event) => event.kind === 'handoff' && event.handoffId === prepared.id
    );
    expect(handoffEvents).toHaveLength(1);
  });

  it('stores a non-authority transaction fingerprint instead of the continuation token in provenance', async () => {
    const summary = await createSession({ title: 'provenance', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);

    expect(handoff).toMatchObject({
      version: 1,
      sessionId: summary.id,
      provenance: {
        sourceConversationId: CHAT_A,
        sourceGeneration: 1,
        sourceTurnId: null,
        continuationId: handoffContinuationId(opened.token)
      }
    });
    const disk = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'handoffs', `${handoff!.id}.json`), 'utf8')
    ) as { provenance: { continuationId: string } };
    expect(disk.provenance.continuationId).not.toBe(opened.token);
  });

  it('aborts a pre-commit restart when the saved handoff belongs to another continuation', async () => {
    const now = Date.now();
    const summary = await createSession({ title: 'provenance mismatch', conversationId: CHAT_A });
    const first = await openContinuationNow(summary.id, CHAT_A);
    const handoff = await attachSummary(first.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    const saved = snapshotContinuations();

    resetContinuationsForTests();
    const wrongToken = 'different-transaction-token';
    await restoreContinuations({
      ...saved,
      entries: saved.entries.map(entry => ({
        ...entry,
        token: wrongToken,
        openedAt: now,
        touchedAt: now
      }))
    });

    expect(continuationByToken(wrongToken)).toMatchObject({
      state: 'aborted',
      error: 'The saved handoff belongs to a different continuation.'
    });
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });

  it('keeps a durable committed rebind when handoff provenance is corrupt, without repairing it from that file', async () => {
    const summary = await createSession({ title: 'committed provenance mismatch', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const handoff = await attachSummary(opened.token, SAMPLE_BRIEF);
    expect(handoff).not.toBeNull();
    expect(await store.rebindSession(summary.id, CHAT_A, CHAT_B)).toBe(true);
    const saved = snapshotContinuations();

    resetContinuationsForTests();
    const wrongToken = 'committed-wrong-token';
    await restoreContinuations({
      ...saved,
      entries: saved.entries.map(entry => ({
        ...entry,
        token: wrongToken,
        state: 'committed' as const,
        to: CHAT_B,
        claimedBy: CHAT_B
      }))
    });

    expect(continuationByToken(wrongToken)?.state).toBe('committed');
    expect(await attachedChat(summary.id)).toBe(CHAT_B);
    expect((await getSession(summary.id))?.lastCommittedResumeHandoffId).toBeNull();
  });

  it('keeps the first brief when a re-observation differs, and still reports success', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);
    const first = await attachSummary(opened.token, SAMPLE_BRIEF);

    const again = await attachSummary(opened.token, `${SAMPLE_BRIEF}

(re-rendered slightly differently)`);

    expect(again?.id).toBe(first?.id);
    expect(again?.text).toBe(first?.text);
    expect(await handoffCount(summary.id)).toBe(1);
  });

  it('refuses an empty or interrupted answer and stays in chat A', async () => {
    const summary = await createSession({ title: 'work', conversationId: CHAT_A });
    const opened = await openContinuationNow(summary.id, CHAT_A);

    expect(await attachSummary(opened.token, '   ')).toBeNull();
    expect(continuationForSession(summary.id)?.state).toBe('awaiting-summary');
    expect(await claimContinuationNow(opened.token, 'tab-1')).toBeNull();
    expect(await attachedChat(summary.id)).toBe(CHAT_A);
  });
});

