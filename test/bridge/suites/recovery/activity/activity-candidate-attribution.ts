import { randomUUID } from "node:crypto";
import { beforeEach, CHAT_SILENCE_MS, DELIBERATE_SILENCE_MS, describe, expect, findSessionByConversation, getConfig, getSession, it, opened, pair, PRO_SILENCE_MS, readEvents, recordToolCall, request, REQUEST_ID_GRACE_MS, resetBridgeForTests, resetRecorderForTests, resetSwarm, saveConfig, sessionControlsFor, sessionStoreModule, setBrowserOpener, setChatBlocked, sweepStaleSwarm, vi, writeDurableNow } from "../../../test-context.js";
import { attributed, chatOf, endTurn, events, maintenance, maintenanceBatch, openTurn, reopened, unattributed, unattributedTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: activity candidate attribution", () => {
  beforeEach(resetRecoveryFixture);

  it('keeps the opening minute fixed, excludes healthy chats and never admits a late newcomer', async () => {
        vi.useFakeTimers();
        try {
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
          await pair(); await events(recoveryState.PRIME, [openTurn('frozen-prime')]); await events(recoveryState.OTHER, [openTurn('frozen-other')]);
          await unattributedTurn('frozen-cohort'); const openedAt = Date.now();
          await vi.advanceTimersByTimeAsync(10_000);
          await attributed(recoveryState.OTHER, false, Date.now());
          await events(recoveryState.WORKER, [openTurn('late-newcomer')]);
          await vi.advanceTimersByTimeAsync(openedAt + 59_999 - Date.now());
          expect(await maintenanceBatch()).toEqual([]);
          await vi.advanceTimersByTimeAsync(1);
          const first = await maintenance(); expect(chatOf(first)).toBe(recoveryState.PRIME);
          await maintenance(first!.token);
          await vi.advanceTimersByTimeAsync(1); await unattributedTurn('frozen-cohort');
          await vi.advanceTimersByTimeAsync(openedAt + 300_000 - Date.now());
          expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
        } finally { vi.useRealTimers(); }
      });

  it.each(['mcp', 'completed', 'stopped', 'new-turn', 'blocked', 'resolved'])('refuses a handed action after its candidate is cleared: %s', async kind => {
        vi.useFakeTimers();
        try {
          await pair(); await events(recoveryState.PRIME, [openTurn(`claim-${kind}`)]);
          const id = `claim-request-${kind}`;
          await unattributedTurn(id); await vi.advanceTimersByTimeAsync(15_000);
          const first = await maintenance();
          expect(first?.reason).toBe('unattributed');
          await vi.advanceTimersByTimeAsync(1);
          if (kind === 'mcp') await attributed(recoveryState.PRIME, false, Date.now());
          if (kind === 'completed' || kind === 'stopped') await events(recoveryState.PRIME, [endTurn(`claim-${kind}`, kind)]);
          if (kind === 'new-turn') await events(recoveryState.PRIME, [openTurn('replacement-turn')]);
          if (kind === 'blocked') await setChatBlocked(recoveryState.PRIME, true);
          if (kind === 'resolved') await request('POST', '/correlations', { body: { conversationId: recoveryState.PRIME,
            calls: [{ requestId: id, messageId: `claim-proof-${kind}`, tool: 'read', order: 0, answered: false }] } });
          expect((await request('POST', '/repairs/claim', { body: { token: first!.token } })).body.allowed).toBe(false);
        } finally { vi.useRealTimers(); }
      });

  it('claims once and does not count unknown work before that claim as a failed refresh', async () => {
        vi.useFakeTimers();
        try {
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
          await pair(); await events(recoveryState.PRIME, [openTurn('delayed-claim')]);
          await unattributedTurn('delayed-claim-request'); const openedAt = Date.now();
          await vi.advanceTimersByTimeAsync(15_000); const first = await maintenance();
          await vi.advanceTimersByTimeAsync(1); await unattributedTurn('delayed-claim-request');
          expect((await request('POST', '/repairs/claim', { body: { token: first!.token } })).body.allowed).toBe(true);
          expect((await request('POST', '/repairs/claim', { body: { token: first!.token } })).body.allowed).toBe(false);
          await maintenance(first!.token);
          await vi.advanceTimersByTimeAsync(openedAt + 300_000 - Date.now());
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it('a slow pre-incident attributed call cannot cancel the queued refresh', async () => {
        vi.useFakeTimers();
        try {
          await pair(); await events(recoveryState.PRIME, [openTurn('slow-healthy')]);
          const oldStartedAt = Date.now(); await vi.advanceTimersByTimeAsync(10);
          await unattributedTurn('slow-unknown'); await vi.advanceTimersByTimeAsync(15_000);
          await attributed(recoveryState.PRIME, false, oldStartedAt);
          expect((await maintenance())?.reason).toBe('unattributed');
        } finally { vi.useRealTimers(); }
      });

  it.each(['none', 'different-request', 'old-call', 'resolved'])('does not retry without continuing unresolved same-request work: %s', async kind => {
        vi.useFakeTimers();
        try {
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
          await pair(); await events(recoveryState.PRIME, [openTurn(`no-retry-${kind}`)]);
          const id = `request-no-retry-${kind}`;
          await unattributedTurn(id);
          const openedAt = Date.now();
          await vi.advanceTimersByTimeAsync(15_000);
          const first = await maintenance(); expect(first?.reason).toBe('unattributed');
          await maintenance(first!.token);
          await vi.advanceTimersByTimeAsync(1);
          if (kind === 'different-request') await unattributedTurn(`${id}-other`);
          if (kind === 'old-call') {
            const call = recordToolCall({ tool: 'read', args: {}, content: [], outcome: 'ok', durationMs: 1,
              startedAt: openedAt - 1, requestId: id });
            await vi.advanceTimersByTimeAsync(REQUEST_ID_GRACE_MS); await call;
          }
          if (kind === 'resolved') {
            await unattributedTurn(id);
            await request('POST', '/correlations', { body: { conversationId: recoveryState.PRIME, calls: [{ requestId: id, messageId: 'resolved-message', tool: 'read', order: 0, answered: false }] } });
          }
          await vi.advanceTimersByTimeAsync(openedAt + 300_000 - Date.now());
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  /** A receipt answers one handout, not a conversation. The pass that carries a reload out can report it late - the app may have retired that repair and raised a new one for the next broken turn of the same chat by then. Believing that receipt would record the newer turn as repaired without anything having reloaded it, and a turn recorded as repaired is never repaired again. So the token minted with each handout is what is answered, and a receipt matching no outstanding handout closes nothing. */
      it('does not let a receipt from a spent repair close the repair of a later broken turn', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-first')]);
          await unattributed();
          await vi.advanceTimersByTimeAsync(60_000);
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.PRIME);
    
          // That turn ends before the receipt for it arrives, and the next one breaks the same way.
          await events(recoveryState.PRIME, [endTurn('turn-first', 'completed')]);
          await vi.advanceTimersByTimeAsync(1);
          await events(recoveryState.PRIME, [{ kind: 'user_message', messageId: 'next-authored-turn', time: Date.now(), text: 'new work' }, openTurn('turn-second')]);
          await unattributed();
          await vi.advanceTimersByTimeAsync(60_000);
          const second = await maintenance();
          expect(chatOf(second)).toBe(recoveryState.PRIME);
          expect(second!.token).not.toBe(first!.token);
    
          // The late receipt lands. It says nothing about the second turn, which is still handed out - and handed out afresh, because a pass that reported nothing is a pass that failed.
          expect(await maintenance(first!.token)).toBeNull();
          expect(await maintenance(second!.token)).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  it('does not let later unattributed calls renew the first incident', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-live')]);
          await events(recoveryState.OTHER, [openTurn('turn-other')]);
          await unattributed();
    
          await vi.advanceTimersByTimeAsync(10_000);
          await unattributed();
          await vi.advanceTimersByTimeAsync(49_999);
          expect(await maintenanceBatch()).toEqual([]);
    
          // Sixty seconds from the first call, not a renewed budget after the second.
          await vi.advanceTimersByTimeAsync(1);
          expect((await maintenanceBatch()).map(row => row.conversationId).sort()).toEqual([recoveryState.PRIME, recoveryState.OTHER].sort());
        } finally {
          vi.useRealTimers();
        }
      });

  it('calls the repair off when that chat proves an attributed call', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-live')]);
          await unattributed();
    
          await vi.advanceTimersByTimeAsync(10_000);
          await attributed(recoveryState.PRIME);
    
          await vi.advanceTimersByTimeAsync(50_000);
          expect(await maintenance()).toBeNull();
          expect(reopened(recoveryState.PRIME)).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      });

  it('does not accept page liveness as proof that the join recovered', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-live')]);
          await unattributed();
    
          // The same turn is alive and reporting progress, but its request ids are still reaching nobody. Page activity alone must not cancel its queued repair.
          await vi.advanceTimersByTimeAsync(10_000);
          await events(recoveryState.PRIME, [
            { kind: 'progress', time: Date.now(), turnId: 'turn-live', text: 'still here' }
          ]);
    
          await vi.advanceTimersByTimeAsync(50_000);
          expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
        } finally {
          vi.useRealTimers();
        }
      });

  it('repairs every chat that could be the broken one, not only a lone candidate', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-prime')]);
          await events(recoveryState.OTHER, [openTurn('turn-other')]);
          await unattributed();
    
          // Two chats are generating and neither has proved its join, so both are broken until one of them shows otherwise. Standing down here is what left a whole swarm that lost the same evidence path at once with no repair at all. Two suspects is also a rung up from one: there is now somebody to be told apart from.
          await vi.advanceTimersByTimeAsync(59_999);
          expect(await maintenanceBatch()).toEqual([]);
          await vi.advanceTimersByTimeAsync(1);
    
          // Both in the one pass. The browser's alarm has a thirty-second floor, so handing these out one per pass would put a minute between two failures that happened together.
          const handed = (await maintenanceBatch()).map((entry) => entry.conversationId).sort();
          expect(handed).toEqual([recoveryState.PRIME, recoveryState.OTHER].sort());
        } finally {
          vi.useRealTimers();
        }
      });

  it('leaves a chat that proved its join out of the repair', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-prime')]);
          await events(recoveryState.OTHER, [openTurn('turn-other')]);
          await unattributed();
    
          // An attributed call is the one fact that says this chat's join works. It is the whole difference between the chats that get reloaded and the chats that are simply busy.
          await attributed(recoveryState.OTHER);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
          // Missing ACK retains custody and does not issue another action.
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  it('leaves a chat alone that already proved its join earlier in the same turn', async () => {
        // An exactly attributed call in the current turn already shows this chat's join works.
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-proven')]);
          await attributed(recoveryState.PRIME, false, Date.now());
          await vi.advanceTimersByTimeAsync(1_000);
          await unattributed();
          await vi.advanceTimersByTimeAsync(60_000);
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  it('leaves a chat that has finished its answer, or that the user stopped, alone', async () => {
        for (const outcome of ['completed', 'stopped']) {
          vi.useFakeTimers();
          try {
            resetSwarm();
            resetBridgeForTests();
            resetRecorderForTests();
            opened.length = 0;
            setBrowserOpener(async (url) => {
              opened.push(url);
            });
            await pair();
            await events(recoveryState.PRIME, [openTurn(`turn-${outcome}`), endTurn(`turn-${outcome}`, outcome)]);
            await unattributed();
    
            await vi.advanceTimersByTimeAsync(60_000);
            expect(await maintenance(), `${outcome} must not be reloaded`).toBeNull();
            expect(reopened(recoveryState.PRIME)).toEqual([]);
          } finally {
            vi.useRealTimers();
          }
        }
      });

  it.each(['normal', 'pro'] as const)('does not continue or reload a %s final observed by another document of the same response', async model => {
        const previous = getConfig();
        const input = await import("../../../../../backend/domains/sessions/input/input.js");
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true }, goal: { ...previous.goal, enabled: false } });
        input.resetInputForTests();
        vi.useFakeTimers();
        try {
          await writeDurableNow('session-input', []);
          await pair();
          const chat = randomUUID(), first = 'original-document', second = 'reopened-document';
          await events(chat, [
            { kind: 'user_message', messageId: 'original-question', text: 'Review the changes', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() },
            openTurn(first)
          ]);
          await attributed(chat, false, Date.now());
          const session = (await findSessionByConversation(chat))!;
          const [initial] = (await readEvents(session.id)).filter(event => event.kind === 'tool_call');
          await sessionStoreModule.appendEvent(session.id, { kind: 'user_message', source: 'app', time: Date.now(), turnId: first,
            inputId: 'injected-correction', messageId: 'input:injected-correction',
            message: { text: 'For the current project.', chars: 24, truncated: false } });
          await vi.advanceTimersByTimeAsync(1000);
          await events(chat, [openTurn(second)]);
          await recordToolCall({ conversationId: chat, requestId: initial!.call.requestId, tool: 'read', args: {},
            content: [{ type: 'text', text: 'The existing work is checked.' }], outcome: 'ok', durationMs: 1, startedAt: Date.now() });
          const activity = await request('GET', `/activity?conversationId=${chat}&since=0`);
          expect(activity.body.userAnchors.map((row: { messageId: string }) => row.messageId)).toEqual(['original-question']);
          expect(activity.body.recordedQuestionId).toBe('original-question');
          await events(chat, [{ kind: 'assistant_message', turnId: first, time: Date.now(), messageId: 'finished-answer',
            providerMessageId: '11111111-2222-4333-8444-555555555555', text: 'The requested review is finished.', final: true, state: 'final', activeNow: true }]);
          expect(await sessionStoreModule.readCompletedFinal(session.id, chat, second)).not.toBeNull();
          expect((await getSession(session.id))?.activeTurnId).toBeNull();
          for (const wait of [model === 'pro' ? PRO_SILENCE_MS : CHAT_SILENCE_MS, 120_000, 300_000]) {
            await vi.advanceTimersByTimeAsync(wait);
            await sweepStaleSwarm(Date.now());
            expect(await maintenance()).toBeNull();
            expect((await sessionControlsFor(session.id)).recovery).toEqual([]);
            expect((await input.listInputs()).filter(row => row.sessionId === session.id && row.recovery)).toEqual([]);
          }
        } finally { await writeDurableNow('session-input', []); input.resetInputForTests(); vi.useRealTimers(); await saveConfig(previous); }
      });

  /** A thinking turn is not a silent one. The silence window is chosen by model family — Pro gets ten minutes, everything else two — and a reasoning effort of `high` or above is legitimately quiet for far longer than two minutes between tool calls. Until request attribution worked this never mattered: every silence path is gated on `turnHasMcpCall`, so while calls landed under Unattributed activity the watchdog never ran at all. Fixing attribution (#414) switched it on for the first time. Measured by @moderntanri in #393, twice in a single task: an Extra-high turn went quiet after a long render, `active chat silent for 2 minutes — asking the browser to reload` fired, the reload killed the streaming turn, and the Continue queued behind it was claimed and never delivered. Their workaround was to turn Automatic Continue off entirely, which gives up the feature to avoid the watchdog. So the window follows the effort that was actually observed. Deliberately not by widening `model === 'pro'`: Pro carries other rules — Continue eligibility among them — that must not extend to an ordinary model merely because it is thinking hard. */
      it.each(['xhigh', 'max', 'ultra'] as const)('gives a %s reasoning turn the long silence window, not two minutes', async effort => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), turnId = `thinking-${effort}`;
          await events(chat, [
            { kind: 'user_message', messageId: 'question', text: 'Do the long analysis', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: effort, time: Date.now() },
            openTurn(turnId)
          ]);
          await attributed(chat, false, Date.now());
    
          // Two minutes of quiet is an ordinary pause for this turn, not a dead page.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS + 30_000);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), `a ${effort} turn was reloaded mid-thought`).toBeNull();
    
          // Pro's ten minutes are not its boundary either (#786): such a turn can think longer.
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS - CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), `a ${effort} turn was reloaded at the Pro boundary`).toBeNull();
    
          // The watchdog still exists: past its own bounded window the reload is offered.
          await vi.advanceTimersByTimeAsync(DELIBERATE_SILENCE_MS - PRO_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), `a ${effort} turn was never recovered at all`)
            .toMatchObject({ conversationId: chat, reason: 'silence' });
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  /** A failed end is the turn over, so nothing is still thinking and the long window no longer applies. Measured 2026-10-01 on an Extra High prime: its stream died twice, the error reload found "Resume stream unavailable", the turn ended as failed, and the chat then waited toward its twenty-minute window — the automatic Continue never came before its owner typed. */
      it.each(['xhigh', 'max'] as const)('recovers a %s turn that ended as failed on the ordinary two-minute window', async effort => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), turnId = `failed-${effort}`;
          await events(chat, [
            { kind: 'user_message', messageId: 'question', text: 'Do the long analysis', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: effort, time: Date.now() },
            openTurn(turnId)
          ]);
          await attributed(chat, false, Date.now());
          // Quiet thinking first: the long window still protects the running turn.
          await vi.advanceTimersByTimeAsync(5 * 60_000);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), `a running ${effort} turn was reloaded mid-thought`).toBeNull();
    
          await events(chat, [endTurn(turnId, 'failed')]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 10_000);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), 'the failed turn was reloaded before its two minutes').toBeNull();
          await vi.advanceTimersByTimeAsync(20_000);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), `a failed ${effort} turn waited for the long thinking window`)
            .toMatchObject({ conversationId: chat, reason: 'silence' });
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  /** The picker can report the selection after the turn and its first call (#786). That late exact evidence names the effort of the grant that is already running: it widens that grant to the long window, measured from the same last real work, and is not itself work. */
      it('widens an unresolved grant for a late exact xhigh selection without restarting its clock', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), workAt = Date.now();
          await events(chat, [
            { kind: 'user_message', messageId: 'question', text: 'Do the long analysis', time: Date.now(), authoredNow: true },
            openTurn('late-selection')
          ]);
          await attributed(chat, false, workAt);
          await vi.advanceTimersByTimeAsync(60_000);
          await events(chat, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'xhigh', time: Date.now() }]);
    
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), 'the late xhigh selection did not widen the running grant').toBeNull();
    
          // Measured from the call, not from the selection a minute later.
          await vi.advanceTimersByTimeAsync(workAt + DELIBERATE_SILENCE_MS + 1_000 - Date.now());
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), 'the late selection restarted the silence clock')
            .toMatchObject({ conversationId: chat, reason: 'silence' });
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  /** The control, and `high` is the one that matters in it: `high` is the ordinary effort for the current models and every other test here uses it as the plain non-Pro case. Widening it would be the opposite mistake — a genuinely dead page waiting ten minutes instead of two. */
      it.each(['medium', 'high'] as const)('keeps the two-minute silence window for %s, the ordinary effort', async effort => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID();
          await events(chat, [
            { kind: 'user_message', messageId: 'question', text: 'Quick question', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: effort, time: Date.now() },
            openTurn(`ordinary-${effort}`)
          ]);
          await attributed(chat, false, Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS + 30_000);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance(), 'an ordinary turn lost its two-minute watchdog')
            .toMatchObject({ conversationId: chat, reason: 'silence' });
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });
});
