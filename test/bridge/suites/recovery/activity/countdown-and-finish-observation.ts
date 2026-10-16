import { randomUUID } from "node:crypto";
import { beforeEach, cancelAssistantRecovery, CHAT_SILENCE_MS, describe, expect, findSessionByConversation, getConfig, getSession, goalPendingReplyFor, it, pair, PRO_SILENCE_MS, readEvents, recordFinalForTest, redeem, request, saveConfig, sessionControlsFor, sessionStoreModule, spawn, stageMessages, swarmStateForCaller, sweepStaleSwarm, unattributedRepairEta, vi, WORKER_SILENCE_MS, writeDurableNow } from "../../../test-context.js";
import { attributed, endTurn, events, maintenance, maintenanceBatch, openTurn, unattributed, unattributedTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: countdown and finish observation", () => {
  beforeEach(resetRecoveryFixture);

  it('withholds a recovery ETA when the browser has no eligible active chat', async () => {
        await pair();
        await request('GET', '/status');
        expect(unattributedRepairEta()).toBeNull();
        await events(recoveryState.PRIME, [openTurn('eta-active')]);
        expect(unattributedRepairEta()).toBe(15);
        await events(recoveryState.PRIME, [endTurn('eta-active', 'stopped')]);
        expect(unattributedRepairEta()).toBeNull();
      });

  it.each([1, 2, 3, 4])('projects the existing fixed countdown for %i candidates, cleared only for proven chats', async count => {
        vi.useFakeTimers();
        try {
          await pair();
          const chats = [recoveryState.PRIME, recoveryState.WORKER, recoveryState.OTHER, 'decafbad-1111-2222-3333-444444444444'].slice(0, count);
          const ids: string[] = [];
          for (const chat of chats) {
            await events(chat, [openTurn('countdown-source')]);
            ids.push((await request('GET', `/activity?conversationId=${chat}`)).body.sessionId);
          }
          expect((await sessionControlsFor(ids[0]!)).recovery).toEqual([]);
          await unattributed();
          const deadline = Date.now() + (count === 1 ? 15_000 : 60_000);
          for (const id of ids) expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'unattributed', deadline }]);
          await vi.advanceTimersByTimeAsync(1000);
          await attributed(chats[0]!, false, Date.now());
          expect((await sessionControlsFor(ids[0]!)).recovery?.filter(row => row.kind.startsWith('unattributed'))).toEqual([]);
          for (const id of ids.slice(1)) expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'unattributed', deadline }]);
          if (ids.length > 1) {
            await events(chats[1]!, [endTurn('countdown-source', 'stopped')]);
            expect((await sessionControlsFor(ids[1]!)).recovery).toEqual([]);
          }
        } finally { vi.useRealTimers(); }
      });

  // Extra high thinks quietly for long, but Thinking failed proves that thinking is over: it keeps the ordinary two-minute failure window, never the long silence window.
      it.each([['gpt-6-pro', 'pro'], ['GPT-5.6 Sol', 'high'], ['GPT-5.6 Sol', 'xhigh']])('projects the confirmed Thinking-failed wait and removes it on fresh work (%s, %s)', async (model, effort) => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model, reasoningEffort: effort, time: Date.now() }, openTurn('failed-countdown')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          const id = (await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.sessionId;
          expect((await sessionControlsFor(id)).recovery?.every(row => row.kind === 'silence')).toBe(true);
          await events(recoveryState.OTHER, [{ kind: 'turn_end', turnId: 'failed-countdown', outcome: 'failed', reason: 'thinking_failed', time: Date.now() }]);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(model === 'gpt-6-pro' ? 300_000 : CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair?.reason).toBe('silence');
          await maintenance(repair!.token);
          const deadline = Date.now() + (model === 'gpt-6-pro' ? 300_000 : 60_000);
          expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'post-reload', deadline }]);
          await vi.advanceTimersByTimeAsync(10_000);
          expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'post-reload', deadline }]);
          await events(recoveryState.OTHER, [{ kind: 'assistant_message', messageId: 'fresh-after-failure', turnId: 'failed-countdown', text: 'Continuing the work.', state: 'streaming', activeNow: true, time: Date.now() }]);
          expect((await sessionControlsFor(id)).recovery?.every(row => row.kind === 'silence')).toBe(true);
        } finally { vi.useRealTimers(); }
      });

  it.each(['pro', 'other'] as const)('keeps the %s incomplete completion countdown hidden until its presentation window', async model => {
        const { setSessionAutomation } = await import("../../../../../backend/domains/browser/bridge.js");
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol',
            reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() }, openTurn('incomplete-countdown')]);
          const id = (await findSessionByConversation(recoveryState.OTHER, { requireUnique: true }))!.id;
          await setSessionAutomation(id, 'loop', true);
          await attributed(recoveryState.OTHER, false, Date.now());
          const began = Date.now();
          await vi.advanceTimersByTimeAsync(1_000);
          await events(recoveryState.OTHER, [endTurn('incomplete-countdown', 'completed')]);
          const deadline = model === 'pro' ? began + PRO_SILENCE_MS : Date.now() + CHAT_SILENCE_MS;
          expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'silence', deadline, visibleAt: deadline - (model === 'pro' ? 300_000 : 30_000) }]);
          expect((await sessionControlsFor(id)).goalWait).toBeNull();
          expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.goal.wait).toBeNull();
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          await vi.advanceTimersByTimeAsync(1_000);
          await attributed(recoveryState.OTHER, false, Date.now());
          const ordinary = model === 'pro' ? [{ kind: 'silence', deadline: Date.now() + PRO_SILENCE_MS, visibleAt: Date.now() + 300_000 }]
            : [{ kind: 'silence', deadline: Date.now() + CHAT_SILENCE_MS, visibleAt: Date.now() + CHAT_SILENCE_MS - 30_000 }];
          expect((await sessionControlsFor(id)).recovery).toEqual(ordinary);
          const wait = null;
          expect((await sessionControlsFor(id)).goalWait).toEqual(wait);
          expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.goal.wait).toEqual(wait);
        } finally { vi.useRealTimers(); }
      });

  it('projects Pro silence from the real work clock and renews the hidden first five minutes on activity', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: Date.now() }, openTurn('pro-silence-countdown')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          const id = (await findSessionByConversation(recoveryState.OTHER, { requireUnique: true }))!.id;
          const began = Date.now();
          const countdown = { kind: 'silence', visibleAt: began + 300_000, deadline: began + PRO_SILENCE_MS };
          expect((await sessionControlsFor(id)).recovery).toEqual([countdown]);
          await vi.advanceTimersByTimeAsync(300_000);
          expect(await maintenance()).toBeNull();
          expect((await sessionControlsFor(id)).recovery).toEqual([countdown]);
          await attributed(recoveryState.OTHER, false, Date.now());
          expect((await sessionControlsFor(id)).recovery).toEqual([{ ...countdown, visibleAt: Date.now() + 300_000, deadline: Date.now() + PRO_SILENCE_MS }]);
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS - 1);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair?.reason).toBe('silence');
          await maintenance(repair!.token);
          expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'post-reload', deadline: Date.now() + 300_000, generating: true }]);
        } finally { vi.useRealTimers(); }
      });

  it('keeps the original unattributed cohort visible without requiring another unknown call', async () => {
        vi.useFakeTimers();
        try {
          // Attribution owns this watch; ordinary two-minute silence is tested separately.
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
          await pair();
          for (const chat of [recoveryState.PRIME, recoveryState.WORKER, recoveryState.OTHER]) await events(chat, [openTurn('five-minute-cohort')]);
          const ids = await Promise.all([recoveryState.PRIME, recoveryState.WORKER, recoveryState.OTHER].map(async chat => (await findSessionByConversation(chat, { requireUnique: true }))!.id));
          await unattributedTurn('five-minute-cohort-request');
          const startedAt = Date.now(), deadline = startedAt + 300_000;
          await vi.advanceTimersByTimeAsync(60_000);
          const batch = await maintenanceBatch();
          expect(batch).toHaveLength(3);
          for (const repair of batch) await maintenanceBatch(repair.token, 'reloaded');
          for (const id of ids) expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'unattributed-wait', deadline }]);
          // The retry's existing eligibility remains unchanged; this is a UI watch.
          expect(unattributedRepairEta(Date.now(), 'five-minute-cohort-request')).toBeNull();
          await vi.advanceTimersByTimeAsync(1000);
          await attributed(recoveryState.WORKER, false, Date.now());
          expect((await sessionControlsFor(ids[1]!)).recovery).toEqual([]);
          const late = 'decafbad-1111-2222-3333-444444444444';
          await events(late, [openTurn('late-cohort-outsider')]);
          const lateId = (await findSessionByConversation(late, { requireUnique: true }))!.id;
          expect((await sessionControlsFor(lateId)).recovery).toEqual([]);
          await vi.advanceTimersByTimeAsync(120_000);
          await request('GET', '/status'); // Extension check-in; this is not an MCP attribution.
          for (const id of [ids[0]!, ids[2]!]) expect((await sessionControlsFor(id)).recovery).toEqual([{ kind: 'unattributed-wait', deadline }]);
          await vi.advanceTimersByTimeAsync(deadline - Date.now());
          for (const id of ids) expect((await sessionControlsFor(id)).recovery).toEqual([]);
          expect(await maintenanceBatch()).toEqual([]);
        } finally { vi.useRealTimers(); }
      });

  it('projects repeated native-busy waits from the same queued input and withdraws them with new work', async () => {
        const input = await import("../../../../../backend/domains/sessions/input/input.js");
        input.resetInputForTests();
        vi.useFakeTimers();
        try {
          await writeDurableNow('session-input', []);
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('queue-countdown')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          const session = await findSessionByConversation(recoveryState.OTHER, { requireUnique: true });
          const row = await input.enqueueInput({ id: randomUUID(), sessionId: session!.id, text: 'The next checkpoint', mode: 'after-turn',
            dueAt: Date.now(), model: null, reasoningEffort: null });
          expect((await sessionControlsFor(session!.id)).recovery).toEqual([{ kind: 'silence', deadline: Date.now() + CHAT_SILENCE_MS, visibleAt: Date.now() + CHAT_SILENCE_MS - 30_000 }]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          await vi.advanceTimersByTimeAsync(5_000); // The browser receipt, not handout, starts the minute.
          await maintenance(repair!.token);
          expect((await sessionControlsFor(session!.id)).recovery).toEqual([{ kind: 'post-reload', next: 'queue', deadline: Date.now() + 60_000, generating: true }]);
          expect(await input.claimBrowserInput(row.id, 'queue-countdown-page', recoveryState.OTHER)).toBeNull();
          await vi.advanceTimersByTimeAsync(30_000);
          await maintenance(repair!.token); // Replayed receipt must not extend the deadline.
          expect((await sessionControlsFor(session!.id)).recovery).toEqual([{ kind: 'post-reload', next: 'queue', deadline: Date.now() + 30_000, generating: true }]);
          await vi.advanceTimersByTimeAsync(30_000);
          for (let attempt = 0; attempt < 2; attempt++) {
            const response = await request('POST', '/input/claim', { body: { id: row.id, owner: 'queue-countdown-page', conversationId: recoveryState.OTHER, silenceBusyTurnId: 'queue-countdown' } });
            expect(response.body.ok).toBe(true);
            expect((await sessionControlsFor(session!.id)).recovery).toEqual([{ kind: 'native-busy', next: 'queue', deadline: Date.now() + 60_000 }]);
            if (attempt === 0) await vi.advanceTimersByTimeAsync(60_000);
          }
          await attributed(recoveryState.OTHER, false, Date.now());
          expect((await sessionControlsFor(session!.id)).recovery).toEqual([{ kind: 'silence', deadline: Date.now() + CHAT_SILENCE_MS, visibleAt: Date.now() + CHAT_SILENCE_MS - 30_000 }]);
        } finally { await writeDurableNow('session-input', []); input.resetInputForTests(); vi.useRealTimers(); }
      });

  it.each(['mcp', 'native', 'stop', 'elapsed'])('ends the normal reload waiting minute on %s', async ending => {
        const input = await import("../../../../../backend/domains/sessions/input/input.js");
        input.resetInputForTests();
        vi.useFakeTimers();
        try {
          await writeDurableNow('session-input', []);
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('normal-listen')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          const session = (await findSessionByConversation(recoveryState.OTHER, { requireUnique: true }))!;
          const row = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next requested step', mode: 'after-turn', dueAt: Date.now(), model: null, reasoningEffort: null });
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          await maintenance(repair!.token);
          const deadline = Date.now() + 60_000;
          // The same durable boundary survives an outbox reload.
          input.resetInputForTests();
          expect((await sessionControlsFor(session.id)).recovery).toEqual([{ kind: 'post-reload', next: 'queue', deadline, generating: true }]);
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await input.claimBrowserInput(row.id, 'normal-listen-page', recoveryState.OTHER)).toBeNull();
          if (ending === 'mcp') await attributed(recoveryState.OTHER, false, Date.now());
          if (ending === 'native') await events(recoveryState.OTHER, [{ kind: 'assistant_message', messageId: 'normal-listen-resumes', turnId: 'normal-listen', text: 'Continuing the work', state: 'streaming', activeNow: true, time: Date.now() }]);
          if (ending === 'stop') await events(recoveryState.OTHER, [endTurn('normal-listen', 'stopped')]);
          if (ending === 'elapsed') {
            await vi.advanceTimersByTimeAsync(30_000);
            await sweepStaleSwarm(Date.now());
            const controls = await sessionControlsFor(session.id);
            expect(controls.activeTurnId).toBeNull();
            expect(controls.recovery).toEqual([{ kind: 'post-reload', next: 'queue', deadline }]);
            expect(await input.claimBrowserInput(row.id, 'normal-listen-page', recoveryState.OTHER)).not.toBeNull();
          } else {
            expect((await sessionControlsFor(session.id)).recovery).toEqual(ending === 'stop' ? [] : [{ kind: 'silence', deadline: Date.now() + CHAT_SILENCE_MS, visibleAt: Date.now() + CHAT_SILENCE_MS - 30_000 }]);
          }
        } finally { await writeDurableNow('session-input', []); input.resetInputForTests(); vi.useRealTimers(); }
      });

  it('hands a reloaded page the question whose turn this app has already ended', async () => {
        await pair();
        await events(recoveryState.OTHER, [{ kind: 'user_message', messageId: 'settled-question', text: 'Audit the paperless setup.', time: Date.now() },
          openTurn('settled-turn')]);
        const running = (await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body;
        expect(running.settledQuestionId).toBeNull();
        await events(recoveryState.OTHER, [endTurn('settled-turn', 'stalled')]);
        expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.settledQuestionId).toBe('settled-question');
        // A new question is not settled by the old turn.
        await events(recoveryState.OTHER, [{ kind: 'user_message', messageId: 'fresh-question', text: 'Now continue.', time: Date.now() + 1 },
          openTurn('fresh-turn')]);
        expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.settledQuestionId).toBeNull();
      });

  it('H2 records the machine reason and immediately offers the existing assistant-error episode', async () => {
        await pair();
        await events(recoveryState.OTHER, [{ kind: 'user_message', time: Date.now(), messageId: 'h2-question', text: 'Trabaja en esta tarea.' }, openTurn('h2-turn')]);
        await events(recoveryState.OTHER, [{ kind: 'chat_error', time: Date.now(), turnId: 'h2-turn', text: 'The response stream is unavailable.',
          recoverable: true, reason: 'stream_gone' }]);
        const session = await findSessionByConversation(recoveryState.OTHER);
        expect(await readEvents(session!.id, { kinds: ['chat_error'] })).toEqual([
          expect.objectContaining({ reason: 'stream_gone', turnId: 'h2-turn' })
        ]);
        const repair = await maintenance();
        expect(repair).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'assistant-error' });
        await events(recoveryState.OTHER, [{ kind: 'chat_error', time: Date.now(), turnId: 'h2-turn', text: 'Resume stream unavailable', recoverable: true }]);
        expect((await maintenance())?.token).toBe(repair!.token);
        expect(await readEvents(session!.id, { kinds: ['chat_error'] })).toHaveLength(1);
        expect((await getSession(session!.id))?.activeTurnId).toBe('h2-turn');
        // A deferred live-stream action returns the same episode without spending its budget.
        expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(true);
        await request('GET', `/status?repairFailed=${repair!.token}&repairAction=reloaded`);
        const retry = await maintenance();
        expect(retry?.reason).toBe('assistant-error');
        expect((await request('POST', '/repairs/claim', { body: { token: retry!.token } })).body.allowed).toBe(true);
        await maintenance(retry!.token, 'reloaded');
        await events(recoveryState.OTHER, [{ kind: 'chat_error', time: Date.now(), turnId: 'h2-turn', text: 'another notice', recoverable: true, reason: 'stream_gone' }]);
        expect(await maintenance()).toBeNull();
      });

  it('lets the user cancel an interrupted-response reload for this answer only (#1032)', async () => {
        await pair();
        const errorFor = (turnId: string) => ({ kind: 'chat_error' as const, time: Date.now(), turnId,
          text: 'Connection interrupted. Waiting for the complete answer', recoverable: true });
        await events(recoveryState.PRIME, [{ kind: 'user_message', time: Date.now(), messageId: 'cancel-q1', text: 'Refactor it' }, openTurn('cancel-t1')]);
        await events(recoveryState.PRIME, [errorFor('cancel-t1')]);
        const session = (await findSessionByConversation(recoveryState.PRIME))!;
        const shown = async () => (await sessionControlsFor(session.id)).recovery?.filter(countdown => countdown.kind === 'assistant-error') ?? [];
        expect(await shown()).toHaveLength(1);
        expect(await cancelAssistantRecovery(session.id)).toBe(true);
        expect(await shown()).toEqual([]);
        expect(await maintenance()).toBeNull();
        // The page keeps reporting the same lost stream: the cancelled answer stays cancelled.
        await events(recoveryState.PRIME, [errorFor('cancel-t1')]);
        expect(await shown()).toEqual([]);
        expect(await maintenance()).toBeNull();
        // The next question is a new answer and gets its own reload again.
        await events(recoveryState.PRIME, [endTurn('cancel-t1', 'failed'),
          { kind: 'user_message', time: Date.now(), messageId: 'cancel-q2', text: 'Try again' }, openTurn('cancel-t2')]);
        await events(recoveryState.PRIME, [errorFor('cancel-t2')]);
        expect(await shown()).toHaveLength(1);
        // Once the browser has claimed the reload it is already happening; cancel no longer applies.
        const repair = await maintenance();
        expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(true);
        expect(await cancelAssistantRecovery(session.id)).toBe(false);
      });

  it.each(['idle', 'old-turn', 'old-question', 'final', 'foreign-turn'])('H2 rejects %s evidence before it can spend the current question reload', async scenario => {
        await pair();
        await events(recoveryState.OTHER, [{ kind: 'user_message', time: Date.now(), messageId: 'h2-question', text: 'Work here.' }, openTurn('h2-turn')]);
        let turnId: string | null = 'h2-turn';
        if (scenario === 'idle') await events(recoveryState.OTHER, [endTurn('h2-turn', 'completed')]);
        if (scenario === 'old-turn') turnId = 'old-document-turn';
        if (scenario === 'old-question') await events(recoveryState.OTHER, [{ kind: 'user_message', time: Date.now(), messageId: 'h2-next-question', text: 'Now this.' }, openTurn('h2-next-turn')]);
        if (scenario === 'final') await recordFinalForTest(recoveryState.OTHER, 'h2-turn');
        if (scenario === 'foreign-turn') { await events(recoveryState.PRIME, [openTurn('foreign-document-turn')]); turnId = 'foreign-document-turn'; }
        await events(recoveryState.OTHER, [{ kind: 'chat_error', time: Date.now(), turnId, reason: 'stream_gone', recoverable: true, text: 'resume HTTP 404' }]);
        expect(await maintenance()).toBeNull();
        const session = await findSessionByConversation(recoveryState.OTHER);
        expect(await readEvents(session!.id, { kinds: ['chat_error'] })).toEqual([]);
      });

  it.each(['machine-first', 'DOM-first'])('H2 keeps one notice and repair when %s', async order => {
        await pair();
        await events(recoveryState.OTHER, [{ kind: 'user_message', time: Date.now(), messageId: 'h2-question', text: 'Work here.' }, openTurn('h2-turn')]);
        const machine = { kind: 'chat_error', time: Date.now(), turnId: 'h2-turn', reason: 'stream_gone', recoverable: true, text: 'resume HTTP 404' };
        const dom = { kind: 'chat_error', time: Date.now(), turnId: 'h2-turn', recoverable: true, text: 'La conexión se interrumpió.' };
        const [first, second] = order === 'machine-first' ? [machine, dom] : [dom, machine];
        await events(recoveryState.OTHER, [first]);
        const repair = await maintenance();
        await events(recoveryState.OTHER, [second]);
        expect((await maintenance())?.token).toBe(repair!.token);
        const session = await findSessionByConversation(recoveryState.OTHER);
        const rows = await readEvents(session!.id, { kinds: ['chat_error'] });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ message: { text: first!.text } });
      });

  it('H2 cannot acquire a newer question while its recovery source read is in flight', async () => {
        await pair();
        await events(recoveryState.OTHER, [{ kind: 'user_message', time: Date.now(), messageId: 'h2-question', text: 'First task.' }, openTurn('h2-turn')]);
        const original = sessionStoreModule.readLatestUserMessage;
        let entered = () => {}, release = () => {};
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const lookup = vi.spyOn(sessionStoreModule, 'readLatestUserMessage').mockImplementation(async (sessionId, turnId) => {
          if (turnId === 'h2-turn') { entered(); await gate; }
          return original(sessionId, turnId);
        });
        try {
          const oldFailure = events(recoveryState.OTHER, [{ kind: 'chat_error', time: Date.now(), turnId: 'h2-turn',
            text: 'resume HTTP 404', reason: 'stream_gone', recoverable: true }]);
          await reading;
          await events(recoveryState.OTHER, [{ kind: 'user_message', time: Date.now(), messageId: 'h2-new-question', text: 'Next task.' }, openTurn('h2-new-turn')]);
          release(); await oldFailure;
          expect(await maintenance()).toBeNull();
          // The stale result has not spent the new question's valid transport-repair budget.
          await events(recoveryState.OTHER, [{ kind: 'chat_error', time: Date.now(), turnId: 'h2-new-turn',
            text: 'resume HTTP 404', reason: 'stream_gone', recoverable: true }]);
          expect((await maintenance())?.reason).toBe('assistant-error');
        } finally { release(); lookup.mockRestore(); }
      });

  it.each(['assistant-error', 'silence', 'no-tab', 'stalled'] as const)('revokes an offered %s repair when MCP puts the worker to sleep', async reason => {
        await pair();
        spawn({ workers: [{ task: 'bounded worker task' }], caller: { conversationId: recoveryState.PRIME } });
        const command = await redeem();
        await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' } });
        const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
        try {
          await events(recoveryState.WORKER, [
            { kind: 'user_message', time: start, messageId: 'worker-question', text: 'Inspect this task.' },
            openTurn('silent-worker-source')
          ]);
          await attributed(recoveryState.WORKER, false, start);
          clock.mockReturnValue(start + 120_000);
          if (reason === 'assistant-error') await events(recoveryState.WORKER, [{ kind: 'chat_error', time: Date.now(),
            turnId: 'silent-worker-source', recoverable: true, text: 'Connection interrupted. Waiting for the complete answer' }]);
          else if (reason === 'no-tab') await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          else if (reason === 'stalled') await request('POST', '/status', { body: { openConversations: [recoveryState.WORKER], stalledConversations: [recoveryState.WORKER] } });
          else await sweepStaleSwarm(Date.now());
          const offered = await maintenance();
          expect(offered).toMatchObject({ conversationId: recoveryState.WORKER, reason });
    
          clock.mockReturnValue(start + WORKER_SILENCE_MS);
          const requestId = `wfr_prime_sleep_${reason}`;
          await events(recoveryState.PRIME, [{ kind: 'tool_evidence', time: Date.now(),
            calls: [{ messageId: 'prime-status-call', tool: 'read', order: 0, answered: false, requestId }] }]);
          const { dispatch, ok } = await import("../../../../../backend/infrastructure/tool-gateway/protocol/kernel.js");
          const handler = vi.fn(async () => ok('Prime is still working.'));
          await dispatch('read', {}, null, requestId, 'core', handler);
          expect(handler).toHaveBeenCalledOnce();
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find(row => row.id === 'worker-1')?.state).toBe('sleeping');
          // No bridge maintenance sweep intervenes: the kernel's sleep must revoke the issued token immediately, before Chrome can claim it or protect the old tab.
          expect((await request('POST', '/repairs/claim', { body: { token: offered!.token } })).body.allowed).toBe(false);
          const status = await request('POST', '/status', { body: { openConversations: [recoveryState.WORKER] } });
          expect(status.body.repairs).toEqual([]);
          expect(status.body.nonDiscardableConversations).not.toContain(recoveryState.WORKER);
          await events(recoveryState.WORKER, [{ kind: 'chat_error', time: Date.now(), turnId: 'silent-worker-source',
            recoverable: true, text: 'Connection interrupted. Waiting for the complete answer' }]);
          expect(await maintenance()).toBeNull();
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find(row => row.id === 'worker-1')?.state).toBe('sleeping');
          // Real new work may wake the worker, but cannot resurrect the old handout.
          const staged = stageMessages({ conversationId: recoveryState.PRIME }, [{ to: 'worker-1', text: 'A new task.' }]);
          staged.commit();
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find(row => row.id === 'worker-1')?.state).toBe('waking');
          expect((await request('POST', '/repairs/claim', { body: { token: offered!.token } })).body.allowed).toBe(false);
        } finally { clock.mockRestore(); }
      });
});
