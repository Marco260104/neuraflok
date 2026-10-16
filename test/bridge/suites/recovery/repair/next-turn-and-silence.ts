import { beforeEach, BROWSER_RECOVERY_COOLDOWN_MS, CHAT_SILENCE_MS, describe, expect, it, pair, PRIME_CHAT, redeem, request, resetBlockedChatsForTests, setChatBlocked, spawn, swarmState, swarmStateForCaller, sweepStaleSwarm, vi } from "../../../test-context.js";
import { attributed, chatOf, endTurn, events, FRESH, maintenance, openTurn, reopened } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: next turn and silence", () => {
  beforeEach(resetRecoveryFixture);

  it('gives the next turn its own reload when the failure it reloaded for had already ended', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(FRESH, [openTurn('turn-timed-out')]);
          await events(FRESH, [
            {
              kind: 'chat_error',
              time: Date.now(),
              text: 'Message delivery timed out. Please try again.',
              turnId: 'turn-timed-out',
              recoverable: true
            }
          ]);
          await events(FRESH, [endTurn('turn-timed-out', 'failed')]);
          const handout = await maintenance();
          expect(chatOf(handout)).toBe(FRESH);
          // The reload lands on a chat with no turn running: there is nothing to charge it to.
          expect(await maintenance(handout!.token)).toBeNull();
    
          await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
          await events(FRESH, [openTurn('turn-next')]);
          await events(FRESH, [
            {
              kind: 'chat_error',
              time: Date.now(),
              text: 'Connection interrupted. Waiting for the complete answer',
              turnId: 'turn-next',
              recoverable: true
            }
          ]);
          const next = await maintenance();
          expect(chatOf(next)).toBe(FRESH);
          expect(next?.reason).toBe('assistant-error');
        } finally {
          vi.useRealTimers();
        }
      });

  /** A turn that ended *failed* has not stopped the chat; it has stopped the page. The same live prime trace, after the refused reload: the turn ended failed at 11:43:10 and that ending took the chat off the two-minute silence watch, exactly as a completed answer would have. Nothing was left to ask, and the model behind the dead stream — which had finished its answer, as the manual reload then showed — went unreloaded for twenty minutes. A failure restarts the watch instead; a completed answer still spends it. */
      it('keeps a chat whose turn failed on the silence watch and reloads it two minutes later', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-dead')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await events(recoveryState.OTHER, [endTurn('turn-dead', 'failed')]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const handout = await maintenance();
          expect(chatOf(handout)).toBe(recoveryState.OTHER);
          expect(handout?.reason).toBe('silence');
          expect(await maintenance(handout!.token)).toBeNull();
    
          // A completed answer is the chat stopping, and the watch ends with it.
          await events(recoveryState.PRIME, [openTurn('turn-fine')]);
          await events(recoveryState.PRIME, [endTurn('turn-fine', 'completed')]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** The reload is the chat's chance, and the verdict on it waits the same two minutes. The live worker-2 trace, 2026-09-02: last tool call 11:35:07, silence reload 11:37:11, slept as "no durable activity after one browser reload" at 11:37:38 — twenty-seven seconds later, on the very next pass — and its finished answer arriving at 11:41:12. In between the prime was told to wake it and typed a wake into a chat that was still generating. */
      it('gives a reloaded worker the full silence window again before it is put to sleep', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'write a long answer' }], caller: { conversationId: PRIME_CHAT } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-long-answer')]);
          await attributed(recoveryState.WORKER, false, Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const handout = await maintenance();
          expect(chatOf(handout)).toBe(recoveryState.WORKER);
          expect(handout?.reason).toBe('silence');
          expect(await maintenance(handout!.token)).toBeNull();
    
          // The pass right after the reload: the model may still be writing. Still a worker.
          await sweepStaleSwarm(Date.now());
          expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    
          // Two more minutes with nothing durable is the chat having had its chance.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1');
          expect(worker?.state).toBe('sleeping');
        } finally {
          vi.useRealTimers();
        }
      });

  /** …and a repair that can never retire may not take the chat's silence watch down with it. The live prime trace: "Connection interrupted" at 21:40, the turn it broke ending failed at 21:45, eleven further minutes of attributed calls from the model behind the dead stream, and then nothing at all. The repair filed for that turn was still on file — the turn's own ending is the last one that chat ever had, so no later ending could retire it — and the two-minute watch read the entry as a recovery already in progress. Nothing was in progress. The chat sat dead for eighteen minutes until a human reloaded it by hand. Silence asks whether the conversation is alive at all, which no fact about one of its turns can answer, so it supersedes the entry rather than obeying it — including the browser floor that entry is waiting behind, which silence has never been subject to. */
      /** The one chat this app may never reload, however broken it looks. A block is the user taking the app's hands off a conversation, and a recovery is a hand going back on: the two-minute silence watch is a reload, and no-tab is a whole new tab for a chat whose every tool call is already being refused. Live, that is what put a rogue turn's page back on screen minutes after it was blocked. The silence itself is still spent, not merely skipped, because a chat waiting for a reload that is never coming would otherwise stay measured-silent in the ledger for good. */
      it('never reloads or reopens a chat the user blocked, however long it stays silent', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-blocked')]);
          setChatBlocked(recoveryState.OTHER, true);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
          expect(reopened(recoveryState.OTHER)).toEqual([]);
    
          // And it stays that way: silence cannot re-arm what it already spent on abandoning.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 5);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
          expect(reopened(recoveryState.OTHER)).toEqual([]);
        } finally {
          resetBlockedChatsForTests();
          vi.useRealTimers();
        }
      });

  /** The queue outlives the decision that filled it, so the block has to be read at handout too: a repair filed a minute before the user pressed Block would otherwise still be carried out. */
      it('drops a queued repair for a chat blocked after it was filed', async () => {
        await pair();
        await events(recoveryState.OTHER, [openTurn('turn-queued-then-blocked')]);
        await events(recoveryState.OTHER, [
          {
            kind: 'chat_error',
            time: Date.now(),
            text: 'Message delivery timed out. Please try again.',
            turnId: 'turn-queued-then-blocked',
            recoverable: true
          }
        ]);
        setChatBlocked(recoveryState.OTHER, true);
        try {
          expect(await maintenance()).toBeNull();
          expect(reopened(recoveryState.OTHER)).toEqual([]);
        } finally {
          resetBlockedChatsForTests();
        }
      });

  /** A reload the page has not come back from yet is not answered with another. The 300k-token prime of 2026-09-03 took three minutes to load, and silence reloaded it 23 seconds after an unattributed reload had — every reload starting the three minutes over. The page gets the recovery floor to come back; only a page that never does is reloaded when it runs out. */
      it('gives a freshly reloaded chat the recovery floor to come back before silence reloads it again', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-heavy')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await events(recoveryState.OTHER, [
            {
              kind: 'chat_error',
              time: Date.now(),
              text: 'Connection interrupted. Waiting for the complete answer',
              turnId: 'turn-heavy',
              recoverable: true
            }
          ]);
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.OTHER);
          expect(first?.reason).toBe('assistant-error');
          expect(await maintenance(first!.token, 'reloaded')).toBeNull();
    
          // Two minutes of nothing: the page is still loading. Silence does not pile on.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
    
          // The floor runs out with the page still gone: now silence's own reload, once.
          await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS - CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const rescue = await maintenance();
          expect(chatOf(rescue)).toBe(recoveryState.OTHER);
          expect(rescue?.reason).toBe('silence');
        } finally {
          vi.useRealTimers();
        }
      });
});
