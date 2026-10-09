import { randomUUID } from "node:crypto";
import { webProviderConversationId } from "../../../../../contracts/web-providers.js";
import { acceptGoalReplyNow, beforeEach, CHAT_SILENCE_MS, describe, expect, findSessionByConversation, getConfig, getSession, goalPendingReplyFor, it, pair, PRO_ACTIVITY_MS, PRO_SILENCE_MS, recordChatObservations, recordFinalForTest, recordToolCall, request, resetGoalStateForTests, saveConfig, sessionControlsFor, setChatBlocked, setGoalReplyActiveNow, setSecret, sweepStaleSwarm, vi } from "../../../test-context.js";
import { attributed, endTurn, events, maintenance, maintenanceBatch, openTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: provider activity and finality", () => {
  beforeEach(resetRecoveryFixture);

  it.each(['late picker', 'exact call', 'picker after start in same batch'])('resolves an initially unknown Pro turn through %s before silence recovery', async proof => {
        const id = proof === 'late picker' ? 'a2222222-1111-4111-8111-111111111111' : proof === 'exact call' ? 'a3333333-1111-4111-8111-111111111111' : 'a4444444-1111-4111-8111-111111111111';
        vi.useFakeTimers();
        try {
          await pair();
          const began = Date.now();
          const picker = { kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: began };
          await events(id, proof === 'picker after start in same batch' ? [openTurn('late-pro'), picker] : [openTurn('late-pro')]);
          if (proof !== 'exact call') await attributed(id, false, Date.now());
          const sessionId = (await request('GET', `/activity?conversationId=${id}`)).body.sessionId;
          if (proof !== 'picker after start in same batch') {
            await vi.advanceTimersByTimeAsync(60_000);
            if (proof === 'late picker') await events(id, [{ ...picker, time: Date.now() }]);
            else {
              const { observeSessionModel } = await import("../../../../../backend/domains/sessions/history/store.js");
              await observeSessionModel(sessionId, id, 'gpt-6-pro', Date.now(), 'pro');
              await attributed(id, false, Date.now());
            }
          }
          const evidenceAt = proof === 'exact call' ? began + 60_000 : began;
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(evidenceAt + PRO_ACTIVITY_MS);
          await vi.advanceTimersByTimeAsync(evidenceAt + PRO_SILENCE_MS - Date.now() - 1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ reason: 'silence' });
        } finally { vi.useRealTimers(); }
      });

  it.each(['gpt-6-pro', 'gpt-5-6-pro'])('extends %s activity from fresh observed tool starts and exact calls, not replayed tool rows', async model => {
        const timingChat = model === 'gpt-6-pro' ? 'a1111111-1111-4111-8111-111111111111' : 'a5555555-1111-4111-8111-111111111111';
        vi.useFakeTimers();
        try {
          await pair();
          const began = Date.now();
          await events(timingChat, [{ kind: 'model_selection', model, reasoningEffort: 'pro', time: began }, openTurn('pro-tools')]);
          const sessionId = (await request('GET', `/activity?conversationId=${timingChat}`)).body.sessionId;
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          await vi.advanceTimersByTimeAsync(60_000);
          const tool = { kind: 'page_tool', turnId: 'pro-tools', messageId: 'pro-native-tool', text: 'Searching files', activeNow: true, time: Date.now() };
          await events(timingChat, [tool]);
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(began + 60_000 + PRO_ACTIVITY_MS);
          await vi.advanceTimersByTimeAsync(60_000);
          await events(timingChat, [{ ...tool, time: Date.now(), text: 'Searched files' }]);
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(began + 60_000 + PRO_ACTIVITY_MS);
          await attributed(timingChat, false, Date.now());
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(began + 120_000 + PRO_ACTIVITY_MS);
        } finally { vi.useRealTimers(); }
      });

  it.each(['pro', 'other'] as const)('preserves %s activity and recovery when reload revises older finals', async model => {
        const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
        vi.useFakeTimers();
        try {
          await pair();
          const oldFinal = { kind: 'assistant_message', messageId: 'reload-old-final', turnId: 'reload-old-turn',
            text: 'Earlier task completed.', state: 'final', final: true, time: Date.now() };
          await events(recoveryState.OTHER, [openTurn('reload-old-turn'), oldFinal, endTurn('reload-old-turn', 'completed')]);
          await vi.advanceTimersByTimeAsync(1000);
          await events(recoveryState.OTHER, [
            { kind: 'user_message', messageId: 'reload-current-question', text: 'Continue the work.', time: Date.now() },
            { kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol',
              reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() }, openTurn('reload-current-turn')
          ]);
          await attributed(recoveryState.OTHER, false, Date.now());
          const sessionId = (await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.sessionId;
          const deadline = Date.now() + (model === 'pro' ? PRO_SILENCE_MS : CHAT_SILENCE_MS);
          const activityExpiry = sessionActivityExpiresAt((await getSession(sessionId))!);
          const countdown = (await sessionControlsFor(sessionId)).recovery;
          expect(countdown).toEqual([{ kind: 'silence', deadline,
            visibleAt: deadline - (model === 'pro' ? 5 * 60_000 : 30_000) }]);
          await vi.advanceTimersByTimeAsync(model === 'pro' ? 7 * 60_000 : 60_000);
          // Replacing the document republishes old request-owned finals with fresh observations that cannot finish the current turn.
          await events(recoveryState.OTHER, [{ ...oldFinal, time: Date.now(), activeNow: true }]);
          expect((await getSession(sessionId))?.activeTurnId).toBe('reload-current-turn');
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(activityExpiry);
          expect((await sessionControlsFor(sessionId)).recovery).toEqual(countdown);
          expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.recordedTurnId).toBe('reload-current-turn');
          await vi.advanceTimersByTimeAsync(deadline - Date.now());
          await sweepStaleSwarm(Date.now());
          const repair = (await maintenanceBatch()).find(row => row.conversationId === recoveryState.OTHER);
          expect(repair).toMatchObject({ reason: 'silence' });
          await maintenanceBatch(repair!.token, 'reloaded');
          const afterReload = (await sessionControlsFor(sessionId)).recovery;
          expect(afterReload?.length).toBeGreaterThan(0);
          await events(recoveryState.OTHER, [{ ...oldFinal, time: Date.now(), activeNow: true }]);
          expect((await sessionControlsFor(sessionId)).recovery).toEqual(afterReload);
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it.each(['ds', 'ap'] as const)('does not retain ChatGPT silence or injection authority after a local %s tool turn completes', async prefix => {
        await pair();
        const chat = `${prefix}-${randomUUID()}`;
        const turnId = 'local-completed-tool-turn';
        const requestId = `local-request-${randomUUID()}`;
        await recordChatObservations(chat, [{ kind: 'turn_start', turnId, time: Date.now() }, { kind: 'tool_evidence', time: Date.now(),
          calls: [{ messageId: 'local-read', tool: 'read', order: 0, answered: false, requestId }] }]);
        await recordToolCall({ tool: 'read', args: { paths: ['/project'] }, content: [{ type: 'text', text: 'ok' }],
          outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
        await recordChatObservations(chat, [{ kind: 'assistant_message', messageId: 'local-final', turnId, time: Date.now(),
          text: 'Done.', final: true, state: 'final', activeNow: true }, { kind: 'turn_end', turnId, time: Date.now(), outcome: 'completed' }]);
        const sessionId = (await findSessionByConversation(chat))!.id;
        const summary = (await getSession(sessionId))!;
        const { sessionInputActivity, sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
        expect(sessionInputActivity(summary)).toEqual({ possible: false, exact: false });
        expect(sessionActivityExpiresAt(summary)).toBeNull();
        expect((await sessionControlsFor(sessionId)).recovery).toEqual([]);
        const { sessionInputPolicy } = await import("../../../../../backend/domains/sessions/input/input.js");
        expect(await sessionInputPolicy(sessionId, sessionInputActivity(summary))).toMatchObject({ settled: true, canInject: false });
      });

  it.each(['pro', 'other'] as const)('keeps completed native %s replies idle when their request delivers trailing tools', async model => {
        const chat = model === 'pro' ? 'a2222222-1111-4111-8111-000000000091' : 'a2222222-1111-4111-8111-000000000092';
        const turnId = 'native-trailing-tools';
        const requestId = `wfr_native_trailing_${model}`;
        vi.useFakeTimers();
        try {
          await pair();
          await events(chat, [
            { kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() },
            openTurn(turnId),
            { kind: 'tool_evidence', time: Date.now(), calls: [{ messageId: 'trailing-proof', tool: 'read', order: 0, answered: false, requestId }] }
          ]);
          const tool = () => recordToolCall({ tool: 'read', args: { paths: ['/project/a.ts'] },
            content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
          await tool();
          const sessionId = (await request('GET', `/activity?conversationId=${chat}`)).body.sessionId;
          const { sessionInputActivity, sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          await vi.advanceTimersByTimeAsync(1000);
          await events(chat, [{ kind: 'assistant_message', messageId: 'trailing-native-answer', turnId, time: Date.now(),
            providerMessageId: '11111111-2222-4333-8444-555555555555', text: 'The requested check is complete.',
            final: true, state: 'final', activeNow: true }, endTurn(turnId, 'completed')]);
          await vi.advanceTimersByTimeAsync(3000);
          await tool();
          const summary = (await getSession(sessionId))!;
          expect(summary.activeTurnId).toBeNull();
          expect(sessionActivityExpiresAt(summary)).toBeNull();
          expect(sessionInputActivity(summary)).toMatchObject({ exact: false, possible: false });
          expect((await sessionControlsFor(sessionId)).recovery).toEqual([]);
          const { readCompletedFinal, readEvents } = await import("../../../../../backend/domains/sessions/history/store.js");
          expect(await readCompletedFinal(sessionId, chat)).toMatchObject({ messageId: 'trailing-native-answer' });
          const { sessionInputPolicy } = await import("../../../../../backend/domains/sessions/input/input.js");
          expect(await sessionInputPolicy(sessionId, sessionInputActivity(summary))).toMatchObject({
            settled: true, browserAllowed: true, canInject: false
          });
          const history = await readEvents(sessionId);
          const lastCall = history.findLastIndex(event => event.kind === 'tool_call');
          expect(lastCall).toBeLessThan(history.findIndex(event => event.kind === 'assistant_message'));
          await vi.advanceTimersByTimeAsync(PRO_ACTIVITY_MS + CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect((await sessionControlsFor(sessionId)).recovery).toEqual([]);
          expect((await maintenanceBatch()).some(repair => repair.conversationId === chat)).toBe(false);
          await events(chat, [openTurn('next-native-turn')]);
          const next = (await getSession(sessionId))!;
          const nextExpiry = sessionActivityExpiresAt(next);
          await vi.advanceTimersByTimeAsync(1000);
          await tool();
          expect((await getSession(sessionId))?.activeTurnId).toBe('next-native-turn');
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(nextExpiry);
        } finally { vi.useRealTimers(); }
      });

  it('says a Goal waits for the closed chat to open again, instead of "Answer settling"', async () => {
        const chat = 'a2222222-1111-4111-8111-000000000091';
        vi.useFakeTimers();
        try {
          await pair();
          await events(chat, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('closed-goal-turn')]);
          const sessionId = (await request('GET', `/activity?conversationId=${chat}`)).body.sessionId;
          const { setSessionAutomation } = await import("../../../../../backend/domains/browser/bridge.js");
          await setSessionAutomation(sessionId, 'loop', true);
          await attributed(chat, false, Date.now());
          await vi.advanceTimersByTimeAsync(1000);
          await events(chat, [{ kind: 'assistant_message', messageId: 'closed-goal-final', turnId: 'closed-goal-turn', time: Date.now(),
            text: 'Done.', final: true, state: 'final', activeNow: true, goalEligible: true }, endTurn('closed-goal-turn', 'completed')]);
          expect((await sessionControlsFor(sessionId)).goalWait).toEqual({ reason: 'settling' });
          // The person closes the tab before the page asked for a decision: the turn stays owed, and browser recovery waits for the page, so nothing is settling any more.
          await request('POST', '/closed', { body: { conversationId: chat, manual: true } });
          expect((await sessionControlsFor(sessionId)).goalWait).toEqual({ reason: 'closed' });
          await vi.advanceTimersByTimeAsync(60 * 60_000);
          expect((await sessionControlsFor(sessionId)).goalWait).toEqual({ reason: 'closed' });
          // The page returns: the owed turn is collected there again.
          await request('GET', `/activity?conversationId=${chat}`);
          expect((await sessionControlsFor(sessionId)).goalWait).toEqual({ reason: 'settling' });
        } finally { vi.useRealTimers(); }
      });

  it.each(['pro', 'other'] as const)('retires silence recovery on the full final and ignores late pre-final calls for %s', async model => {
        const chat = model === 'pro' ? 'a2222222-1111-4111-8111-000000000081' : 'a2222222-1111-4111-8111-000000000082';
        vi.useFakeTimers();
        try {
          await pair();
          await events(chat, [{ kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() }, openTurn('mcp-native-final')]);
          const sessionId = (await request('GET', `/activity?conversationId=${chat}`)).body.sessionId;
          const { sessionInputActivity, setSessionAutomation } = await import("../../../../../backend/domains/browser/bridge.js");
          await setSessionAutomation(sessionId, 'loop', true);
          await attributed(chat, false, Date.now());
          const lastWork = Date.now();
          await vi.advanceTimersByTimeAsync(1000);
          await events(chat, [{ kind: 'assistant_message', messageId: 'native-final', turnId: 'mcp-native-final', time: Date.now(),
            text: 'The page says complete.', final: true, state: 'final', activeNow: true, goalEligible: true }, endTurn('mcp-native-final', 'completed')]);
          expect((await getSession(sessionId))?.activeTurnId).toBeNull();
          expect(sessionInputActivity((await getSession(sessionId))!)).toMatchObject({ exact: false, possible: false });
          expect((await sessionControlsFor(sessionId)).goalWait).toEqual({ reason: 'settling' });
          expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.wait).toEqual({ reason: 'settling' });
          // Recording a pre-final call late cannot recreate the consumed silence window.
          await vi.advanceTimersByTimeAsync(1000);
          await attributed(chat, false, lastWork);
          expect(sessionInputActivity((await getSession(sessionId))!)).toMatchObject({ exact: false, possible: false });
          expect(sessionInputActivity((await getSession(sessionId))!).turnId).toBeUndefined();
          await setSessionAutomation(sessionId, 'off'); await setSessionAutomation(sessionId, 'loop', true);
          expect(goalPendingReplyFor(chat)?.replyId).toBe('native-final');
        } finally { vi.useRealTimers(); }
      });

  it.each(['normal', 'pro'] as const)('renews %s activity and silence recovery when the stopped request keeps working after its finish hold was released', async model => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true },
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), turnId = 'stop-with-continued-mcp', requestId = `wfr_stop_${++recoveryState.requests}`;
          await events(chat, [
            { kind: 'user_message', messageId: 'stop-question', text: 'Finish the requested work.', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() },
            openTurn(turnId),
            { kind: 'tool_evidence', time: Date.now(), turnId, calls: [{ messageId: 'stop-call', tool: 'read', order: 0, answered: false, requestId }] }
          ]);
          const session = (await findSessionByConversation(chat))!;
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          const { sessionWorkingAt } = await import("../../../../../contracts/sessions/activity-state.js");
          const { releaseSessionFinish } = await import("../../../../../backend/domains/sessions/input/finish.js");
          const call = (startedAt = Date.now()) => recordToolCall({ tool: 'read', args: { paths: ['/project/a.ts'] },
            content: [{ type: 'text' as const, text: 'ok' }], outcome: 'ok' as const, durationMs: 1, startedAt, requestId });
          await call();
          await vi.advanceTimersByTimeAsync(1000);
          const stoppedAt = Date.now();
          const originalDeadline = sessionActivityExpiresAt((await getSession(session.id))!);
          await releaseSessionFinish(session.id, turnId, 'stop');
          await events(chat, [endTurn(turnId, 'stopped')]);
          // A stopped page view cannot erase the activity already earned by real MCP. It still blocks input/reload until exact subsequent work reopens the source.
          expect(sessionActivityExpiresAt((await getSession(session.id))!)).toBe(originalDeadline);
          expect((await sessionControlsFor(session.id)).activeTurnId).toBeNull();
          expect((await sessionControlsFor(session.id)).canInject).toBe(false);
          await call(stoppedAt - 1);
          expect((await getSession(session.id))?.activeTurnId).toBeNull();
          expect(sessionActivityExpiresAt((await getSession(session.id))!)).toBe(originalDeadline);
          await vi.advanceTimersByTimeAsync(1000);
          await call();
          const resumed = (await getSession(session.id))!;
          expect(resumed.activeTurnId).toBe(turnId);
          expect(resumed.finishTurn?.released).toBe(true);
          expect(sessionWorkingAt({ ...resumed, activityExpiresAt: sessionActivityExpiresAt(resumed) }, Date.now())).toBe(true);
          expect(sessionActivityExpiresAt(resumed)).toBe(Date.now() + (model === 'pro' ? PRO_ACTIVITY_MS : 3 * 60_000));
          expect((await maintenanceBatch()).filter(row => row.conversationId === chat)).toEqual([]);
          await vi.advanceTimersByTimeAsync((model === 'pro' ? PRO_SILENCE_MS : CHAT_SILENCE_MS) + 1);
          await sweepStaleSwarm(Date.now());
          const repair = (await maintenanceBatch()).find(row => row.conversationId === chat);
          expect(repair).toMatchObject({ conversationId: chat, reason: 'silence' });
          expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(true);
          // A subsequently discovered real final consumes the same source and its repair.
          await recordFinalForTest(chat, turnId);
          await events(chat, [endTurn(turnId, 'completed')]);
          expect(sessionActivityExpiresAt((await getSession(session.id))!)).toBeNull();
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  for (const outcome of ['completed', 'stopped', 'failed', 'unknown']) it(`ends Pro activity immediately on ${outcome} and revives only from a newer exact call`, async () => {
        const timingChat = `a2222222-1111-4111-8111-00000000000${['completed', 'stopped', 'failed', 'unknown'].indexOf(outcome)}`;
        vi.useFakeTimers();
        try {
          await pair();
          await events(timingChat, [{ kind: 'model_selection', model: 'gpt-6', reasoningEffort: 'pro', time: Date.now() }, openTurn('pro-terminal')]);
          const sessionId = (await request('GET', `/activity?conversationId=${timingChat}`)).body.sessionId;
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          await vi.advanceTimersByTimeAsync(1_000);
          const end = Date.now();
          await events(timingChat, [endTurn('pro-terminal', outcome)]);
          expect((await getSession(sessionId))?.selectedModel).toMatchObject({ model: 'gpt-6', reasoningEffort: 'pro' });
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBeNull();
          await attributed(timingChat, false, end - 1);
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBeNull();
          await vi.advanceTimersByTimeAsync(1_000);
          await attributed(timingChat, false, Date.now());
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(Date.now() + PRO_ACTIVITY_MS);
        } finally { vi.useRealTimers(); }
      });

  it('keeps a stopped non-Pro chat idle when its partial answer is revised and a late tool settles', async () => {
        const timingChat = 'a3333333-1111-4111-8111-000000000009';
        vi.useFakeTimers();
        try {
          await pair();
          await events(timingChat, [openTurn('stopped-partial'), {
            kind: 'assistant_message', time: Date.now(), turnId: 'stopped-partial', messageId: 'partial-answer',
            text: 'Working', state: 'streaming', activeNow: true
          }]);
          const sessionId = (await request('GET', `/activity?conversationId=${timingChat}`)).body.sessionId;
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          await vi.advanceTimersByTimeAsync(1_000);
          await events(timingChat, [endTurn('stopped-partial', 'stopped')]);
          await events(timingChat, [{ kind: 'assistant_message', time: Date.now(), messageId: 'partial-answer',
            text: 'Re-observed partial answer', state: 'streaming', activeNow: true }]);
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBeNull();
          await attributed(timingChat, false, Date.now());
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBeNull();
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS + 1);
          await sweepStaleSwarm(Date.now());
          // Other recorded fixture chats can become due while fake time advances. Stop revokes this exact source; it does not cancel another chat's repair.
          expect((await maintenanceBatch()).filter(repair => repair.conversationId === timingChat)).toEqual([]);
          await events(timingChat, [openTurn('new-work')]);
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).not.toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it('rejects Stop for provider-page observations and enforces the block fence', async () => {
        const timingChat = webProviderConversationId('deepseek', 'a3333333-1111-4111-8111-000000000001');
        vi.useFakeTimers();
        try {
          await pair();
          await events(timingChat, [{ kind: 'model_selection', model: 'DeepSeek-V3', reasoningEffort: 'pro', time: Date.now() }, openTurn('pro-stopped')]);
          const sessionId = (await request('GET', `/activity?conversationId=${timingChat}`)).body.sessionId;
          const { sessionActivityExpiresAt, stopSessionTurn } = await import("../../../../../backend/domains/browser/bridge.js");
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBeNull();
          await expect(stopSessionTurn(sessionId, 'pro-stopped')).rejects.toThrow('active_turn_changed');
          setChatBlocked(timingChat, true);
          await events(timingChat, [endTurn('pro-stopped', 'stopped')]);
          await vi.advanceTimersByTimeAsync(1_000);
          await attributed(timingChat, false, Date.now());
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBeNull();
          expect((await sessionControlsFor(sessionId)).automation).toBe('off');
        } finally { setChatBlocked(timingChat, false); vi.useRealTimers(); }
      });

  it('retires an old synthetic Pro obligation before later model changes can resurrect it', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        resetGoalStateForTests();
        await setSecret('openRouterApiKey', 'sk-or-old-pro');
        try {
        await pair();
        await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-6 Pro', time: Date.now() }, openTurn('pro-old')]);
        const activity = await request('GET', `/activity?conversationId=${recoveryState.OTHER}`);
        await acceptGoalReplyNow({ conversationId: recoveryState.OTHER, sessionId: activity.body.sessionId, turnId: 'g-silence-old', replyId: 'silence:old', eventSeq: 0, blocked: false });
        await request('GET', `/activity?conversationId=${recoveryState.OTHER}`);
        expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
        await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() + 1 }]);
        await setGoalReplyActiveNow(recoveryState.OTHER, false);
        await setGoalReplyActiveNow(recoveryState.OTHER, true);
        expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.goal.pending).toBeNull();
        expect((await request('POST', '/goal/draft', { body: { conversationId: recoveryState.OTHER, turnId: 'g-silence-old' } })).status).toBe(409);
        } finally { resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); }
      });

  for (const afterTurn of [false, true]) for (const proof of ['missing', 'exact', 'older', 'new turn']) it(`requires ${proof} canonical Pro final proof without any recent tool call (after-turn ${afterTurn})`, async () => {
        const conversationId = randomUUID();
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-pro-final');
        resetGoalStateForTests();
        try {
          await pair();
          const { setGoalSwitchNow } = await import("../../../../../backend/domains/automation/goal.js");
          await setGoalSwitchNow(conversationId, 'loop', true, afterTurn);
          await events(conversationId, [{ kind: 'model_selection', model: 'GPT-5.6 Pro', time: Date.now() }, openTurn('pro-final-' + proof)]);
          if (proof !== 'missing') await events(conversationId, [{ kind: 'assistant_message', time: Date.now(), messageId: 'pro-answer-' + proof, turnId: proof === 'older' ? 'old-turn' : 'pro-final-' + proof, text: 'Finished.', state: 'final', final: true, activeNow: true }]);
          await events(conversationId, [endTurn('pro-final-' + proof, 'completed')]);
          if (proof === 'new turn') await events(conversationId, [openTurn('next-pro-turn')]);
          const result = await request('POST', '/goal/draft', { body: { conversationId: conversationId, turnId: 'pro-final-' + proof, clientId: 'tab-1' } });
          // Even a canonical final cannot autonomously spend another Loop message when this source turn never reached the local MCP connector.
          expect(result.status, JSON.stringify(result.body)).toBe(409);
        } finally {
          resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous);
        }
      });

  it('keeps recovery-disabled Pro visibly active through 9:59 and retires it at ten minutes', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: false }, multiAgent: { ...previous.multiAgent, recoverAgentTabs: false } });
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'gpt-6', reasoningEffort: 'pro', time: Date.now() }, openTurn('pro-recovery-off')]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(PRO_ACTIVITY_MS - CHAT_SILENCE_MS - 1);
          const activity = await request('GET', `/activity?conversationId=${recoveryState.OTHER}`);
          const { sessionControlsFor } = await import("../../../../../backend/domains/browser/bridge.js");
          expect(activity.body.activeTurnId).toBe('pro-recovery-off');
          expect((await sessionControlsFor(activity.body.sessionId)).activeTurnId).toBe('pro-recovery-off');
          await vi.advanceTimersByTimeAsync(2);
          await sweepStaleSwarm(Date.now());
          expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.activeTurnId).toBeNull();
          expect((await sessionControlsFor(activity.body.sessionId)).activeTurnId).toBeNull();
          expect(await maintenance()).toBeNull();
        } finally { await saveConfig(previous); vi.useRealTimers(); }
      });

  it.each(['unknown', 'normal'] as const)('uses the %s model recovery clock without queued input', async model => {
        const chat = model === 'unknown' ? 'a7777777-1111-4111-8111-000000000001' : 'a7777777-1111-4111-8111-000000000002';
        vi.useFakeTimers();
        try {
          await pair();
          expect(getConfig().multiAgent.recoverAgentTabs).toBe(true);
          await events(chat, [
            ...(model === 'normal' ? [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }] : []),
            openTurn(`no-queue-${model}`)
          ]);
          await attributed(chat, false, Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ conversationId: chat, reason: 'silence' });
          expect(goalPendingReplyFor(chat)).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it.each(['high', 'pro'] as const)('pins an observed %s turn across a later picker change', async effort => {
        const chat = effort === 'high' ? 'a7777777-1111-4111-8111-000000000004' : 'a7777777-1111-4111-8111-000000000006';
        vi.useFakeTimers();
        try {
          await pair();
          await events(chat, [{ kind: 'model_selection', model: '5.6', reasoningEffort: effort, time: Date.now() }]);
          await events(chat, [openTurn('pinned-model')]);
          await attributed(chat, false, Date.now());
          await vi.advanceTimersByTimeAsync(30_000);
          await events(chat, [{ kind: 'model_selection', model: '5.6', reasoningEffort: effort === 'pro' ? 'high' : 'pro', time: Date.now() }]);
          const deadline = effort === 'pro' ? PRO_SILENCE_MS : CHAT_SILENCE_MS;
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 30_000 - 1);
          expect(await maintenance()).toBeNull();
          if (effort === 'pro') {
            await vi.advanceTimersByTimeAsync(deadline - CHAT_SILENCE_MS);
            expect(await maintenance()).toBeNull();
          }
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ conversationId: chat, reason: 'silence' });
        } finally { vi.useRealTimers(); }
      });

  it('resolves delayed Sol High evidence without restarting its silence deadline', async () => {
        const chat = 'a7777777-1111-4111-8111-000000000005';
        vi.useFakeTimers();
        try {
          await pair();
          await events(chat, [openTurn('late-sol')]);
          await attributed(chat, false, Date.now());
          await vi.advanceTimersByTimeAsync(90_000);
          await events(chat, [{ kind: 'model_selection', model: 'gpt-5-6-thinking', reasoningEffort: 'high', time: Date.now() }]);
          const { sessionInputActivity } = await import("../../../../../backend/domains/browser/bridge.js");
          const sessionId = (await request('GET', `/activity?conversationId=${chat}`)).body.sessionId;
          expect(sessionInputActivity((await getSession(sessionId))!).model).toBe('other');
          await vi.advanceTimersByTimeAsync(29_999);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ conversationId: chat, reason: 'silence' });
        } finally { vi.useRealTimers(); }
      });

  it('reuses unchanged Sol selection for a later turn and keeps that fresh turn visibly active', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'gpt-5-6-thinking', reasoningEffort: 'high', time: Date.now() }, openTurn('sol-first')]);
          await recordFinalForTest(recoveryState.OTHER, 'sol-first');
          await events(recoveryState.OTHER, [endTurn('sol-first', 'completed')]);
          await vi.advanceTimersByTimeAsync(1_000);
          await events(recoveryState.OTHER, [{ kind: 'user_message', messageId: 'sol-second-question', time: Date.now(), text: 'Next task' }, openTurn('sol-second')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          const sessionId = (await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.sessionId;
          const summary = (await getSession(sessionId))!;
          const { sessionInputActivity, sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          const { sessionWorkingAt } = await import("../../../../../contracts/sessions/activity-state.js");
          expect(sessionInputActivity(summary)).toMatchObject({ model: 'other', turnId: 'sol-second' });
          expect(sessionWorkingAt({ ...summary, activityExpiresAt: sessionActivityExpiresAt(summary) }, Date.now())).toBe(true);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'silence' });
        } finally { vi.useRealTimers(); }
      });

  it('retires unknown activity after two minutes when recovery is off and no input is queued', async () => {
        const previous = getConfig();
        const chat = 'a7777777-1111-4111-8111-000000000003';
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: false },
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false } });
        vi.useFakeTimers();
        try {
          await pair();
          await events(chat, [openTurn('unknown-recovery-off')]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect((await request('GET', `/activity?conversationId=${chat}`)).body.activeTurnId).toBeNull();
          expect(await maintenance()).toBeNull();
          // Enabling recovery later must not resurrect the already-retired grant.
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: true } });
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS - CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally { await saveConfig(previous); vi.useRealTimers(); }
      });
});
