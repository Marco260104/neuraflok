import { foldProgress } from "../../../../../contracts/session.js";
import { attachSummary, beforeEach, BROWSER_RECOVERY_COOLDOWN_MS, CHAT_SILENCE_MS, claimContinuationNow, commitContinuation, describe, expect, findSessionByConversation, getLog, getSession, it, openContinuationNow, pair, readEvents, recordToolCall, request, SAMPLE_BRIEF, sessionStoreModule, spawn, sweepStaleSwarm, vi } from "../../../test-context.js";
import type { SessionEvent } from "../../../test-context.js";
import { attributed, chatOf, endTurn, events, maintenance, maintenanceBatch, openTurn, reopened, unattributed } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: transport error recovery", () => {
  beforeEach(resetRecoveryFixture);

  it('reloads for recognized transport errors, once per user turn', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'hold the run open' }], caller: { conversationId: recoveryState.PRIME } });
          await events(recoveryState.PRIME, [openTurn('turn-prime')]);
    
          // A top-level failure needs no turn id, but must carry explicit recovery authority.
          await events(recoveryState.PRIME, [{
            kind: 'chat_error',
            time: Date.now(),
            text: 'Message delivery timed out. Please try again.',
            turnId: null,
            recoverable: true
          }]);
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.PRIME);
          expect(first?.reason).toBe('assistant-error');
          expect(await maintenance(first!.token)).toBeNull();
    
          // The same turn, another error: its one reload is spent.
          await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
          await events(recoveryState.PRIME, [{
            kind: 'chat_error',
            time: Date.now(),
            text: 'Connection interrupted. Waiting for the complete answer',
            turnId: 'turn-prime',
            recoverable: true
          }]);
          expect(await maintenance()).toBeNull();
    
          // The user's next message is the next turn, and it brings its own reload.
          await events(recoveryState.PRIME, [endTurn('turn-prime', 'failed'), openTurn('turn-prime-2')]);
          await events(recoveryState.PRIME, [{
            kind: 'chat_error',
            time: Date.now(),
            text: 'Connection interrupted. Waiting for the complete answer',
            turnId: 'turn-prime-2',
            recoverable: true
          }]);
          expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
        } finally {
          vi.useRealTimers();
        }
      });

  it('retains the error reload budget after a lost ACK while allowing later silence recovery', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [{ kind: 'user_message', time: Date.now(), messageId: 'lost-ack-question', text: 'Implement it' },
            { kind: 'model_selection', time: Date.now(), model: 'GPT-5.6 Sol', reasoningEffort: 'high' },
            openTurn('lost-ack-answer')]);
          await attributed(recoveryState.PRIME, false, Date.now());
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), text: 'Message delivery timed out', recoverable: true }]);
          const error = await maintenance();
          expect(error?.reason).toBe('assistant-error');
          expect((await request('POST', '/repairs/claim', { body: { token: error!.token } })).body.allowed).toBe(true);
          // Chrome reloaded, but the action receipt never reached main.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const silence = await maintenance();
          expect(silence?.reason).toBe('silence');
          await maintenance(silence!.token);
          await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
          const session = (await findSessionByConversation(recoveryState.PRIME))!;
          await sessionStoreModule.appendEvent(session.id, { kind: 'user_message', source: 'app', time: Date.now(),
            turnId: 'lost-ack-answer', inputId: 'same-turn-correction', messageId: 'input:same-turn-correction',
            message: { text: 'Include this detail.', truncated: false, chars: 20 } });
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), text: 'Connection interrupted', recoverable: true }]);
          expect((await maintenance())?.reason).not.toBe('assistant-error');
          // A late receipt for the superseded error cannot reconstruct a repair either.
          expect((await maintenance(error!.token))?.reason).not.toBe('assistant-error');
        } finally { vi.useRealTimers(); }
      });

  it('releases an error claim only when Chrome positively reports that no action occurred', async () => {
        await pair();
        await events(recoveryState.PRIME, [openTurn('failed-browser-action'), { kind: 'chat_error', time: Date.now(),
          text: 'Connection interrupted', recoverable: true }]);
        const first = await maintenance();
        expect((await request('POST', '/repairs/claim', { body: { token: first!.token } })).body.allowed).toBe(true);
        const failed = await request('GET', `/status?repairFailed=${first!.token}&repairAction=reloaded`);
        const retry = failed.body.repairs?.[0] ?? await maintenance();
        expect(retry?.reason).toBe('assistant-error');
        expect((await request('POST', '/repairs/claim', { body: { token: retry!.token } })).body.allowed).toBe(true);
      });

  it('says a recovered answer is being waited for instead of a failed reload, and still retries after it', async () => {
        await pair();
        await events(recoveryState.PRIME, [openTurn('answering-again'), { kind: 'chat_error', time: Date.now(),
          text: 'Connection interrupted', recoverable: true }]);
        const session = await findSessionByConversation(recoveryState.PRIME);
        const rows = async () => foldProgress((await readEvents(session!.id, { kinds: ['progress'] }))
          .filter((event): event is Extract<SessionEvent, { kind: 'progress' }> => event.kind === 'progress'))
          .map((event) => event.kind === 'progress' ? event.message.text : '');
        const lines = (text: string) => getLog().filter((entry) => entry.message.includes(text)).length;
        const failedBefore = lines('reported failed assistant-error recovery'), waitingBefore = lines('is answering again');
        // ChatGPT resumed the answer by itself; the page keeps the reload for after it, twice in a row.
        let handout = await maintenance();
        for (let pass = 0; pass < 2; pass++) {
          expect(handout?.reason).toBe('assistant-error');
          expect((await request('POST', '/repairs/claim', { body: { token: handout!.token } })).body.allowed).toBe(true);
          const waiting = await request('GET', `/status?repairFailed=${handout!.token}&repairAction=reloaded&why=streaming`);
          expect(await rows()).toEqual(['The provider is answering again; recovery waits until it finishes.']);
          handout = waiting.body.repairs?.[0] ?? await maintenance();
        }
        // One info line for the episode, no warning, and no "Trying to reload" row while it waits.
        expect(lines('is answering again') - waitingBefore).toBe(1);
        expect(lines('reported failed assistant-error recovery') - failedBefore).toBe(0);
        // A real failure afterwards still says so, with the page's reason.
        expect((await request('POST', '/repairs/claim', { body: { token: handout!.token } })).body.allowed).toBe(true);
        await request('GET', `/status?repairFailed=${handout!.token}&repairAction=reloaded&why=changed&detail=changed-progress%3Aapp-progress`);
        // The exact cause, in words (#1086): ten refusals in a row used to say only "the page changed".
        expect(getLog().some((entry) => entry.message.includes(
          `reported failed assistant-error recovery for ${recoveryState.PRIME} (reloaded: the page changed before the action — ` +
          'the answer made progress (the app recorded a status note))'))).toBe(true);
        expect(await rows()).toEqual(['Reload failed while recovering an interrupted response; will retry.']);
        // A detail the app does not know is dropped, never echoed into the log.
        handout = await maintenance();
        expect((await request('POST', '/repairs/claim', { body: { token: handout!.token } })).body.allowed).toBe(true);
        await request('GET', `/status?repairFailed=${handout!.token}&repairAction=reloaded&why=changed&detail=%3Cscript%3E`);
        expect(getLog().at(-1)!.message).toMatch(/\(reloaded: the page changed before the action\)$/);
      });

  it('preserves a recovered assistant-error page without spending a later reload on the same question', async () => {
        await pair();
        await events(recoveryState.PRIME, [
          { kind: 'user_message', time: Date.now(), messageId: 'preserved-question', text: 'Keep working' },
          openTurn('preserved-answer'),
          { kind: 'chat_error', time: Date.now(), turnId: 'preserved-answer',
            text: 'Connection interrupted. Waiting for the complete answer', recoverable: true }
        ]);
        const repair = await maintenance();
        expect(repair?.reason).toBe('assistant-error');
        expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(true);
    
        const preserved = await request('GET', `/status?repaired=${repair!.token}&repairAction=preserved`);
        expect(preserved.status).toBe(200);
        expect(preserved.body.repairs).toEqual([]);
        expect(await maintenance()).toBeNull();
    
        // No browser action happened, so preservation must not spend the authored question's one real error reload. If the transport failure returns, it earns a fresh repair.
        await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'preserved-answer',
          text: 'Connection interrupted. Waiting for the complete answer', recoverable: true }]);
        const retry = await maintenance();
        expect(retry?.reason).toBe('assistant-error');
        expect((await request('POST', '/repairs/claim', { body: { token: retry!.token } })).body.allowed).toBe(true);
      });

  it('does not refund error recovery when reload remints a generation for the same authored question', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          const question = { kind: 'user_message', time: Date.now(), messageId: 'repair-question', text: 'Build the feature' };
          await events(recoveryState.PRIME, [question, openTurn('original-answer')]);
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'original-answer',
            text: 'Connection interrupted. Waiting for the complete answer', recoverable: true }, endTurn('original-answer', 'failed')]);
          const first = await maintenance();
          expect(first?.reason).toBe('assistant-error');
          await maintenance(first!.token);
          await events(recoveryState.PRIME, [question, openTurn('replacement-document')]);
          await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'replacement-document',
            text: 'Connection interrupted. Waiting for the complete answer', recoverable: true }, endTurn('replacement-document', 'failed')]);
          expect(await maintenance()).toBeNull();
          await events(recoveryState.PRIME, [{ kind: 'user_message', time: Date.now(), messageId: 'next-repair-question', text: 'Continue the feature' }, openTurn('next-answer')]);
          // A late revision of the old question cannot take ownership away from the newer one.
          await events(recoveryState.PRIME, [{ ...question, time: Date.now(), text: 'Build the feature (hydrated)' }]);
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'next-answer',
            text: 'Connection interrupted. Waiting for the complete answer', recoverable: true }]);
          expect((await maintenance())?.reason).toBe('assistant-error');
        } finally { vi.useRealTimers(); }
      });

  it.each(['final', 'question'])('revokes an error reload handed before a newer %s reaches the browser action claim', async boundary => {
        await pair();
        await events(recoveryState.PRIME, [{ kind: 'user_message', time: Date.now(), messageId: 'claim-question', text: 'Implement it' }, openTurn('claim-answer')]);
        await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'claim-answer',
          text: 'Connection interrupted. Waiting for the complete answer', recoverable: true }]);
        const repair = await maintenance();
        expect(repair?.reason).toBe('assistant-error');
        if (boundary === 'final') await events(recoveryState.PRIME, [
          { kind: 'assistant_message', time: Date.now(), messageId: 'claim-final', turnId: 'claim-answer', text: 'Implemented and checked.', final: true, state: 'final' },
          endTurn('claim-answer', 'completed')
        ]);
        else await events(recoveryState.PRIME, [{ kind: 'user_message', time: Date.now(), messageId: 'claim-next-question', text: 'Now extend it' }, openTurn('claim-next-answer')]);
        const claimed = await request('POST', '/repairs/claim', { body: { token: repair!.token } });
        expect(claimed.body.allowed).toBe(false);
        expect(await maintenance()).toBeNull();
      });

  it('claims an interrupted-response reload only once without reissuing its handed token', async () => {
        await pair();
        await events(recoveryState.PRIME, [openTurn('claim-once')]);
        await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'claim-once', text: 'Connection interrupted', recoverable: true }]);
        const repair = await maintenance();
        expect((await maintenance())?.token).toBe(repair!.token);
        expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(true);
        expect(await maintenance()).toBeNull();
        expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(false);
        expect(await maintenance(repair!.token)).toBeNull();
      });

  it('offers one stale-composer recovery for a completed ordinary chat after 69 idle seconds', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('completed-ordinary'), endTurn('completed-ordinary', 'completed')]);
          await vi.advanceTimersByTimeAsync(69_000);
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: null, recoverable: true,
            text: 'ChatGPT finished its answer but its composer is still stuck on Stop. Recovering this page before delivering the queued message.' }]);
          const repair = await maintenance();
          expect(chatOf(repair)).toBe(recoveryState.PRIME);
          expect(repair?.reason).toBe('assistant-error');
          expect(await maintenance(repair!.token)).toBeNull();
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: null, recoverable: true,
            text: 'ChatGPT finished its answer but its composer is still stuck on Stop. Recovering this page before delivering the queued message.' }]);
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  /** The live 2026-08-31 failure: a send that never reached a model at all. ChatGPT paints "Message delivery timed out" as a live region above the thread, because the send died before there was an assistant turn to paint it in. The banner therefore names no turn of its own - the page's live generation names it - and for a while that shape was refused recovery outright. The app recorded the failure, marked the turn failed, and left the chat parked on the error until a human noticed. */
      it('reloads a chat parked on a transport failure the banner could not name itself', async () => {
        await pair();
        await events(recoveryState.OTHER, [openTurn('turn-solo-delivery')]);
        await events(recoveryState.OTHER, [
          {
            kind: 'chat_error',
            time: Date.now(),
            text: 'Message delivery timed out. Please try again.',
            // Supplied by the page's own live generation, exactly as content.js stamps it.
            turnId: 'turn-solo-delivery',
            recoverable: true
          },
          endTurn('turn-solo-delivery', 'failed')
        ]);
        expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
      });

  /** The live 2026-08-31 trace, and the reason nothing had ever been observed to reload. A worker's page lost its answer stream and printed "Connection interrupted. Waiting for the complete answer", while the model went on running server-side: fifteen connector calls in the four minutes that followed, every one of them attributed. Attribution proves the request-id join works. It says nothing whatever about the stream the page lost, which is the only thing this repair is about - so a repair filed against the broken turn must survive it. It did not. The repair was queued, and twenty seconds later the next tool call deleted it, long before the browser's own maintenance pass could collect it. A chat sick enough to need reloading is usually a chat still calling tools, so the reload was erased every time. */
      it('keeps a broken turn’s reload alive while that turn goes on calling tools', async () => {
        await pair();
        await events(recoveryState.OTHER, [openTurn('turn-interrupted')]);
        await events(recoveryState.OTHER, [
          {
            kind: 'chat_error',
            time: Date.now(),
            text: 'Connection interrupted. Waiting for the complete answer',
            turnId: 'turn-interrupted',
            recoverable: true
          }
        ]);
        await attributed(recoveryState.OTHER);
        expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
      });

  it('isolates a late call from a handoff source without restoring that old chat', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          const from = 'efefefef-1111-2222-3333-444444444401';
          const to = 'efefefef-1111-2222-3333-444444444402';
          const requestId = 'wfr_historical_after_handoff';
          const opened = await events(from, [
            { kind: 'user_message', time: Date.now(), text: 'audit everything', messageId: 'm-historical-source' },
            openTurn('turn-historical-source'),
            {
              kind: 'tool_evidence',
              time: Date.now(),
              calls: [{ messageId: 'call-historical-source', tool: 'read', order: 0, answered: false, requestId }]
            }
          ]);
          const sessionId = opened.body.sessionId as string;
          const continuation = await openContinuationNow(sessionId, from);
          expect(await attachSummary(continuation.token, SAMPLE_BRIEF)).not.toBeNull();
          await claimContinuationNow(continuation.token, 'historical-recovery-test');
          expect(await commitContinuation(continuation.token, to)).toBe(true);
    
          // Exact request proof preserves which retired frontend called; it does not grant A new execution/history authority after S moved to B. The refusal is isolated and cannot push either A's recovery clock or B's current-context activity forward.
          const late = await recordToolCall({
            tool: 'read',
            args: { paths: ['/project/late.ts'] },
            content: [{ type: 'text', text: 'late but exact' }],
            outcome: 'ok',
            durationMs: 1,
            startedAt: Date.now() + 1,
            requestId
          });
          expect(late).toMatchObject({
            conversationId: from,
            attribution: 'superseded',
            attributionMethod: 'superseded'
          });
          expect(await getSession(sessionId)).toMatchObject({ conversationId: to, toolCalls: 0 });
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 3);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
          expect(reopened(from)).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      });

  /** And the half that matters to the session: after the commit, B is the chat recovery is about. A repair names a conversation, and Compact & Resume changes which conversation the session is. Every ledger this app keeps is keyed by chat id, so the question is not academic: if the old id stayed the subject, a session would come out of a compaction with its reloads pointed at a page nobody is looking at, and the chat actually doing the work would have no recovery at all. The recorder drops A on rebind and the store moves `conversationId` to B, so the suspect set can only ever contain B - and it contains B as soon as B says it is working, with no repair, no grant and no spent budget inherited from A. */
      it('moves recovery onto the chat a compaction resumed into', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          const from = 'efefefef-1111-2222-3333-444444444411';
          const to = 'efefefef-1111-2222-3333-444444444412';
          const opened = await events(from, [
            { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-resume-recovery' },
            openTurn('turn-resume-source')
          ]);
          const sessionId = opened.body.sessionId as string;
    
          // A is mid-turn and unattributed, so it is a suspect right up to the commit.
          await unattributed();
          const continuation = await openContinuationNow(sessionId, from);
          expect(await attachSummary(continuation.token, SAMPLE_BRIEF)).not.toBeNull();
          await claimContinuationNow(continuation.token, 'resume-recovery-test');
          expect(await commitContinuation(continuation.token, to)).toBe(true);
    
          // The deadline A was waiting on arrives, and there is nothing left to serve it to. A queued repair is dropped for want of authority; A's activity grant goes with it.
          await vi.advanceTimersByTimeAsync(60_000);
          expect(await maintenanceBatch()).toEqual([]);
    
          // B says it is working, which is the first thing about B this app has ever been told.
          await events(to, [openTurn('turn-resume-target')]);
          await unattributed();
          await vi.advanceTimersByTimeAsync(60_000);
          expect(chatOf(await maintenance())).toBe(to);
        } finally {
          vi.useRealTimers();
        }
      });

  /** Nor may the broken turn's own last breath count against it. The live worker-2 trace: "Message delivery timed out" at 01:13:00, the turn it broke ending failed at 01:13:04, and then nothing for six minutes while the model behind the dead stream went on calling tools. The failure and the ending arrive in separate batches, so the turn is still open when the repair is filed - and a repair retired by the next turn ending was retired by the ending of the very turn it was filed about, four seconds later. A repair for a broken turn is spent when the chat gets through a turn, not when it finishes dying. */
      it('keeps the reload alive when the turn it was filed about ends a moment later', async () => {
        await pair();
        await events(recoveryState.OTHER, [openTurn('turn-timed-out')]);
        await events(recoveryState.OTHER, [
          {
            kind: 'chat_error',
            time: Date.now(),
            text: 'Message delivery timed out. Please try again.',
            turnId: 'turn-timed-out',
            recoverable: true
          }
        ]);
        await events(recoveryState.OTHER, [endTurn('turn-timed-out', 'failed')]);
        await attributed(recoveryState.OTHER);
        expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
      });
});
