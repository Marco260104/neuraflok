import { beforeEach, CHAT_SILENCE_MS, describe, expect, getConfig, goalPendingReplyFor, it, pair, PRO_SILENCE_MS, redeem, request, saveConfig, setSecret, spawn, sweepStaleSwarm, vi } from "../../../test-context.js";
import { attributed, chatOf, endTurn, events, maintenance, openTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: silence repair boundaries", () => {
  beforeEach(resetRecoveryFixture);

  it('reloads a silent chat over a turn repair that can no longer retire', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          // An earlier transport failure, repaired and then retired by a turn the chat got through. That spends this chat's browser action and starts its three-minute floor.
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-first')]);
          await events(recoveryState.OTHER, [
            {
              kind: 'chat_error',
              time: Date.now(),
              text: 'Connection interrupted. Waiting for the complete answer',
              turnId: 'turn-first',
              recoverable: true
            }
          ]);
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.OTHER);
          expect(await maintenance(first!.token, 'reloaded')).toBeNull();
          await events(recoveryState.OTHER, [endTurn('turn-first', 'failed')]);
          await events(recoveryState.OTHER, [openTurn('turn-through'), endTurn('turn-through', 'completed')]);
          expect(await maintenance()).toBeNull();
    
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-broken')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await events(recoveryState.OTHER, [
            {
              kind: 'chat_error',
              time: Date.now(),
              text: 'Message delivery timed out. Please try again.',
              turnId: 'turn-broken',
              recoverable: true
            }
          ]);
          await events(recoveryState.OTHER, [endTurn('turn-broken', 'failed')]);
          // Filed against the turn that just died, so nothing will ever retire it, and still behind the floor the reopen started. The model goes on calling tools through the dead stream.
          await attributed(recoveryState.OTHER);
          expect(await maintenance()).toBeNull();
    
          // Now the chat stops for good. It is owed its one reload whatever else is on file.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const rescue = await maintenance();
          expect(chatOf(rescue)).toBe(recoveryState.OTHER);
          expect(rescue?.reason).toBe('silence');
        } finally {
          vi.useRealTimers();
        }
      });

  /** Nor may the wait itself be the window in which it is forgotten. The exact live shape: a tab closed and reopened spends this chat's browser action, so the transport failure a minute later is held behind the three-minute floor. Every tool call during that wait used to erase it, which made a held repair one that could never be handed out at all. */
      it('hands the repair out after the cooldown, however busy the chat was while it waited', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [openTurn('turn-worker-closed')]);
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          const reopen = await maintenance();
          expect(chatOf(reopen)).toBe(recoveryState.WORKER);
          // Carried out. That spends the chat's action and starts its three-minute floor.
          expect(await maintenance(reopen!.token)).toBeNull();
    
          await vi.advanceTimersByTimeAsync(90_000);
          await events(recoveryState.WORKER, [openTurn('turn-worker-interrupted')]);
          await events(recoveryState.WORKER, [
            {
              kind: 'chat_error',
              time: Date.now(),
              text: 'Connection interrupted. Waiting for the complete answer',
              turnId: 'turn-worker-interrupted',
              recoverable: true
            }
          ]);
          // Still inside the floor, and the chat keeps working the whole way through it.
          for (let call = 0; call < 6; call++) {
            await vi.advanceTimersByTimeAsync(15_000);
            await attributed(recoveryState.WORKER);
            }
          expect(chatOf(await maintenance())).toBe(recoveryState.WORKER);
        } finally {
          vi.useRealTimers();
        }
      });

  /** A native opening is observable activity, but only a current-turn local MCP call admits silence intervention. Ordinary website browsing stays untouched. */
      it('does not intervene in an open turn that never calls a local tool', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-silent-from-the-start')]);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
    
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** The reload has to land on the boundary, not at the next maintenance tick. Every other test in this block calls the sweep by hand, so none of them could see the delay a user actually gets: the ledger expired at 2:00 and nothing looked at it until the 30-second interval came round, with the extension's own 30-second alarm still to follow. A prime whose tab was closed mid-turn was measured being reopened 2:40 after its last tool call. Advancing the clock and touching nothing is the only way to pin the half this process owns. */
      it('queues the silence reload on the deadline without waiting for the maintenance tick', async () => {
        vi.useFakeTimers();
        try {
          // Its own chat: a conversation another test already had repaired would still be holding that spent handout, and this is about arming a fresh episode on time.
          const PUNCTUAL = 'a1a1a1a1-1111-2222-3333-444444444444';
          await pair();
          await events(PUNCTUAL, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-silent-punctual')]);
          await attributed(PUNCTUAL, false, Date.now());
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          expect(await maintenance()).toBeNull();
    
          // No sweepStaleSwarm() call: the deadline itself must be what wakes the app.
          await vi.advanceTimersByTimeAsync(2);
          // The deadline's callback now revalidates durable current-turn MCP proof. Await that real filesystem work, without manually invoking the sweep.
          await vi.waitFor(async () => expect(chatOf(await maintenance())).toBe(PUNCTUAL), { interval: 1, timeout: 1000 });
        } finally {
          vi.useRealTimers();
        }
      });

  it('does not acquire silence authority from an authored opening without a source-turn MCP call', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{
            kind: 'user_message',
            time: Date.now(),
            messageId: 'opening-user-message',
            authoredNow: true,
            text: 'start working'
          }]);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
    
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** The live 17:41-17:54 loop: a completed chat was reloaded, its replacement document sent a title plus the same historical user row, and the coarse `stored > 0` batch test treated that old row as a new opening. Every reload therefore armed the next one two/three minutes later. Recorder acceptance is now the boundary, and a history row never carries authoredNow. */
      it('does not re-arm a completed chat when reload replays its title and historical user row', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [
            {
              kind: 'user_message',
              time: Date.now(),
              messageId: 'package-opening-message',
              authoredNow: true,
              text: 'read package.json'
            },
            openTurn('turn-package')
          ]);
          await events(recoveryState.OTHER, [
            { kind: 'turn_end', time: Date.now(), turnId: 'turn-package', outcome: 'completed' }
          ]);
    
          // The replacement page changes the canonical row's local turn stamp, so the recorder really does accept a write; the title is accepted too. Neither fact means the user sent anything after the completed answer.
          await events(recoveryState.OTHER, [
            { kind: 'conversation_title', time: Date.now(), text: 'Read package name' },
            {
              kind: 'user_message',
              time: Date.now(),
              messageId: 'package-opening-message',
              turnId: 'historical-page-turn',
              text: 'read package.json'
            }
          ]);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  it('spends a confirmed reload even when its replacement page immediately rewrites historical transcript', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
            {
              kind: 'user_message',
              time: Date.now(),
              messageId: 'android-opening-message',
              authoredNow: true,
              text: 'read the Android codebase'
            },
            openTurn('turn-android-stale')
          ]);
          await attributed(recoveryState.OTHER, false, Date.now());
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.OTHER);
          expect(await maintenance(reload!.token)).toBeNull();
    
          // This lands in the narrow interval after Chrome confirmed the reload but before the next maintenance sweep spends the expired grant. The historical row is a real canonical rewrite (new local turn stamp), but it is still not new model activity.
          await events(recoveryState.OTHER, [
            { kind: 'conversation_title', time: Date.now(), text: 'Read Android Codebase' },
            {
              kind: 'user_message',
              time: Date.now(),
              messageId: 'android-opening-message',
              turnId: 'replacement-document-history',
              text: 'read the Android codebase'
            }
          ]);
          await sweepStaleSwarm(Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** Browser lifetime is not evidence about the turn, on this clock either. The page detaching says nothing about whether the model is still working, so it may neither spend the deadline nor — through the recorder's live map, which the detach empties — make the chat ineligible for the recovery the deadline is about to ask for. */
      it('keeps watching an open turn whose page detached before the window ran out', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-silent-across-detach')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await request('POST', '/closed', { body: { conversationId: recoveryState.OTHER } });
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
        } finally {
          vi.useRealTimers();
        }
      });

  /** A real terminal spends the deadline; an `unknown` end is not one. */
      it('stops watching on a real turn end but not on an uncertain one', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-ends-uncertain')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await events(recoveryState.OTHER, [
            { kind: 'turn_end', time: Date.now(), turnId: 'turn-ends-uncertain', outcome: 'unknown' }
          ]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.OTHER);
          expect(await maintenance(reload!.token)).toBeNull();
    
          await events(recoveryState.PRIME, [openTurn('turn-ends-for-real')]);
          await events(recoveryState.PRIME, [
            { kind: 'turn_end', time: Date.now(), turnId: 'turn-ends-for-real', outcome: 'completed' }
          ]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** Prime's own open turn is on the same silence clock as anybody else's. Prime is the chat a run is steered from, so it is the one whose stall nothing else is watching: no worker slot depends on it and no bootstrap is waiting on it. */
      it('reloads Prime once when its own open turn goes two minutes silent', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'hold the run open' }], caller: { conversationId: recoveryState.PRIME } });
          await events(recoveryState.PRIME, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-prime-silent')]);
          await attributed(recoveryState.PRIME);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
    
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
        } finally {
          vi.useRealTimers();
        }
      });

  /** The user's standing instruction outranks the switch. A chat the Loop is driving is brought back after silence with tab recovery off, while a plain chat is left where it fell. On 2026-09-02 a closed Loop prime waited for a reopen that nothing was allowed to give it. */
      it('always brings a Goal/Loop chat back after silence, tab recovery switch or not', async () => {
        const previous = getConfig();
        await saveConfig({
          ...previous,
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false },
          goal: { ...previous.goal, enabled: true, mode: 'loop' }
        });
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-loop-silent')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'silence' });
        } finally {
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  /** The prime stops writing with no final answer. Two minutes of silence earn the reload; the fresh page shows the same dead turn with no new work, and the loop files the next user message, filed as the same durable obligation a finished answer files, under a turn of its own. On 2026-09-02 that chat would otherwise have sat on its dead turn for good, because a turn that never ends is a turn Goal never answers. */
      it.each(['pro', 'other'] as const)('retains handled exhausted silence while Off for later explicit %s Loop activation', async model => {
        const chat = model === 'pro' ? 'a2222222-1111-4111-8111-000000000091' : 'a2222222-1111-4111-8111-000000000092';
        const goal = await import("../../../../../backend/domains/automation/goal.js");
        const { setSessionAutomation } = await import("../../../../../backend/domains/browser/bridge.js");
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, finishTool: true } });
        await setSecret('openRouterApiKey', 'sk-or-off-silence');
        vi.useFakeTimers();
        try {
          await pair();
          await events(chat, [{ kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() }, openTurn('off-silence-source')]);
          const sessionId = (await request('GET', `/activity?conversationId=${chat}`)).body.sessionId;
          await setSessionAutomation(sessionId, 'off');
          await attributed(chat, false, Date.now());
          await setSessionAutomation(sessionId, 'loop', true);
          expect(goalPendingReplyFor(chat)).toBeNull();
          await setSessionAutomation(sessionId, 'off');
          await vi.advanceTimersByTimeAsync(model === 'pro' ? PRO_SILENCE_MS : CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair).toMatchObject({ conversationId: chat, reason: 'silence' });
          await maintenance(repair!.token);
          await sweepStaleSwarm(Date.now());
          expect(goalPendingReplyFor(chat)).toBeNull();
          if (model === 'pro') {
            await vi.advanceTimersByTimeAsync(300_000);
            await sweepStaleSwarm(Date.now());
          }
          const held = goal.snapshotGoalReplies().replies.find(row => row.conversationId === chat);
          expect(held).toMatchObject({ state: 'handled', silenceSourceTurnId: 'off-silence-source' });
          if (model === 'other') {
            await vi.advanceTimersByTimeAsync(60_000);
            await sweepStaleSwarm(Date.now());
          }
          if (model === 'pro') {
            await setSessionAutomation(sessionId, 'loop', false);
            expect(goalPendingReplyFor(chat)).toBeNull();
          }
          await setSessionAutomation(sessionId, 'loop', true);
          expect(goalPendingReplyFor(chat)?.replyId).toBe(held!.replyId);
          await setSessionAutomation(sessionId, 'off');
          await events(chat, [{ kind: 'user_message', time: Date.now(), messageId: 'new-question-after-silence', text: 'new work before its turn starts' }]);
          await setSessionAutomation(sessionId, 'loop', true);
          expect(goalPendingReplyFor(chat)).toBeNull();
          await setSessionAutomation(sessionId, 'off');
          await events(chat, [openTurn('new-work-after-silence')]);
          await setSessionAutomation(sessionId, 'loop', true);
          expect(goalPendingReplyFor(chat)).toBeNull();
        } finally { await setSecret('openRouterApiKey', ''); await saveConfig(previous); vi.useRealTimers(); }
      });
});
