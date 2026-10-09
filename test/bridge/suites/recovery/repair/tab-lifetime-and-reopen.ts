import { beforeEach, bridgeState, CHAT_SILENCE_MS, describe, expect, faultGate, findSessionByConversation, finishAgent, getConfig, getLog, getSession, it, liveConversations, pair, redeem, releaseQuiescentRun, request, requestWorkerRevivals, saveConfig, sessionControlsFor, sessionStoreModule, spawn, stageMessages, startBridge, stopBridge, swarmState, sweepStaleSwarm, vi, waitForRevival } from "../../../test-context.js";
import { attributed, chatOf, endTurn, events, maintenance, openTurn, reopened, unattributed } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: tab lifetime and reopen", () => {
  beforeEach(resetRecoveryFixture);

  it.each([false, true])('projects an exactly owned running call after page departure (manual=%s)', async manual => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: false },
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false } });
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('offline-admission')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          const session = (await findSessionByConversation(recoveryState.OTHER))!;
          await request('POST', '/closed', { body: { conversationId: recoveryState.OTHER, manual } });
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          const { sessionWorkingAt } = await import("../../../../../contracts/sessions/activity-state.js");
          const { trackInFlight, emptyEvidence } = await import("../../../../../backend/infrastructure/tool-gateway/protocol/call-context.js");
          const summary = (await getSession(session.id))!;
          const active = () => sessionWorkingAt({ ...summary, activityExpiresAt: sessionActivityExpiresAt(summary) }, Date.now());
          expect(active()).toBe(false);
          for (const owner of [recoveryState.PRIME, null, recoveryState.OTHER]) await trackInFlight({ startedAt: Date.now(), transportKey: null,
            agent: null, outcome: null, evidence: emptyEvidence(),
            caller: { conversationId: owner, requestId: `offline-running-${owner}`, transportKey: null } }, async () => {
            expect(active()).toBe(owner === recoveryState.OTHER);
            if (owner === recoveryState.OTHER) {
              await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
              expect(active()).toBe(true);
              if (manual) expect((await sessionControlsFor(session.id)).activeTurnId).toBeNull();
              expect(liveConversations().some(row => row.conversationId === recoveryState.OTHER)).toBe(false);
              expect(await maintenance()).toBeNull();
            }
          });
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  it('keeps the latest explicit close stronger than generic reattachment and an older page poll', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('repeated-close')]);
          const session = (await findSessionByConversation(recoveryState.PRIME))!;
          await request('POST', '/closed', { body: { conversationId: recoveryState.PRIME, manual: true } });
          await vi.advanceTimersByTimeAsync(1_000);
          await sessionStoreModule.reopenSession(session.id);
          expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBeDefined();
          const oldPoll = Date.now();
          await vi.advanceTimersByTimeAsync(1_000);
          await request('POST', '/closed', { body: { conversationId: recoveryState.PRIME, manual: true } });
          const recorder = await import("../../../../../backend/domains/sessions/history/recorder.js");
          expect(await recorder.restoreRecordedConversation(recoveryState.PRIME, oldPoll)).toBeNull();
          expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBe(Date.now());
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await request('GET', `/activity?conversationId=${recoveryState.PRIME}`);
          expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBeUndefined();
        } finally { vi.useRealTimers(); }
      });

  it('does not let an old frontend close pause its committed replacement', async () => {
        await pair();
        await events(recoveryState.PRIME, [openTurn('source-close')]);
        const session = (await findSessionByConversation(recoveryState.PRIME))!;
        expect(await sessionStoreModule.rebindSession(session.id, recoveryState.PRIME, recoveryState.OTHER)).toBe(true);
        await sessionStoreModule.endSession(session.id, true, recoveryState.PRIME);
        expect(await getSession(session.id)).toMatchObject({ conversationId: recoveryState.OTHER, endedAt: null });
        expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBeUndefined();
      });

  it('revokes a handed reload when the user closes its tab', async () => {
        await pair();
        await events(recoveryState.PRIME, [openTurn('close-after-handout'), { kind: 'chat_error', time: Date.now(),
          text: 'Connection interrupted', recoverable: true }]);
        const repair = await maintenance();
        expect(repair?.reason).toBe('assistant-error');
        const session = (await findSessionByConversation(recoveryState.PRIME))!;
        expect((await sessionControlsFor(session.id)).recovery).toEqual([{ kind: 'assistant-error', deadline: expect.any(Number) }]);
        await request('POST', '/closed', { body: { conversationId: recoveryState.PRIME, manual: true } });
        expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(false);
        expect(await maintenance(repair!.token)).toBeNull();
      });

  it('hands a legacy missing worker tab to the browser until an action receipt or that page returns', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [openTurn('turn-worker-missing-retry')]);
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
    
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.WORKER);
          const retry = await maintenance();
          expect(chatOf(retry)).toBe(recoveryState.WORKER);
          expect(retry!.token).toBe(first!.token);
          // The app itself never opens recovery tabs. The extension scans Chrome immediately before acting, which is the only place that can choose reload vs open without a race.
          expect(reopened(recoveryState.WORKER)).toEqual([]);
    
          await events(recoveryState.WORKER, [openTurn('turn-worker-back')]);
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  it('gives a detached prime the same exact missing-tab recovery as a worker', async () => {
        await pair();
        spawn({ workers: [{ task: 'keep this run resumable' }], caller: { conversationId: recoveryState.PRIME } });
        await events(recoveryState.PRIME, [openTurn('turn-prime-before-close')]);
        await request('POST', '/closed', { body: { conversationId: recoveryState.PRIME } });
    
        expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');
        expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
      });

  it('keeps a completed prime detached without reopening its idle chat', async () => {
        await pair();
        spawn({ workers: [{ task: 'keep this run resumable' }], caller: { conversationId: recoveryState.PRIME } });
        await events(recoveryState.PRIME, [openTurn('turn-prime-completed'), endTurn('turn-prime-completed', 'completed')]);
        await request('POST', '/closed', { body: { conversationId: recoveryState.PRIME } });
    
        expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');
        expect(await maintenance(), 'run ownership is not an open Prime turn').toBeNull();
      });

  it('reopens a closed tab once per close, immediately, with no floor between closes', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [openTurn('turn-worker-cooldown')]);
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.WORKER);
          expect(first!.reason).toBe('no-tab');
          expect(await maintenance(first!.token, 'reopened')).toBeNull();
          // Repeated close reporting with no intervening page activity is still the same episode.
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          expect(await maintenance()).toBeNull();
    
          // The exact page comes back and is closed again moments later. A closed tab has no page the three-minute floor could be protecting, so the second close is reopened at once — one close, one reopen, however close together they land.
          await events(recoveryState.WORKER, [openTurn('turn-worker-back')]);
          await events(recoveryState.WORKER, [openTurn('turn-worker-2')]);
          await vi.advanceTimersByTimeAsync(1_000);
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          const second = await maintenance();
          expect(chatOf(second)).toBe(recoveryState.WORKER);
          expect(second!.token).not.toBe(first!.token);
        } finally {
          vi.useRealTimers();
        }
      });

  /** The page's parting word is not the turn. A document being torn down has no Stop control, so its last observation reads "completed" whatever the server is doing; on 2026-09-03 worker-1 reported exactly that one second before its `/closed` while its request id went on calling tools. A worker slot that was working when its tab went is what the close detached, and that is the fact the reopen reads. */
      it('reopens a worker whose page called its turn done a second before the tab closed', async () => {
        await pair();
        spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
        });
        await events(recoveryState.WORKER, [openTurn('turn-worker-parting'), endTurn('turn-worker-parting', 'completed')]);
        await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
    
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
        const handout = await maintenance();
        expect(chatOf(handout)).toBe(recoveryState.WORKER);
        expect(handout!.reason).toBe('no-tab');
      });

  it('closes a no-tab repair without a reload when the browser finds the chat open again (#864)', async () => {
        await pair();
        spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
        });
        await events(recoveryState.WORKER, [openTurn('turn-worker-gone'), endTurn('turn-worker-gone', 'completed')]);
        await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
        const handout = await maintenance();
        expect(handout!.reason).toBe('no-tab');
        const priorLogs = new Set(getLog());
    
        // By the time the browser acted, a wake had opened the chat's tab itself; it was left alone.
        expect(await maintenance(handout!.token, 'present')).toBeNull();
        const fresh = getLog().filter(entry => !priorLogs.has(entry)).map(entry => entry.message);
        expect(fresh).toContain(`bridge: ${recoveryState.WORKER} was already open again; the browser left its tab as it was`);
        expect(fresh.some(message => message.includes('confirmed no-tab recovery'))).toBe(false);
      });

  it('reopens the chat of a prime whose run ended long ago', async () => {
        // A chat that once hosted a swarm goes on being an ordinary chat afterwards. The run's record does not: it is parked, and every agent in it keeps the state it had when the run ended — a prime stays `active` forever. `agentInfoForOwnedConversation` answers out of that parked record when no live run owns the chat, so the slot check below read "active, not working" about a swarm that had been over for hours and refused the reopen. Once, for the rest of that chat's life. Measured 2026-09-19: fifteen such refusals across two days, all on chats that had been primes. The app had logged "restored no active run" at startup an hour before the last one. The user's chat lost its tab mid-answer and its tool calls went on being filed under Unattributed activity, because nothing could tell the app where the work was.
        await pair();
        spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
        });
        await events(recoveryState.WORKER, [openTurn('turn-worker-over'), endTurn('turn-worker-over', 'completed')]);
        finishAgent({ conversationId: recoveryState.WORKER }, 'the piece is done');
        expect(releaseQuiescentRun({ reason: 'no worker is currently running' })).toBe(true);
        expect(swarmState().agents, 'the run is parked, not running').toHaveLength(0);
    
        // The chat carries on as itself: a tool call of its own, and a turn running. Both are what make it this app's chat at all — a chat that never called a tool is nobody's business here.
        await attributed(recoveryState.PRIME);
        await events(recoveryState.PRIME, [openTurn('turn-after-the-run')]);
        await request('POST', '/closed', { body: { conversationId: recoveryState.PRIME } });
    
        const handout = await maintenance();
        expect(chatOf(handout)).toBe(recoveryState.PRIME);
        expect(handout!.reason).toBe('no-tab');
      });

  it('reopens the tab of a worker it is in the middle of waking', async () => {
        // A wake is text this app is trying to type into that exact chat. With the page gone it has nowhere to go: the browser never claims the command and it expires having typed nothing. Measured 2026-09-19: worker-1's counterpart was woken at 07:16:37.914 and its tab closed 5.3 seconds later, declined as "waking, not working" — the one non-detached state that still owes its page something. The wake then sat unclaimed for its whole deadline. Three wakes failed that way on one machine that morning; every wake whose tab survived landed, the fastest in 1.2 seconds.
        await pair();
        spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
        });
        // The worker did its turn and reported; a wake is what comes after that, so the chat it is being woken in is a chat this app has a session for.
        await events(recoveryState.WORKER, [openTurn('turn-worker-wake'), endTurn('turn-worker-wake', 'completed')]);
        finishAgent({ conversationId: recoveryState.WORKER }, 'reported, waiting for more');
        // The shared `wake` helper stages from PRIME_CHAT; this describe owns its own prime.
        const staged = stageMessages({ conversationId: recoveryState.PRIME }, [{ to: 'worker-1', text: 'pick this back up' }]);
        staged.commit();
        expect(staged.waking.length).toBeGreaterThan(0);
        requestWorkerRevivals(staged.waking);
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    
        await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
        const handout = await maintenance();
        expect(chatOf(handout)).toBe(recoveryState.WORKER);
        expect(handout!.reason).toBe('no-tab');
      });

  it('reopens the chat of a sleeping worker at the moment it is woken', async () => {
        // The other end of "sleeping, not working". A sleeping worker's closed tab is correctly left closed; the wake that arrives later is what makes that chat owed a page again, and nothing asked for one. Measured 2026-09-19: worker-11's tab closed at 07:11:34 and was declined as sleeping; it was woken at 07:16:37 and the command sat unclaimed for its full deadline, typed into nothing. worker-13's chat closed at 07:10 and its wake five minutes later died the same way. Both conversations still existed — only their tabs were gone.
        await pair();
        spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
        });
        await events(recoveryState.WORKER, [openTurn('turn-worker-slept'), endTurn('turn-worker-slept', 'completed')]);
        finishAgent({ conversationId: recoveryState.WORKER }, 'reported, waiting for more');
    
        // The close a sleeping worker is not reopened for. This is the state the wake starts from.
        await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
        expect(await maintenance(), 'a sleeping worker is not owed a tab').toBeNull();
        // And the refusal names the chat, not only the slot. Every prime in every run is called `prime` and worker ids repeat across runs, so a line carrying the id alone cannot be traced back to a conversation at all — 533 such lines over two days here could not even be counted by chat.
        const staged = stageMessages({ conversationId: recoveryState.PRIME }, [{ to: 'worker-1', text: 'pick this back up' }]);
        staged.commit();
        expect(staged.waking.length).toBeGreaterThan(0);
        requestWorkerRevivals(staged.waking);
    
        const handout = await vi.waitFor(async () => {
          const row = await maintenance();
          expect(row).not.toBeNull();
          return row;
        });
        expect(chatOf(handout)).toBe(recoveryState.WORKER);
        expect(handout!.reason).toBe('no-tab');
        expect(getLog().filter((entry) => entry.message.includes('closed its last tab')).at(-1)?.message)
          .toContain(`worker-1 (${recoveryState.WORKER})`);
      });

  it.each(['manual-close', 'wake-finished', 'page-returned', 'recovery-off', 'redeemed', 'bridge-stopped', 'lookup-failed'] as const)(
        'rechecks an absent worker wake after its session read yields: %s', async scenario => {
          await pair();
          spawn({ workers: [{ task: 'finish the first pass' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [openTurn(`wake-race-${scenario}`), endTurn(`wake-race-${scenario}`, 'completed')]);
          finishAgent({ conversationId: recoveryState.WORKER }, 'The initial pass is finished');
          expect(swarmState().agents.find(agent => agent.id === 'worker-1')?.state).toBe('sleeping');
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          expect(await maintenance()).toBeNull();
    
          const staged = stageMessages({ conversationId: recoveryState.PRIME }, [{ to: 'worker-1', text: 'Review the follow-up' }]);
          staged.commit();
          const gate = faultGate();
          const original = sessionStoreModule.findSessionByConversation;
          const lookup = vi.spyOn(sessionStoreModule, 'findSessionByConversation').mockImplementationOnce(async (...args) => {
            await gate.hold();
            if (scenario === 'lookup-failed') throw new Error('synthetic wake lookup failure');
            return original(...args);
          });
          let stopped = false;
          try {
            requestWorkerRevivals(staged.waking);
            await gate.entered;
            if (scenario === 'manual-close') await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER, manual: true } });
            else if (scenario === 'wake-finished') finishAgent({ conversationId: recoveryState.WORKER }, 'No follow-up remains');
            else if (scenario === 'page-returned') await events(recoveryState.WORKER, [openTurn(`wake-returned-${scenario}`)]);
            else if (scenario === 'recovery-off') await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
            else if (scenario === 'redeemed') {
              const revival = await waitForRevival();
              await redeem(revival.id, 'wake-race-owner');
            } else if (scenario === 'bridge-stopped') { await stopBridge(); stopped = true; }
            gate.release();
            await new Promise<void>(resolve => setImmediate(resolve));
            if (!stopped) expect(await maintenance()).toBeNull();
            expect(getLog().filter(entry => entry.message.includes(`(${recoveryState.WORKER}) has no tab for its pending wake`))).toHaveLength(0);
            if (scenario === 'lookup-failed') {
              expect(getLog().some(entry => entry.message.includes('synthetic wake lookup failure'))).toBe(true);
            }
          } finally {
            gate.release(); lookup.mockRestore();
            if (stopped) bridgeState.base = `http://127.0.0.1:${await startBridge()}`;
          }
        }
      );

  it('reopens a prime whose page said done while its tools were still being called', async () => {
        await pair();
        spawn({ workers: [{ task: 'keep this run resumable' }], caller: { conversationId: recoveryState.PRIME } });
        await events(recoveryState.PRIME, [openTurn('turn-prime-parting'), endTurn('turn-prime-parting', 'completed')]);
        // A tool call inside the silence window is this app's own definition of a chat that is working, and it outranks the page's verdict at the moment of teardown.
        await attributed(recoveryState.PRIME, false, Date.now());
        await request('POST', '/closed', { body: { conversationId: recoveryState.PRIME } });
    
        expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');
        const handout = await maintenance();
        expect(chatOf(handout)).toBe(recoveryState.PRIME);
        expect(handout!.reason).toBe('no-tab');
      });

  /** A turn-scoped repair is retired only by a later turn ending, so a chat whose tab dies on the broken turn would hold it forever — and a held repair used to refuse the reopen. The tab it wanted to reload is gone; the reopen is everything that reload would have done. */
      it('lets a closed tab supersede a held unattributed repair instead of waiting behind it', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [openTurn('turn-worker-unattributed')]);
          await unattributed();
          await vi.advanceTimersByTimeAsync(15_000);
          const held = await maintenance();
          expect(chatOf(held)).toBe(recoveryState.WORKER);
          expect(held!.reason).toBe('unattributed');
    
          // Handed out but never confirmed: the browser found the tab gone before it could act.
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          const reopen = await maintenance();
          expect(chatOf(reopen)).toBe(recoveryState.WORKER);
          expect(reopen!.reason).toBe('no-tab');
          expect(reopen!.token).not.toBe(held!.token);
        } finally {
          vi.useRealTimers();
        }
      });

  /** A discarded or frozen tab still answers the extension's tab query with its URL, so neither /closed nor the silence sweep ever fire for it. The stalled report is the only signal that its page is gone or suspended, and it is owed the missing-tab decision minus the close. */
      it('hands a stalled worker tab to the browser for one reload, never a second tab', async () => {
        await pair();
        spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
        });
        await events(recoveryState.WORKER, [openTurn('turn-worker-stalled')]);
    
        const stalled = async () =>
          ((await request('POST', '/status', { body: { openConversations: [recoveryState.WORKER], stalledConversations: [recoveryState.WORKER] } })).body
            .repairs ?? []) as Array<{ conversationId: string; token: string; reason: string }>;
        const handout = (await stalled()).find((row) => row.conversationId === recoveryState.WORKER);
        expect(handout?.reason).toBe('stalled');
        expect(reopened(recoveryState.WORKER)).toEqual([]);
    
        // Confirming the reload retires the episode; a still-stalled report inside the shared cooldown is queued behind it rather than handed another reload every pass.
        const confirmed = await request('POST', `/status?repaired=${encodeURIComponent(handout!.token)}&repairAction=reloaded`, {
          body: { openConversations: [recoveryState.WORKER], stalledConversations: [] }
        });
        expect(confirmed.status).toBe(200);
        expect((await stalled()).filter((row) => row.conversationId === recoveryState.WORKER)).toEqual([]);
      });
});
