import { webProviderConversationId } from "../../../../contracts/web-providers.js";
import { beforeEach, bridgePort, bridgeState, continuationForSession, defaultConfig, describe, expect, findSessionByConversation, finishAgent, getConfig, getSession, GOAL_OBJECTIVES_STATE, GOAL_REPLIES_STATE, GOAL_SWITCHES_STATE, goalDrivingMode, goalObjectiveFor, goalPendingReplyFor, goalSwitchFor, it, openContinuationNow, pair, PRIME_CHAT, readDurable, recordFinalForTest, recoveryBrowserWake, redeem, request, resetBridgeForTests, resetGoalStateForTests, resetSwarm, retiredWorkerForConversation, saveConfig, sessionControlsFor, setGoalReplyActiveNow, setSecret, setSessionObjective, spawn, startBridge, stopBridge, swarmState, swarmStateForCaller, sweepStaleSwarm, vi, writeDurableNow } from "../../test-context.js";

describe("the goal loop over the bridge: controls and recovery", () => {
  beforeEach(async () => {
      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' }
      });
      await setSecret('openRouterApiKey', 'sk-or-bridge');
      resetGoalStateForTests();
    });

  /** Goal and Loop are one setting drawn as two switches, and this is where that is enforced. Mutual exclusion is not kept in step here, it is structural: there is a single mode with a single value, so turning either switch on is the same write with a different word in it and there is no state where both are on. What the route still has to get right is the other direction — switching one off only means something while it is the one that is running. */
    it('runs Goal or Loop but never both, and keeps the mode when a switch goes off', async () => {
      await pair();

      const loop = await request('POST', '/settings', { body: { loop: true } });
      expect(loop.status).toBe(200);
      expect(getConfig().goal).toMatchObject({ enabled: true, mode: 'loop' });
      expect(loop.body.goal).toMatchObject({ enabled: true, mode: 'loop' });
      // The page is told the mode as well, which is the whole reason it can never draw both on.
      expect((await request('GET', '/settings')).body.goal).toMatchObject({ enabled: true, mode: 'loop' });

      // Turning Goal on is what turns Loop off. One write, not two.
      expect((await request('POST', '/settings', { body: { goal: true } })).status).toBe(200);
      expect(getConfig().goal).toMatchObject({ enabled: true, mode: 'goal' });

      // Switching off the mode that is *not* running changes nothing at all.
      expect((await request('POST', '/settings', { body: { loop: false } })).status).toBe(200);
      expect(getConfig().goal).toMatchObject({ enabled: true, mode: 'goal' });

      // Switching off the one that is leaves the mode where it was: it is a preference, not a state, so switching it back on gives back what was switched off.
      expect((await request('POST', '/settings', { body: { goal: false } })).status).toBe(200);
      expect(getConfig().goal).toMatchObject({ enabled: false, mode: 'goal' });

      // A body carrying both switches describes a state that does not exist.
      const both = await request('POST', '/settings', { body: { goal: true, loop: true } });
      expect(both.status).toBe(400);
      expect(both.body.error).toBe('goal_and_loop_exclusive');
      expect(getConfig().goal.enabled).toBe(false);
    });

  /** A chat given its own goal, which is the other way into the same loop. The standing switch answers "should this app write my next message in general". A goal answers "here is where this chat has to get to" — which is a stronger statement, made about one chat, at the moment it is made. So it arms the loop on its own: somebody who has just written down the finish line should not then have to find a second switch. */
    it('arms the loop for one chat from its own goal, with the standing switch off', async () => {
      await pair();
      const chat = 'cafe0021-0000-4000-8000-000000000021';
      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: false }
      });
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{ kind: 'user_message', time: Date.now(), text: 'start the port', messageId: 'm-goal-obj' }]
        }
      });

      // A successful save is a durable state transition, not merely an in-memory UI update. Start from an explicitly empty disk row so reading it immediately after the HTTP response catches any regression back to the ordinary 300 ms debounce.
      await writeDurableNow(GOAL_OBJECTIVES_STATE, null);

      const saved = await request('POST', '/goal/objective', {
        body: { conversationId: chat, text: '  port the module and make the suite green  ' }
      });
      expect(saved.status).toBe(200);
      // Stored as it will be prompted with, and reported back rather than assumed, because the page draws its own summary line from this answer.
      expect(saved.body.objective).toBe('port the module and make the suite green');
      expect(await readDurable<{ objectives: Array<{ conversationId: string; objective: string }> }>(GOAL_OBJECTIVES_STATE)).toMatchObject({
        objectives: [
          expect.objectContaining({
            conversationId: chat,
            objective: 'port the module and make the suite green'
          })
        ]
      });

      const feed = await request('GET', `/activity?conversationId=${chat}`);
      expect(feed.body.goal).toMatchObject({
        enabled: false,
        objective: 'port the module and make the suite green',
        blocked: ''
      });

      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'the tests are still red' }) } }]
        })) as never;
      try {
        // The switch is still off, and the draft is still allowed — the goal is what allows it.
        await recordFinalForTest(chat, 'g-obj');
        const drafted = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'g-obj' } });
        expect(drafted.status).toBe(200);
        expect(getConfig().goal.enabled).toBe(false);
      } finally {
        globalThis.fetch = realFetch;
      }

      // Cleared the same way it was set, and the loop goes back to following the switch.
      const cleared = await request('POST', '/goal/objective', { body: { conversationId: chat, text: '   ' } });
      expect(cleared.body.objective).toBe('');
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.objective).toBe('');
    });

  /** The other half of that rule, and the reason the composer can offer an Off at all. A goal speaks for a chat that has never answered for itself. It does not outrank the chat's own answer: the sheet's mode slider has an Off stop, and an Off that left the loop running because a goal was still written down would be a control that says it stopped something it did not. The goal itself is kept — Off is a mode, not a delete — so moving back to Goal or Loop resumes the same sentence. */
    it('stops a chat that switched itself off, and keeps its goal for when it starts again', async () => {
      await pair();
      const chat = 'cafe0023-0000-4000-8000-000000000023';
      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: false }
      });
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{ kind: 'user_message', time: Date.now(), text: 'start the port', messageId: 'm-goal-off' }]
        }
      });
      await request('POST', '/goal/objective', { body: { conversationId: chat, text: 'port the module' } });

      // Nothing has been said about this chat's own switch yet, so its goal still speaks for it.
      const inherited = await request('GET', `/activity?conversationId=${chat}`);
      expect(inherited.body.goal).toMatchObject({ enabled: false, own: false, objective: 'port the module' });

      // Off, chosen here. The write is chat-scoped, which is what makes it this chat's own answer.
      const off = await request('POST', '/settings', { body: { conversationId: chat, goal: false } });
      expect(off.status).toBe(200);
      expect(off.body.goal).toMatchObject({ enabled: false, own: true });
      const stopped = await request('GET', `/activity?conversationId=${chat}`);
      expect(stopped.body.goal).toMatchObject({ enabled: false, own: true, objective: 'port the module' });

      const drafted = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'g-off' } });
      expect(drafted.status).toBe(409);
      expect(drafted.body.error).toBe('goal_disabled');

      // And back on, into the same goal, without retyping it.
      const on = await request('POST', '/settings', { body: { conversationId: chat, loop: true } });
      expect(on.body.goal).toMatchObject({ enabled: true, own: true, mode: 'loop' });
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'still red' }) } }]
        })) as never;
      try {
        const { recordLoopMcpProof } = await import("../../../goal-mcp-proof.js");
        await recordLoopMcpProof((await findSessionByConversation(chat, { requireUnique: true }))!.id, 'g-on');
        await recordFinalForTest(chat, 'g-on');
        const again = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'g-on' } });
        expect(again.status).toBe(200);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

  /** The run that was lost, and the reason the goal now carries its mode. A goal saved from the sheet armed the loop but said nothing about *which* loop, so the mode was read from the standing switch — off, therefore Goal, therefore allowed to stop. An unattended run started that way ended at its second turn on one "looks done" from the gate, two minutes after an identical chat with the Loop switch on had been started by hand. The mode the goal was written in is now pinned as that chat's own switch, in the same request, so nothing between the save and the first draft can answer it differently. */
    it('pins the mode a goal was written in as that chat’s own switch', async () => {
      await pair();
      const chat = 'cafe0022-0000-4000-8000-000000000022';
      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        // The exact configuration the lost run had: switched off, with `loop` sitting there as a remembered preference that nothing reads while `enabled` is false.
        goal: { ...defaultConfig().goal, backend: 'api', enabled: false, mode: 'loop' }
      });
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{ kind: 'user_message', time: Date.now(), text: 'build the sandbox', messageId: 'm-goal-mode' }]
        }
      });
      await writeDurableNow(GOAL_SWITCHES_STATE, null);

      // Without a mode, nothing changes: the standing switch still decides, and it says Goal.
      await request('POST', '/goal/objective', { body: { conversationId: chat, text: 'build the voxel sandbox' } });
      expect(goalSwitchFor(chat).own).toBe(false);
      expect(goalDrivingMode(chat)).toBe('goal');

      const looped = await request('POST', '/goal/objective', {
        body: { conversationId: chat, text: 'build the voxel sandbox', mode: 'loop' }
      });
      expect(looped.status).toBe(200);
      // Answered back rather than assumed, because the sheet draws the mode from this reply.
      expect(looped.body).toMatchObject({ objective: 'build the voxel sandbox', enabled: true, mode: 'loop' });
      expect(goalDrivingMode(chat)).toBe('loop');
      // Durable before the response was written, on the same terms as the goal itself: a mode that survives only in memory is a mode a restart turns back into a Goal that may stop.
      expect(
        await readDurable<{ switches: Array<{ conversationId: string; enabled: boolean; mode: string }> }>(GOAL_SWITCHES_STATE)
      ).toMatchObject({
        switches: [expect.objectContaining({ conversationId: chat, enabled: true, mode: 'loop' })]
      });
      // The app-wide default is untouched: this was one chat's decision, made in one chat's sheet.
      expect(getConfig().goal.enabled).toBe(false);

      // The same request is how a mode is changed, without going near the switches.
      const backToGoal = await request('POST', '/goal/objective', {
        body: { conversationId: chat, text: 'build the voxel sandbox', mode: 'goal' }
      });
      expect(backToGoal.body).toMatchObject({ enabled: true, mode: 'goal' });
      expect(goalDrivingMode(chat)).toBe('goal');

      // And clearing the goal ends the run it named. Writing the goal is what switched this chat on, so deleting it has to switch it back off — otherwise the chat keeps being prompted with no finish line left to say what for.
      const cleared = await request('POST', '/goal/objective', {
        body: { conversationId: chat, text: '', mode: 'goal' }
      });
      expect(cleared.body).toMatchObject({ objective: '', enabled: false });
      expect(goalSwitchFor(chat)).toMatchObject({ enabled: false, own: true });
    });

  /** The switch belongs to the chat it was flipped in. It used to be one app-wide setting reachable from every composer, which is the wrong shape for what people do with it: leave a loop running in one conversation while the rest stay conversations. Turning it off to stop one runaway chat stopped all of them. A chat with no answer of its own still follows the app-wide setting, so nothing that has never been touched changes behaviour — and that inheritance is what retires an old chat safely: turn Goal off where it pops up, and no later app-wide change can revive that one. */
    it('stores the Goal switch against the chat whose composer sent it', async () => {
      await pair();
      const driven = 'cafe0071-0000-4000-8000-000000000071';
      const other = 'cafe0072-0000-4000-8000-000000000072';
      for (const chat of [driven, other]) {
        await request('POST', '/events', {
          body: {
            conversationId: chat,
            events: [{ kind: 'user_message', time: Date.now(), text: 'hello', messageId: `m-switch-${chat}` }]
          }
        });
      }
      // Both inherit the app-wide setting until one of them says otherwise.
      expect((await request('GET', `/activity?conversationId=${driven}`)).body.goal.enabled).toBe(true);
      expect((await request('GET', `/activity?conversationId=${other}`)).body.goal.enabled).toBe(true);

      const off = await request('POST', '/settings', { body: { conversationId: driven, goal: false } });
      expect(off.status).toBe(200);
      expect(off.body.goal).toMatchObject({ enabled: false });
      expect((await request('GET', `/activity?conversationId=${driven}`)).body.goal.enabled).toBe(false);
      // The chat that said nothing is untouched, and so is the app-wide default it follows.
      expect((await request('GET', `/activity?conversationId=${other}`)).body.goal.enabled).toBe(true);
      expect(getConfig().goal.enabled).toBe(true);
      expect((await request('GET', '/settings')).body.goal.enabled).toBe(true);

      // Loop in one chat is Loop in that chat. The other keeps answering `goal`, which is what makes the two switches mutually exclusive per conversation rather than across the app.
      const loop = await request('POST', '/settings', { body: { conversationId: other, loop: true } });
      expect(loop.body.goal).toMatchObject({ enabled: true, mode: 'loop' });
      expect((await request('GET', `/activity?conversationId=${other}`)).body.goal).toMatchObject({
        enabled: true,
        mode: 'loop'
      });
      expect((await request('GET', `/activity?conversationId=${driven}`)).body.goal).toMatchObject({
        enabled: false,
        mode: 'goal'
      });
      expect(getConfig().goal.mode).toBe('goal');

      // A saved switch is durable before the page is told it saved, exactly like a saved goal.
      expect(
        await readDurable<{ switches: Array<{ conversationId: string; enabled: boolean; mode: string }> }>('goal-switches')
      ).toMatchObject({
        switches: expect.arrayContaining([
          expect.objectContaining({ conversationId: driven, enabled: false }),
          expect.objectContaining({ conversationId: other, enabled: true, mode: 'loop' })
        ])
      });
    });

  it.each(['browser', 'native'])('re-arms the newest completed reply when %s edits its Loop objective during compaction', async surface => {
      await pair();
      const chat = 'cafe0188-0000-4000-8000-000000000188';
      const first = await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'user_message', time: Date.now(), text: 'finish the first file', messageId: 'objective-user' },
        { kind: 'assistant_message', time: Date.now(), messageId: 'objective-old-final', turnId: 'objective-old-turn',
          text: 'First pass complete.', state: 'final', final: true, goalEligible: true, activeNow: true }
      ] } });
      const sessionId = first.body.sessionId as string;
      const continuation = await openContinuationNow(sessionId, chat);
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'assistant_message', time: Date.now(), messageId: 'objective-new-final', turnId: 'objective-new-turn',
          text: 'Second pass complete.', state: 'final', final: true, goalEligible: true, activeNow: true }
      ] } });
      // The previous decision is spent; a deliberate edit must re-arm the newest stable answer, even while the compaction operation delays browser pickup.
      await setGoalReplyActiveNow(chat, false);
      expect(goalPendingReplyFor(chat)).toBeNull();
      let acceptedAt = 0;
      for (const objective of ['Complete all three files.', 'Complete all four files.']) {
        if (surface === 'browser') {
          expect((await request('POST', '/goal/objective', { body: { conversationId: chat, text: objective, mode: 'loop' } })).status).toBe(200);
        } else await setSessionObjective(sessionId, objective, 'loop');
        const pending = goalPendingReplyFor(chat);
        expect(pending).toMatchObject({ replyId: 'objective-new-final', turnId: 'objective-new-turn' });
        expect(pending!.acceptedAt).toBeGreaterThan(acceptedAt);
        acceptedAt = pending!.acceptedAt;
        expect(goalObjectiveFor(chat)).toBe(objective);
        expect(continuationForSession(sessionId)?.token).toBe(continuation.token);
        expect(await readDurable<{ replies: unknown[] }>(GOAL_REPLIES_STATE)).toMatchObject({
          replies: expect.arrayContaining([expect.objectContaining({ conversationId: chat, replyId: 'objective-new-final', state: 'pending' })])
        });
      }
    });

  it.each(['generating', 'thinking-failed'])('does not re-arm an older final on Loop Off/On while %s', async state => {
      await pair();
      const chat = state === 'generating' ? 'cafe0077-0000-4000-8000-000000000077' : 'cafe0078-0000-4000-8000-000000000078';
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'old-question' },
        { kind: 'assistant_message', time: Date.now(), messageId: 'old-final', text: 'Finished this pass.', state: 'final', final: true, goalEligible: true, activeNow: true }
      ] } });
      await request('POST', '/settings', { body: { conversationId: chat, goal: false } });
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'user_message', time: Date.now(), text: 'new work', messageId: 'new-question' },
        { kind: 'turn_start', time: Date.now(), turnId: 'new-turn' },
        ...(state === 'thinking-failed' ? [{ kind: 'turn_end', time: Date.now(), turnId: 'new-turn', outcome: 'failed', reason: 'thinking_failed' }] : [])
      ] } });
      expect((await request('POST', '/settings', { body: { conversationId: chat, loop: true } })).status).toBe(200);
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toBeNull();
    });

  it('makes Goal Off a durable ticket cancel and On a fresh pickup of the same final', async () => {
      await pair();
      const chat = 'cafe0076-0000-4000-8000-000000000076';
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [
            { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-switch-ticket' },
            {
              kind: 'assistant_message',
              time: Date.now(),
              messageId: 'a-switch-ticket',
              text: 'Finished this pass.',
              state: 'final',
              final: true,
              goalEligible: true,
              activeNow: true
            }
          ]
        }
      });
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toMatchObject({
        replyId: 'a-switch-ticket'
      });

      expect((await request('POST', '/settings', { body: { conversationId: chat, goal: false } })).status).toBe(200);
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toBeNull();
      expect(await readDurable<{ replies: Array<{ conversationId: string; state: string }> }>(GOAL_REPLIES_STATE)).toMatchObject({
        replies: expect.arrayContaining([expect.objectContaining({ conversationId: chat, state: 'handled' })])
      });

      expect((await request('POST', '/settings', { body: { conversationId: chat, goal: true } })).status).toBe(200);
      expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toMatchObject({
        replyId: 'a-switch-ticket'
      });
    });

  /** The app watching its own ledger, because the loop's only trigger lives in the page. A content script sees a turn end and asks for a draft. That is the right place for the trigger and the wrong place for the *guarantee*: a document that dies between the final answer and that request takes the loop down with it silently, leaving an obligation correctly marked pending and nobody alive to redeem it. This is what the live prime trace was — the reply landed at 21:56:46 and the app first heard a Goal was owed at 22:00:33, when a human reloaded the page by hand. The first reload follows two minutes of grace, then two more follow five and ten minutes. A third confirmed miss is terminal for this episode, but the durable debt remains visible. */
    it('hands one queued Goal recovery to the shared browser startup owner and revokes it on Off', async () => {
      vi.useFakeTimers();
      try {
        await pair();
        const chat = webProviderConversationId('deepseek', 'cafe0173-0000-4000-8000-000000000173');
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-cold-goal' },
          { kind: 'turn_start', time: Date.now(), turnId: 'g-cold-goal' },
          { kind: 'turn_end', time: Date.now(), turnId: 'g-cold-goal', outcome: 'completed' },
          { kind: 'assistant_message', time: Date.now(), turnId: 'g-cold-goal', messageId: 'a-cold-goal', text: 'First part done.',
            state: 'final', final: true, goalEligible: true, activeNow: true }
        ] } });
        expect(goalPendingReplyFor(chat)).not.toBeNull();
        expect(recoveryBrowserWake).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect(recoveryBrowserWake).toHaveBeenCalledTimes(1);
        const [url, retry, , authority] = recoveryBrowserWake.mock.calls[0]!;
        expect(url).toBe('https://chat.deepseek.com/');
        expect(retry).toBe(true);
        expect(authority?.current).toEqual(expect.any(Function));
        expect(await authority?.current()).toBe(true);
        const config = getConfig();
        await saveConfig({ ...config, ui: { ...config.ui, browserOnly: true } });
        expect(await authority?.current()).toBe(false);
        await saveConfig(config);
        expect(await authority?.current()).toBe(true);
        await sweepStaleSwarm(Date.now());
        expect(recoveryBrowserWake).toHaveBeenCalledTimes(1);
        await request('POST', '/settings', { body: { conversationId: chat, goal: false } });
        expect(await authority?.current()).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect(recoveryBrowserWake).toHaveBeenCalledTimes(1);
      } finally { vi.useRealTimers(); }
    });

  /** A missing page pickup gets a durable, visible stop instead of an endless reload loop. */
    it('stops queued pickup after three persisted reload attempts and preserves the original input', async () => {
      vi.useFakeTimers();
      const input = await import("../../../../backend/domains/sessions/input/input.js");
      const { resetInputForTests, enqueueInput } = input;
      resetInputForTests();
      try {
        await writeDurableNow('session-input', []);
        await pair();
        const chat = webProviderConversationId('deepseek', 'cafe0175-0000-4000-8000-000000000175');
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'work', messageId: 'uncollected-user' },
          { kind: 'turn_start', time: Date.now(), turnId: 'uncollected-turn' }
        ] } });
        const session = (await findSessionByConversation(chat, { requireUnique: true }))!;
        await enqueueInput({ id: 'abca0175-0000-4000-8000-000000000175', sessionId: session.id,
          text: 'next step', mode: 'after-turn', dueAt: Date.now(), model: null, reasoningEffort: null });
        await vi.advanceTimersByTimeAsync(1);
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'turn_end', time: Date.now(), turnId: 'uncollected-turn', outcome: 'completed' }
        ] } });
        await recordFinalForTest(chat, 'uncollected-turn');

        // Reloaded on schedule and never collected, which is the whole case.
        for (const minutes of [2, 5]) {
          await vi.advanceTimersByTimeAsync(minutes * 60_000);
          await sweepStaleSwarm(Date.now());
          const repair = (await request('GET', '/status')).body.repairs?.[0];
          expect(repair).toMatchObject({ conversationId: chat, reason: 'goal' });
          await request('GET', `/status?repaired=${repair.token}&repairAction=reloaded`);
        }
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await sweepStaleSwarm(Date.now());
        const third = (await request('GET', '/status')).body.repairs?.[0];
        expect(third).toMatchObject({ conversationId: chat, reason: 'goal' });
        await request('GET', `/status?repaired=${third.token}&repairAction=reloaded`);

        const row = (await input.listInputs()).find(entry => entry.id === 'abca0175-0000-4000-8000-000000000175');
        expect(row).toMatchObject({ text: 'next step', state: 'queued', pickupRecovery: { attempts: 3, stoppedAt: Date.now() } });
        expect((await sessionControlsFor(session.id)).recovery).toContainEqual({
          kind: 'pickup-stopped', deadline: Date.now(), attempts: 3, next: 'queue'
        });

        // Dropping in-memory bridge/input state models a restart. Durable ownership restores the stopped state, so another sweep cannot reset the budget or reload this page again.
        resetBridgeForTests();
        resetInputForTests();
        await pair();
        expect((await input.listInputs()).find(entry => entry.id === row!.id)).toMatchObject({
          text: 'next step', pickupRecovery: { attempts: 3, stoppedAt: Date.now() }
        });
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await sweepStaleSwarm(Date.now());
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs?.some((repair: { conversationId: string }) => repair.conversationId === chat)).toBe(false);
        expect((await sessionControlsFor(session.id)).recovery).toContainEqual(expect.objectContaining({ kind: 'pickup-stopped', attempts: 3, next: 'queue' }));
        expect(recoveryBrowserWake).toHaveBeenCalledTimes(3);
      } finally {
        await writeDurableNow('session-input', []);
        resetInputForTests();
        vi.useRealTimers();
      }
    });

  it('does not reopen a manually dismissed chat for a failed unclaimed input at bridge startup', async () => {
      const realSetTimeout = setTimeout;
      vi.useFakeTimers();
      const input = await import("../../../../backend/domains/sessions/input/input.js");
      input.resetInputForTests();
      const before = getConfig();
      const chat = 'cafe0177-0000-4000-8000-000000000177';
      try {
        await writeDurableNow('session-input', []);
        await saveConfig({ ...before, ui: { ...before.ui, autoContinue: true } });
        await pair();
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'dismissed retry case', messageId: 'dismissed-retry-user' },
          { kind: 'turn_start', time: Date.now(), turnId: 'dismissed-retry-turn' },
          { kind: 'turn_end', time: Date.now(), turnId: 'dismissed-retry-turn', outcome: 'completed' }
        ] } });
        const session = (await findSessionByConversation(chat, { requireUnique: true }))!;
        const row = await input.enqueueInput({ id: 'abca0177-0000-4000-8000-000000000177', sessionId: session.id,
          text: 'safe synthetic browser retry', mode: 'auto', dueAt: Date.now(), model: 'gpt-5.6-sol', reasoningEffort: null });
        await request('POST', '/closed', { body: { conversationId: chat, manual: true } });
        expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBeDefined();

        // Seed only the durable state produced by the known pre-Send timeout. Startup runs the real retry monitor; the dismissed-session check must refuse it before wakeBrowserUrl.
        const rows = await input.listInputs();
        await writeDurableNow('session-input', rows.map(entry => entry.id === row.id ? {
          ...entry,
          state: 'failed' as const,
          transportIntent: 'browser' as const,
          error: 'Not sent: the browser did not pick up this message within 60 seconds.',
          createdAt: Date.now() - 180_000,
          pickupFailedAt: Date.now() - 120_000
        } : entry));
        input.resetInputForTests();

        await stopBridge();
        const port = await startBridge();
        expect(port).not.toBeNull();
        bridgeState.base = `http://127.0.0.1:${port}`;
        // startBridge starts the monitor without awaiting its best-effort scan.
        await new Promise<void>(resolve => realSetTimeout(resolve, 50));

        expect(recoveryBrowserWake).not.toHaveBeenCalled();
        expect((await input.listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed' });
        expect((await input.listInputs()).find(entry => entry.id === row.id)).not.toHaveProperty('pickupRetryCount');
      } finally {
        if (bridgePort() === null) {
          const port = await startBridge();
          if (port !== null) bridgeState.base = `http://127.0.0.1:${port}`;
        }
        await saveConfig(before);
        await writeDurableNow('session-input', []);
        input.resetInputForTests();
        vi.useRealTimers();
      }
    });

  it('shares the durable retry budget when a queued input gives its source turn back to Goal', async () => {
      vi.useFakeTimers();
      const input = await import("../../../../backend/domains/sessions/input/input.js");
      input.resetInputForTests();
      try {
        await writeDurableNow('session-input', []);
        await pair();
        const chat = 'cafe0176-0000-4000-8000-000000000176';
        const goal = await import("../../../../backend/domains/automation/goal.js");
        await goal.setGoalSwitchNow(chat, 'goal', true);
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'work', messageId: 'shared-budget-user' },
          { kind: 'turn_start', time: Date.now(), turnId: 'shared-budget-turn' }
        ] } });
        const session = (await findSessionByConversation(chat, { requireUnique: true }))!;
        const row = await input.enqueueInput({ id: 'abca0176-0000-4000-8000-000000000176', sessionId: session.id,
          text: 'next step', mode: 'after-turn', dueAt: Date.now(), model: null, reasoningEffort: null });
        await vi.advanceTimersByTimeAsync(1);
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'turn_end', time: Date.now(), turnId: 'shared-budget-turn', outcome: 'completed' },
          { kind: 'assistant_message', time: Date.now(), messageId: 'shared-budget-final', turnId: 'shared-budget-turn',
            text: 'First part done.', state: 'final', final: true, goalEligible: true, activeNow: true }
        ] } });

        for (const [index, gap] of [2, 5, 10].entries()) {
          await vi.advanceTimersByTimeAsync(gap * 60_000);
          await sweepStaleSwarm(Date.now());
          const repair = (await request('GET', '/status')).body.repairs?.find((item: { conversationId: string }) => item.conversationId === chat);
          expect(repair, `shared reload ${index + 1}`).toMatchObject({ reason: 'goal' });
          await request('GET', `/status?repaired=${repair.token}&repairAction=reloaded`);
          expect(goal.goalPendingReplyFor(chat)).toMatchObject({ pickupAttempts: index + 1 });
          if (index === 0) expect(await input.cancelInput(row.id)).toBe(true);
        }
        expect(goal.goalPendingReplyFor(chat)).toMatchObject({ pickupAttempts: 3, pickupStoppedAt: Date.now() });
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs?.some((item: { conversationId: string }) => item.conversationId === chat)).toBe(false);
      } finally {
        await writeDurableNow('session-input', []);
        input.resetInputForTests();
        vi.useRealTimers();
      }
    });

  it('gives a queued head the bounded pickup schedule without an enabled Goal', async () => {
      const { enqueueInput, cancelInput, listInputs, reorderQueuedInputs, resetInputForTests } = await import("../../../../backend/domains/sessions/input/input.js");
      vi.useFakeTimers();
      resetInputForTests();
      try {
        await writeDurableNow('session-input', []);
        await pair();
        const chat = webProviderConversationId('deepseek', 'cafe0173-0000-4000-8000-000000000173');
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'work', messageId: 'queued-watch-user' },
          { kind: 'turn_start', time: Date.now(), turnId: 'queued-watch-turn' }
        ] } });
        const session = await findSessionByConversation(chat, { requireUnique: true });
        const id = 'abca0173-0000-4000-8000-000000000173';
        const second = 'abca0174-0000-4000-8000-000000000174';
        await enqueueInput({ id, sessionId: session!.id, text: 'next step', mode: 'after-turn', dueAt: Date.now(), model: null, reasoningEffort: null });
        await enqueueInput({ id: second, sessionId: session!.id, text: 'another step', mode: 'after-turn', dueAt: Date.now(), model: null, reasoningEffort: null });
        await vi.advanceTimersByTimeAsync(1);
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'turn_end', time: Date.now(), turnId: 'queued-watch-turn', outcome: 'completed' }
        ] } });
        await recordFinalForTest(chat, 'queued-watch-turn');
        for (const [index, minutes] of [2, 5, 10].entries()) {
          await vi.advanceTimersByTimeAsync(minutes * 60_000);
          await sweepStaleSwarm(Date.now());
          const authority = recoveryBrowserWake.mock.calls.at(-1)?.[3];
          expect(authority?.current).toEqual(expect.any(Function));
          expect(await authority!.current()).toBe(true);
          const repair = (await request('GET', '/status')).body.repairs?.[0];
          expect(repair).toMatchObject({ conversationId: chat, reason: 'goal' });
          await request('GET', `/status?repaired=${repair.token}&repairAction=reloaded`);
          if (index === 0) expect(await reorderQueuedInputs(session!.id, [second, id])).toBe(true);
          if (index === 1) expect(await cancelInput(second)).toBe(true);
          if (index === 2) await request('POST', '/settings', { body: { conversationId: chat, goal: false } });
        }
        const stopped = (await listInputs()).find(item => item.id === id);
        expect(stopped).toMatchObject({ text: 'next step', pickupRecovery: { attempts: 3, stoppedAt: Date.now() } });
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs).toEqual([]);
        await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs).toEqual([]);
        expect(await cancelInput(id)).toBe(true);
      } finally {
        await writeDurableNow('session-input', []);
        resetInputForTests();
        vi.useRealTimers();
      }
    });

  it('does not recover restored Goal debt over a newer question', async () => {
      vi.useFakeTimers();
      try {
        await pair();
        const chat = 'cafe0073-0000-4000-8000-000000000173';
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'first question', messageId: 'old-question' },
          { kind: 'turn_start', time: Date.now(), turnId: 'old-source' },
          { kind: 'turn_end', time: Date.now(), turnId: 'old-source', outcome: 'completed' },
          { kind: 'assistant_message', time: Date.now(), turnId: 'old-source', messageId: 'old-answer',
            text: 'First pass', final: true, state: 'final', goalEligible: true, activeNow: true }
        ] } });
        const goal = await import("../../../../backend/domains/automation/goal.js");
        const saved = goal.snapshotGoalReplies();
        expect(goal.goalPendingReplyFor(chat)).not.toBeNull();
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'new question', messageId: 'new-question' }
        ] } });
        goal.restoreGoalReplies({ ...saved, replies: saved.replies.map(row => ({ ...row, acceptedAt: Date.now() - 60_000 })) });
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs).toEqual([]);
      } finally { vi.useRealTimers(); }
    });

  it.each([false, true])('bounds Goal pickup at three reloads, including restored debt (%s)', async restored => {
      vi.useFakeTimers();
      try {
        await pair();
        const chat = 'cafe0073-0000-4000-8000-000000000073';
        const goal = await import("../../../../backend/domains/automation/goal.js");
        await goal.setGoalSwitchNow(chat, 'goal', true);
        await request('POST', '/events', {
          body: {
            conversationId: chat,
            events: [
              { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-watchdog' },
              { kind: 'turn_start', time: Date.now(), turnId: 'g-watchdog' },
              { kind: 'turn_end', time: Date.now(), turnId: 'g-watchdog', outcome: 'completed' }
            ]
          }
        });
        await request('POST', '/events', {
          body: {
            conversationId: chat,
            events: [{
              kind: 'assistant_message',
              time: Date.now(),
              messageId: 'a-watchdog',
              turnId: 'g-watchdog',
              text: 'Done with that part.',
              state: 'final',
              final: true,
              // What the page says when it has just watched this exact answer settle. It is the page's verdict that mints the obligation, and the whole point of the watchdog is that the page can die between minting it and coming back to redeem it.
              goalEligible: true,
              activeNow: true
            }]
          }
        });
        const activity = (await request('GET', `/activity?conversationId=${chat}`)).body;
        expect(activity.goal.pending).not.toBeNull();
        const sessionId = activity.sessionId as string;

        if (restored) {
          const saved = goal.snapshotGoalReplies();
          // The durable obligation predates bridge startup, as it would after an app restart.
          resetBridgeForTests();
          await pair();
          goal.restoreGoalReplies({ ...saved, replies: saved.replies.map(row => row.conversationId === chat
            ? { ...row, acceptedAt: Date.now() - 60_000 } : row) });
        }

        const takeRepair = async (): Promise<{ conversationId: string; token: string; reason: string } | null> => {
          await sweepStaleSwarm(Date.now());
          return (await request('GET', '/status')).body.repairs?.[0] ?? null;
        };

        // The page owns the first two minutes. Nothing is wrong with a chat whose script is simply taking a moment to ask.
        await vi.advanceTimersByTimeAsync(2 * 60_000 - 1_000);
        expect(await takeRepair()).toBeNull();

        // Two minutes, then five and ten between retries. Each reload is confirmed the way the extension confirms it, so this measures three completed attempts, not an unclaimed offer.
        const gaps = [1_000, 5 * 60_000, 10 * 60_000];
        for (const [index, gap] of gaps.entries()) {
          await vi.advanceTimersByTimeAsync(gap);
          const handout = await takeRepair();
          expect(handout, `reload ${index + 1} of ${gaps.length}`).toMatchObject({
            conversationId: chat,
            reason: 'goal'
          });
          // An unclaimed offer retains the exact token. After claiming, missing acknowledgement may not authorize another browser action.
          expect((await request('GET', '/status')).body.repairs).toEqual([expect.objectContaining({ token: handout!.token })]);
          expect((await request('POST', '/repairs/claim', { body: { token: handout!.token } })).body.allowed).toBe(true);
          expect((await request('GET', '/status')).body.repairs).toEqual([]);
          expect((await request('GET', '/status')).body.repairs).toEqual([]);
          expect((await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`)).status).toBe(200);
          // No second reload is queued until the next persisted deadline.
          expect(await takeRepair()).toBeNull();
        }

        expect((await sessionControlsFor(sessionId)).recovery).toContainEqual(expect.objectContaining({
          kind: 'pickup-stopped', attempts: 3, next: 'goal'
        }));
        expect(goal.goalPendingReplyFor(chat)).toMatchObject({ pickupAttempts: 3, pickupStoppedAt: Date.now() });
        expect(await goal.setGoalReplyActiveNow(chat, false)).toBe(true);
        expect(await goal.setGoalReplyActiveNow(chat, true)).toBe(true);
        expect(goal.goalPendingReplyFor(chat)).toMatchObject({ pickupAttempts: 3, pickupStoppedAt: expect.any(Number) });
        const stoppedSnapshot = goal.snapshotGoalReplies();
        const switchSnapshot = goal.snapshotGoalSwitches();
        resetBridgeForTests();
        goal.resetGoalStateForTests();
        goal.restoreGoalReplies(stoppedSnapshot);
        goal.restoreGoalSwitches(switchSnapshot);
        await pair();
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(await takeRepair()).toBeNull();

        // The existing durable expiry still bounds unattended browser recovery.
        await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
        expect(await takeRepair()).toBeNull();
        expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

  /** Collected is collected, and only collecting counts. A finished response is not a pickup — the whole failure this watches for happens *after* the response is finished. The obligation is discharged by the page acknowledging a terminal decision, and that is the exact moment the schedule ends. */
    it('stops watching a goal the page comes and collects', async () => {
      vi.useFakeTimers();
      try {
        await pair();
        const chat = 'cafe0074-0000-4000-8000-000000000074';
        await request('POST', '/events', {
          body: {
            conversationId: chat,
            events: [
              { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-collected' },
              {
                kind: 'assistant_message',
                time: Date.now(),
                messageId: 'a-collected',
                text: 'All done.',
                state: 'final',
                final: true,
                goalEligible: true,
                activeNow: true
              }
            ]
          }
        });
        const pending = (await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending;
        expect(pending).not.toBeNull();

        const realFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
          Response.json({
            choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }]
          })) as never;
        try {
          const drafted = await request('POST', '/goal/draft', {
            body: { conversationId: chat, turnId: pending.turnId, terminalRequired: true, clientId: 'collector' }
          });
          expect(drafted.status).toBe(200);
          await vi.waitFor(async () => {
            const view = (await request('GET', `/activity?conversationId=${chat}&goalClient=collector`)).body.goal.draft;
            expect(view?.stage).toBe('no-reply');
          });
          const decided = (await request('GET', `/activity?conversationId=${chat}&goalClient=collector`)).body.goal.draft;
          expect((await request('POST', '/goal/ack', {
            body: { conversationId: chat, token: decided.token, clientId: 'collector' }
          })).body.acknowledged).toBe(true);
        } finally {
          globalThis.fetch = realFetch;
        }

        await vi.advanceTimersByTimeAsync(40 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

  /** The worker rule, applied to the goal as well as to the draft. Refusing to *hold* a goal for a worker, rather than only refusing to act on one, keeps the rule in one place — nothing downstream has to remember that this particular stored goal is one it must never use. The feed says why, because a switch drawn off for a reason nobody stated reads as a setting that failed to save. */
    it('refuses to hold a goal for a worker chat, and says so on the feed', async () => {
      await pair();
      spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const worker = 'cafe0022-0000-4000-8000-000000000022';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
      });

      await request('POST', '/events', {
        body: {
          conversationId: worker,
          events: [{ kind: 'user_message', time: Date.now(), text: 'go', messageId: 'm-goal-worker' }]
        }
      });

      const refused = await request('POST', '/goal/objective', {
        body: { conversationId: worker, text: 'finish the audit' }
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('goal_worker_chat');

      const feed = await request('GET', `/activity?conversationId=${worker}`);
      expect(feed.body.goal).toMatchObject({ enabled: false, objective: '', blocked: 'worker' });
    });

  it('keeps the worker Goal fence after its owner parks', async () => {
      await pair();
      spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const worker = 'cafe0023-0000-4000-8000-000000000023';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
      });

      finishAgent({ conversationId: worker }, 'audit complete for now');
      expect(swarmState().running).toBe(true);
      expect(await sweepStaleSwarm()).toBe(true);
      expect(swarmState().running).toBe(false);
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping',
        conversationId: worker
      });

      const refused = await request('POST', '/goal/objective', {
        body: { conversationId: worker, text: 'keep doing extra work after you stopped' }
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('goal_worker_chat');
      const feed = await request('GET', `/activity?conversationId=${worker}`);
      expect(feed.body.goal).toMatchObject({ enabled: false, objective: '', blocked: 'worker' });
    });

  it('keeps the Goal fence on an explicitly retired worker conversation', async () => {
      await pair();
      spawn({ workers: [{ task: 'temporary worker' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const worker = 'cafe0026-0000-4000-8000-000000000026';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
      });
      resetSwarm();
      expect(retiredWorkerForConversation(worker)).toMatchObject({ id: 'worker-1', conversationId: worker });

      const refused = await request('POST', '/goal/objective', {
        body: { conversationId: worker, text: 'restart this cleared worker as a Goal chat' }
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('goal_worker_chat');
      expect((await request('GET', `/activity?conversationId=${worker}`)).body.goal).toMatchObject({
        objective: '',
        blocked: 'worker'
      });
    });

  it('keeps the worker Goal fence after explicit swarm clear retires its conversation', async () => {
      await pair();
      spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const worker = 'cafe0024-0000-4000-8000-000000000024';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
      });

      resetSwarm();
      expect(retiredWorkerForConversation(worker)).toMatchObject({ id: 'worker-1', conversationId: worker });

      const refused = await request('POST', '/goal/objective', {
        body: { conversationId: worker, text: 'keep doing extra work after explicit clear' }
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('goal_worker_chat');

      const feed = await request('GET', `/activity?conversationId=${worker}`);
      expect(feed.body.goal).toMatchObject({ enabled: false, objective: '', blocked: 'worker' });
      expect(feed.body.retiredWorker).toMatchObject({ id: 'worker-1', conversationId: worker });
    });

  /** The one goal message that cannot be keyed by conversation, because sending it is what makes ChatGPT issue the conversation. */
    it('writes the opening message of a chat that does not exist yet', async () => {
      await pair();
      let seen: Array<{ role: string; content: string }> = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        seen = (JSON.parse(String(init.body)) as { messages: typeof seen }).messages;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'rewrite the parser in rust' }) } }]
        });
      }) as never;

      try {
        const opened = await request('POST', '/goal/open', { body: { text: 'rewrite the parser in rust' } });
        expect(opened.status).toBe(200);
        expect(opened.body).toEqual({
          reply: 'rewrite the parser in rust',
          model: 'deepseek/deepseek-v4-flash'
        });
        // The opening turn is the last *conversation* message; the closing reminder the goal loop appends after the transcript is a system message and sits behind it.
        expect(seen.filter((message) => message.role !== 'system').at(-1)!.content).toContain(
          'has not started yet'
        );

        // Nothing to open with is a bad request, not an empty message typed into somebody's chat.
        const blank = await request('POST', '/goal/open', { body: { text: '   ' } });
        expect(blank.status).toBe(400);
        expect(blank.body.error).toBe('no_objective');

        await setSecret('openRouterApiKey', '');
        const keyless = await request('POST', '/goal/open', { body: { text: 'ship it' } });
        expect(keyless.status).toBe(409);
        expect(keyless.body.error).toBe('no_api_key');
      } finally {
        globalThis.fetch = realFetch;
      }
    });

  it('marks a rate-limited New Chat opening as retryable', async () => {
      await pair();
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({ error: { message: 'Provider returned error' } }, { status: 429 })) as never;

      try {
        const opened = await request('POST', '/goal/open', { body: { text: 'rewrite the parser in rust' } });
        expect(opened.status).toBe(502);
        expect(opened.body).toEqual({
          error: 'rate_limited: Provider returned error',
          message: 'The continuation provider is rate-limiting requests. Wait for the displayed retry, or choose another continuation model.',
          messageKey: 'rate_limited',
          retryable: true
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

  /** The settings, read by a composer that is in no chat yet. `/activity` carries the same two switches, and it is addressed by conversation — which a New Chat has none of, and a New Chat is where a goal writes the first message. Nothing conversation-scoped may appear here, because there is no conversation to scope it to. */
    it('reports the settings without a conversation to report them for', async () => {
      await pair();
      const reply = await request('GET', '/settings');
      expect(reply.status).toBe(200);
      expect(reply.body.goal).toEqual({
        backend: 'api',
        provider: 'openrouter',
        enabled: true,
        // The app-wide setting belongs to no chat, so it is nobody's own answer: this is what a chat that has never moved its own switch inherits.
        own: false,
        mode: 'goal',
        hasKey: true,
        model: 'deepseek/deepseek-v4-flash',
        objective: '',
        blocked: ''
      });
      expect(reply.body.context).toMatchObject({ auto: expect.any(Boolean) });

      // Read-only: the switches still change through the POST and nowhere else.
      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: false }
      });
      expect((await request('GET', '/settings')).body.goal.enabled).toBe(false);
      expect((await request('GET', '/settings', { auth: null })).status).toBe(401);
    });

  /** Same credential rule as everywhere else on this server. */
    it('refuses every goal route without the bearer token', async () => {
      await pair();
      const routes: Array<[string, Record<string, unknown>]> = [
        ['/goal/draft', { conversationId: 'cafe0003-0000-4000-8000-000000000003', turnId: 'g-1' }],
        ['/goal/ack', { conversationId: 'cafe0003-0000-4000-8000-000000000003', token: 'x' }],
        ['/goal/objective', { conversationId: 'cafe0003-0000-4000-8000-000000000003', text: 'finish it' }],
        ['/goal/open', { text: 'finish it' }],
        ['/settings', { goal: true }]
      ];
      for (const [route, body] of routes) {
        const reply = await request('POST', route, { body, auth: null });
        expect(reply.status, route).toBe(401);
      }
    });
});
