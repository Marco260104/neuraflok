import type { SessionEvent } from "../test-context.js";
import { randomUUID } from "node:crypto";
import { webProviderConversationId } from "../../../contracts/web-providers.js";
import { foldProgress } from "../../../contracts/session.js";
import { abortContinuation, CHAT_SILENCE_MS, compactSession, continuationByToken, continuationForSession, createSession, describe, expect, faultGate, getConfig, getSession, it, liveConversations, pair, PRO_SILENCE_MS, readEvents, recordFinalForTest, recordToolCall, recoveryBrowserWake, request, saveConfig, sessionStoreModule, setChatBlocked, setStuckNotifier, sweepStaleSwarm, vi } from "../test-context.js";
import { settled, over, withThreshold } from './bridge-compaction-support.js';

describe('automatic compaction', () => {
  it('says an app-started Compact & resume reloaded its chat to send the request, in a row naming that chat', async () => {
    await pair();
    const conversationId = randomUUID();
    const session = await createSession({ conversationId });
    await compactSession(session.id);
    const handout = (await request('GET', '/status')).body.repairs
      .find((row: { conversationId: string }) => row.conversationId === conversationId);
    expect(handout).toMatchObject({ reason: 'compaction' });
    await request('POST', '/repairs/claim', { body: { token: handout.token } });
    await request('GET', `/status?repaired=${encodeURIComponent(handout.token)}&repairAction=reloaded`);
    const rows = foldProgress((await readEvents(session.id, { kinds: ['progress'] })).filter(
      (event): event is Extract<SessionEvent, { kind: 'progress' }> => event.kind === 'progress' && !!event.progressId?.startsWith('browser-repair:')
    ));
    // The page paints this row only in the chat it names; Compact & resume moves the session on.
    expect(rows.map(row => row.kind === 'progress' ? [row.progressId!.split(':')[1], row.message.text] : [])).toEqual([
      [conversationId, 'Reloaded chat to send the handoff request for Compact & resume.']
    ]);
  });

  it('hands out an explicitly requested Compact & resume for a chat whose tab the user closed', async () => {
    // 2026-09-30, live on 2.1.22: the test chat's tab had been closed, so its automatic recovery was paused. The explicit Compact & resume was then dropped at handout without a word and expired ten minutes later as "it took too long". Pressing it is the user coming back.
    await pair();
    const conversationId = randomUUID();
    const session = await createSession({ conversationId });
    await request('POST', '/closed', { body: { conversationId, manual: true } });
    expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBeDefined();
    await compactSession(session.id);
    const handout = (await request('GET', '/status')).body.repairs
      .filter((row: { conversationId: string }) => row.conversationId === conversationId);
    expect(handout).toEqual([expect.objectContaining({ reason: 'compaction' })]);
    // The browser may also claim it, and so open the chat's tab again. A refused claim left the offer unclaimed until the app gave up ("no page; not offering again"), 2026-10-06 on 2.1.28.
    expect((await request('POST', '/repairs/claim', { body: { token: handout[0].token } })).body.allowed).toBe(true);
  });

  it('keeps the concrete pre-send failure and refuses a stale page abort of a newer ticket', async () => {
    await pair();
    const conversationId = randomUUID();
    const session = await createSession({ conversationId });
    const first = await request('POST', '/compact', { body: { conversationId, ticket: true } });
    const sourceError = 'The provider message box is not ready (composer_missing).';
    const lost = await request('POST', '/compact', { body: { conversationId, token: first.body.token, sourceLost: true, sourceError } });
    expect(lost.body.aborted).toBe(true);
    expect(continuationByToken(first.body.token)).toMatchObject({ state: 'aborted', error: sourceError });
    const second = await request('POST', '/compact', { body: { conversationId, ticket: true } });
    expect((await request('POST', '/compact', { body: { conversationId, token: first.body.token, sourceLost: true, sourceError } })).status).toBe(409);
    expect(continuationForSession(session.id)?.token).toBe(second.body.token);
  });

  it('hands an explicit desktop compaction to startup and fences a cancelled ticket', async () => {
    await pair();
    const conversationId = webProviderConversationId('deepseek', 'a1a1a1a1-0000-4000-8000-00000000ac98');
    const session = await createSession({ conversationId });
    await compactSession(session.id);
    expect(recoveryBrowserWake).toHaveBeenCalledTimes(1);
    const [url, , , authority] = recoveryBrowserWake.mock.calls[0]!;
    expect(url).toBe('https://chat.deepseek.com/');
    expect(authority?.current()).toBe(true);
    abortContinuation(continuationForSession(session.id)!.token, 'user_cancelled');
    expect(authority?.current()).toBe(false);
  });

  it('recovers a manual compaction with Auto Off and revokes cold startup on cancel', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = webProviderConversationId('deepseek', 'a1a1a1a1-0000-4000-8000-00000000ac99');
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'user_message', time: Date.now(), text: 'manual handoff', messageId: 'manual-pickup' }
      ] } });
      await request('POST', '/settings', { body: { conversationId, autoCompact: false } });
      const filed = await request('POST', '/compact', { body: { conversationId, ticket: true } });
      expect(filed.status).toBe(202);
      const ticket = continuationForSession(filed.body.sessionId)!;
      expect(ticket.automatic).toBe(false);
      await request('POST', '/settings', { body: { conversationId, autoCompact: false } });
      expect(continuationForSession(ticket.sessionId)?.token).toBe(ticket.token);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await sweepStaleSwarm(Date.now());
      expect(recoveryBrowserWake).toHaveBeenCalledTimes(1);
      const [url, , , authority] = recoveryBrowserWake.mock.calls[0]!;
      expect(url).toBe('https://chat.deepseek.com/');
      expect(authority?.current()).toBe(true);
      await sweepStaleSwarm(Date.now());
      expect(recoveryBrowserWake).toHaveBeenCalledTimes(1);
      abortContinuation(ticket.token, 'user_cancelled');
      expect(authority?.current()).toBe(false);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await sweepStaleSwarm(Date.now());
      expect(recoveryBrowserWake).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(['failed', 'old-turn', 'new-question', 'completed', 'stopped', 'auto-off', 'pro'] as const)(
    'compacts only the exact failed oversized source after a transport error (%s)', async scenario => {
      await pair();
      const conversationId = randomUUID();
      await withThreshold(10_000, async () => {
        const config = getConfig();
        await saveConfig({ ...config, compaction: { ...config.compaction, auto: false } });
        await request('POST', '/events', { body: { conversationId, events: [
          ...(scenario === 'pro' ? [{ kind: 'model_selection', model: 'GPT-6 Pro', time: Date.now() }] : []),
          { kind: 'turn_start', time: Date.now(), turnId: 'lost-turn' },
          ...over(),
          { kind: 'turn_end', time: Date.now(), turnId: 'lost-turn', outcome: scenario === 'stopped' ? 'stopped' : 'failed' }
        ] } });
        await settled();
        const sessionId = (await request('GET', `/activity?conversationId=${conversationId}`)).body.sessionId;
        expect(continuationForSession(sessionId)).toBeNull();
        if (scenario === 'completed') await recordFinalForTest(conversationId, 'lost-turn');
        if (scenario === 'new-question') await request('POST', '/events', { body: { conversationId, events: [
          { kind: 'user_message', time: Date.now(), messageId: 'new-question', text: 'A different request' }
        ] } });
        if (scenario !== 'auto-off') await saveConfig(config);
        await request('POST', '/events', { body: { conversationId, events: [
          { kind: 'chat_error', time: Date.now(), turnId: scenario === 'old-turn' ? 'earlier-turn' : 'lost-turn',
            recoverable: true, text: 'Connection interrupted. Waiting for the complete answer' }
        ] } });
        if (scenario === 'failed') expect(continuationForSession(sessionId)).toMatchObject({ automatic: true });
        else expect(continuationForSession(sessionId)).toBeNull();
      });
    });

  // A chat whose last turn produced nothing, and the silence nobody reported. The watchdog that reaches the desktop is the reload budget's, and only a chat that keeps answering reloads with the same failure ever reaches it. The commonest stop does not: a turn ends, nothing follows it, and there is no open turn left to watch. The app treats that as settled — correctly, there is nothing left to repair — and says so only to its log. `stalled` is the worse half and only ever fell outside by omission. The page writes it for "no visible output and no progress for ten minutes": a turn that produced nothing at all, which for the person watching is the same standstill as a failure. Without the mark such a chat took the branch that drops it out of the silence watch entirely, so nothing reached finishSilentChats and nothing was ever said. Measured on one machine on 2026-09-13: four episodes, 24 + 53 + 76 + 45 minutes, 198 minutes of a working day, the last ended by the user noticing. And on 2026-09-25 the `stalled` half: a turn opened at 17:31:59 after a resume, produced nothing, was closed `stalled` at 17:44:44, and the chat sat untouched with four workers still running until its owner typed by hand.
  it.each(['stalled', 'failed'] as const)('reports a chat whose last turn ended %s with nothing after it', async outcome => {
    const told: Array<{ title: string; body: string }> = [];
    setStuckNotifier((title, body) => { told.push({ title, body }); return true; });
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = `a1a1a1a1-0000-4000-8000-00000000${outcome === 'stalled' ? 'de01' : 'de02'}`;
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'user_message', time: Date.now(), text: 'audit the homelab', messageId: `m-${outcome}` },
        { kind: 'turn_start', time: Date.now(), turnId: `turn-${outcome}` }
      ] } });
      await vi.advanceTimersByTimeAsync(1_000);
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'turn_end', time: Date.now(), turnId: `turn-${outcome}`, outcome,
          ...(outcome === 'stalled' ? { detail: 'no visible output and no progress for ten minutes' } : {}) }
      ] } });

      // Nothing follows it: no new turn, no reply, no call.
      await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS + 30_000);
      await sweepStaleSwarm(Date.now());
      await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS + 30_000);
      await sweepStaleSwarm(Date.now());

      expect(told.map(item => item.title), `a ${outcome} turn left the chat unreported`)
        .toContain('A chat stopped');
      // The wording says which of the two happened: "ended in a transport failure" is not true of a turn that simply never spoke.
      expect(told.find(item => item.title === 'A chat stopped')!.body)
        .toContain(outcome === 'stalled' ? 'produced nothing' : 'failed');
    } finally {
      setStuckNotifier(null);
      vi.useRealTimers();
    }
  });

  it('observes Astra per chat, refuses automatic tickets, and preserves manual compaction', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac90';
    await withThreshold(10_000, async () => {
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'model_selection', model: 'GPT-6 Pro', time: Date.now() },
        { kind: 'turn_start', time: Date.now(), turnId: 'astra-live' }, ...over()
      ] } });
      await settled();
      const activity = await request('GET', `/activity?conversationId=${conversationId}`);
      expect(activity.body.context.auto).toBe(false);
      expect(continuationForSession(activity.body.sessionId)).toBeNull();
      const automatic = await request('POST', '/compact', { body: { conversationId, ticket: true, automatic: true } });
      expect(automatic.status).not.toBe(202);
      expect(continuationForSession(activity.body.sessionId)).toBeNull();
      const manual = await request('POST', '/compact', { body: { conversationId, ticket: true } });
      expect(manual.status).toBe(202);
      expect(continuationForSession(activity.body.sessionId)?.automatic).toBe(false);
    });
  });

  it('withdraws an already filed automatic ticket before its send after selecting Astra', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac91';
    await withThreshold(10_000, async () => {
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'turn_start', time: Date.now(), turnId: 'before-astra' }, ...over()
      ] } });
      const activity = await request('GET', `/activity?conversationId=${conversationId}`);
      // Ticket persistence runs after event ingestion; wait for that fact rather than assuming the hosted runner commits it within a 25 ms sleep.
      await vi.waitFor(() => expect(continuationForSession(activity.body.sessionId)).toMatchObject({ automatic: true }), { timeout: 3000 });
      const ticket = continuationForSession(activity.body.sessionId)!;
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'model_selection', model: 'gpt-6', reasoningEffort: 'pro', time: Date.now() }
      ] } });
      const send = await request('POST', '/compact', { body: { conversationId, token: ticket.token, sourceAttempt: true } });
      expect(send.status).toBe(409);
      expect(send.body.error).toBe('automatic_compaction_disabled');
      expect(continuationForSession(activity.body.sessionId)).toBeNull();
    });
  });

  it.each(['missing', 'failed'] as const)('compacts attributed work after its page turn is %s', async pageTurn => {
    await pair();
    const conversationId = randomUUID();
    await withThreshold(10_000, async () => {
      // The failure happened below the threshold. Only later tool results make this chat oversized, and no new page turn arrives to trigger compaction.
      const created = await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'user_message', time: Date.now(), text: 'Continue the task', messageId: 'blind-source' },
        ...(pageTurn === 'failed' ? [
          { kind: 'turn_start', time: Date.now(), turnId: 'blind-page-turn' },
          { kind: 'turn_end', time: Date.now(), turnId: 'blind-page-turn', outcome: 'failed' }
        ] : [])
      ] } });
      const sessionId = created.body.sessionId as string;
      expect(continuationForSession(sessionId)).toBeNull();
      const requestId = `wfr_compact_without_page_${pageTurn}`;
      await request('POST', '/events', { body: { conversationId, events: [{
        kind: 'tool_evidence', time: Date.now(),
        calls: [{ messageId: 'blind-call', tool: 'read', order: 0, answered: false, requestId }]
      }] } });
      const call = () => recordToolCall({ tool: 'read', args: { paths: ['/project/mine.ts'] },
        content: [{ type: 'text', text: 'x'.repeat(44_000) }], outcome: 'ok', durationMs: 1,
        startedAt: Date.now(), requestId });
      await call();
      expect((await getSession(sessionId))?.activeTurnId).toBeNull();
      expect(liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId).toBeNull();
      await vi.waitFor(() => expect(continuationForSession(sessionId)).toMatchObject({
        from: conversationId, automatic: true, state: 'awaiting-summary'
      }), { timeout: 3000 });
      const ticket = continuationForSession(sessionId)!;
      expect((await request('GET', `/activity?conversationId=${conversationId}`)).body.job)
        .toMatchObject({ stage: 'handoff-pending', automatic: true });
      await call();
      expect(continuationForSession(sessionId)?.token).toBe(ticket.token);
    });
  });

  it.each(['finished', 'stopped', 'auto-off', 'pro', 'blocked', 'closed'] as const)(
    'checks compaction authority when fresh tools follow a page-local end (%s)', async scenario => {
      await pair();
      const conversationId = randomUUID();
      await withThreshold(10_000, async () => {
        const selected = scenario === 'pro'
          ? [{ kind: 'model_selection', model: 'GPT-6 Pro', time: Date.now() }] : [];
        const created = await request('POST', '/events', { body: { conversationId, events: [
          ...selected,
          { kind: 'user_message', time: Date.now(), text: 'Continue the task', messageId: 'guarded-source' },
          { kind: 'turn_start', time: Date.now(), turnId: 'guarded-page-turn' }
        ] } });
        const sessionId = created.body.sessionId as string;
        const requestId = `wfr_compact_guard_${scenario}`;
        await request('POST', '/events', { body: { conversationId, events: [{
          kind: 'tool_evidence', time: Date.now(),
          calls: [{ messageId: 'guarded-call', tool: 'read', order: 0, answered: false, requestId }]
        }] } });
        const call = (text: string) => recordToolCall({ tool: 'read', args: { paths: ['/project/mine.ts'] },
          content: [{ type: 'text', text }], outcome: 'ok', durationMs: 1, startedAt: Date.now(), requestId });
        // Establish the request's turn before the native final, exactly as a real tool stream does; a first-ever post-final call has no such provenance.
        await call('Initial tool result');
        if (scenario === 'finished') await request('POST', '/events', { body: { conversationId, events: [{
          kind: 'assistant_message', time: Date.now(), turnId: 'guarded-page-turn',
          messageId: 'guarded-native-final', providerMessageId: '11111111-2222-4333-8444-555555555555',
          text: 'The requested work is complete.', state: 'final', final: true, activeNow: true
        }] } });
        const endedAt = Date.now();
        await request('POST', '/events', { body: { conversationId, events: [{
          kind: 'turn_end', time: endedAt, turnId: 'guarded-page-turn',
          outcome: scenario === 'stopped' ? 'stopped' : scenario === 'finished' ? 'completed' : 'failed'
        }] } });
        if (scenario === 'auto-off') await request('POST', '/settings', { body: { conversationId, autoCompact: false } });
        if (scenario === 'blocked') setChatBlocked(conversationId, true);
        if (scenario === 'closed') await request('POST', '/closed', { body: { conversationId, manual: true } });
        // This case requires a call STARTED after the end. Fast hosts can execute both within one millisecond; disk speed is not ownership evidence.
        const later = Math.max(Date.now(), endedAt + 1);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
        try {
          await call('x'.repeat(44_000));
          await settled();
          expect((await getSession(sessionId))?.contextTokens).toBeGreaterThan(10_000);
          if (scenario === 'finished') expect(await sessionStoreModule.readCompletedFinal(sessionId, conversationId))
            .toMatchObject({ messageId: 'guarded-native-final' });
          if (scenario === 'stopped') await vi.waitFor(() =>
            expect(continuationForSession(sessionId)).toMatchObject({ automatic: true, from: conversationId }));
          else expect(continuationForSession(sessionId)).toBeNull();
        } finally {
          clock.mockRestore();
          if (scenario === 'blocked') setChatBlocked(conversationId, false);
        }
      });
    });

  it.each(['image-first', 'end-first', 'missing-proof', 'wrong-image', 'stopped', 'unfinished-image'] as const)(
    'releases input only for the exact completed native image (%s)', async scenario => {
      await pair();
      const conversationId = randomUUID(), messageId = randomUUID();
      const opened = await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'user_message', time: Date.now(), messageId: randomUUID(), text: 'Generate an image.' },
        { kind: 'turn_start', time: Date.now(), turnId: 'image-turn' }
      ] } });
      const sessionId = opened.body.sessionId;
      const image = { kind: 'native_image', time: Date.now(), turnId: 'image-turn', messageId,
        providerAssetId: 'file_1234567890abcdef', providerRole: 'tool', providerChannel: 'final',
        providerStatus: scenario === 'unfinished-image' ? 'in_progress' : 'finished_successfully', previewStatus: 'pending' };
      const end = { kind: 'turn_end', time: Date.now(), turnId: 'image-turn',
        outcome: scenario === 'stopped' ? 'stopped' : 'completed',
        ...(scenario !== 'missing-proof' ? { providerMessageId: scenario === 'wrong-image' ? randomUUID() : messageId } : {}) };
      const batch = async (event: unknown) => request('POST', '/events', { body: { conversationId, events: [event] } });
      await batch(scenario === 'end-first' ? end : image);
      expect(await sessionStoreModule.readCompletedFinal(sessionId, conversationId)).toBeNull();
      await batch(scenario === 'end-first' ? image : end);
      const complete = scenario === 'image-first' || scenario === 'end-first';
      expect(!!await sessionStoreModule.readCompletedFinal(sessionId, conversationId)).toBe(complete);
      const { sessionInputActivity } = await import("../../../backend/domains/browser/bridge.js");
      const { sessionInputPolicy } = await import("../../../backend/domains/sessions/input/input.js");
      if (complete) {
        const activity = sessionInputActivity((await getSession(sessionId))!);
        expect(activity).toMatchObject({ possible: false, exact: false });
        expect(await sessionInputPolicy(sessionId, activity)).toMatchObject({ browserAllowed: true, settled: true });
      }
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'user_message', time: Date.now(), messageId: randomUUID(), text: 'New question.' },
        { kind: 'turn_start', time: Date.now(), turnId: 'new-turn' }
      ] } });
      expect(await sessionStoreModule.readCompletedFinal(sessionId, conversationId)).toBeNull();
    });

  it.each(['expired', 'clock-back', 'auto-off', 'rebound'] as const)(
    'rechecks attributed compaction after storage yields when %s', async scenario => {
      await pair();
      const conversationId = randomUUID();
      await withThreshold(10_000, async () => {
        const requestId = `wfr_compact_yield_${scenario}`;
        const created = await request('POST', '/events', { body: { conversationId, events: [
          { kind: 'user_message', time: Date.now(), text: 'Continue the task', messageId: 'yield-source' },
          { kind: 'tool_evidence', time: Date.now(), calls: [
            { messageId: 'yield-call', tool: 'read', order: 0, answered: false, requestId }
          ] }
        ] } });
        const sessionId = created.body.sessionId as string;
        const gate = faultGate();
        const source = (await getSession(sessionId))!;
        const { sessionActivityExpiresAt } = await import("../../../backend/domains/browser/bridge.js");
        const superseded = sessionStoreModule.conversationWasSuperseded;
        let held = false;
        const lookup = vi.spyOn(sessionStoreModule, 'conversationWasSuperseded')
          .mockImplementation(async id => {
            // The recorder also checks supersession before publishing attribution. Hold only the later lookup after this exact chat has its MCP grant.
            if (id === conversationId && !held && sessionActivityExpiresAt(source) !== null) {
              held = true;
              await gate.hold();
            }
            return superseded(id);
          });
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        try {
          await recordToolCall({ tool: 'read', args: { paths: ['/project/mine.ts'] },
            content: [{ type: 'text', text: 'x'.repeat(44_000) }], outcome: 'ok', durationMs: 1,
            startedAt: Date.now(), requestId });
          await vi.waitFor(() => expect(held).toBe(true));
          await gate.entered;
          expect(continuationForSession(sessionId)).toBeNull();
          if (scenario === 'expired') clock.mockReturnValue(Date.now() + CHAT_SILENCE_MS);
          if (scenario === 'clock-back') clock.mockReturnValue(Date.now() - 1);
          if (scenario === 'auto-off') await saveConfig({ ...getConfig(), compaction: {
            ...getConfig().compaction, auto: false
          } });
          if (scenario === 'rebound') expect(await sessionStoreModule.rebindSession(sessionId, conversationId, randomUUID())).toBe(true);
          gate.release();
          await settled();
          expect(continuationForSession(sessionId)).toBeNull();
        } finally { gate.release(); lookup.mockRestore(); clock.mockRestore(); }
      });
    });
});
