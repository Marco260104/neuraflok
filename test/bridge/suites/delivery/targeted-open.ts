import { WEB_PROVIDERS, webProviderConversationId } from "../../../../contracts/web-providers.js";
import { randomUUID } from "node:crypto";
import { apiConversationId } from "../../../../contracts/chat-protocol.js";
import { abortContinuation, automaticCompactedSession, cancelResume, chatUrl, commandUrl, compactedSession, compactSession, continuationByToken, createSession, describe, expect, getConfig, getLog, getSession, it, opened, pair, pendingCommands, queueResume, readyContinuation, redeem, request, resumeJobFor, saveConfig, setBrowserOpener, suiteConfig, vi, waitForOpened } from '../../test-context.js';

// ----------------------------------------------------------------- delivery

/** Covers commands that open a provider chat directly. */
describe('targeted open', () => {
  it('opens the fresh chat the instant a resume is queued, with no tab and no timer involved', async () => {
    await pair();
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    // The selected provider page can be opened even when the companion has not polled yet.
    const { sessionId, token } = await compactedSession(webProviderConversationId('deepseek', randomUUID()), 'open from the source chat');
    const command = queueResume(sessionId, token)!;

    await waitForOpened(1);
    expect(opened).toEqual([commandUrl(command.id, 'deepseek')]);
    expect(commandUrl(command.id, 'deepseek')).toContain(`neuraflok-command=${command.id}`);
    expect(resumeJobFor(sessionId)).toMatchObject({ busy: true });
  });

  it.each(['deepseek', 'kimi', 'qwen', 'glm'] as const)(
    'opens a %s continuation on its source provider when settings select another provider',
    async provider => {
      const previous = getConfig();
      const selected = provider === 'qwen' ? 'kimi' : 'qwen';
      try {
        await saveConfig({ ...suiteConfig, ui: { ...suiteConfig.ui, webProvider: selected } });
        await pair();
        const source = webProviderConversationId(provider, randomUUID());
        const { sessionId, token } = await compactedSession(source, 'continue on the source provider');
        queueResume(sessionId, token);

        await waitForOpened(1);

        expect(new URL(opened[0]!).origin).toBe(new URL(WEB_PROVIDERS[provider].chatUrl).origin);
      } finally {
        await saveConfig(previous);
      }
    }
  );

  it('does not route API continuations through a browser provider', async () => {
    const conversationId = apiConversationId(randomUUID());
    const session = await createSession({ conversationId });
    const token = await readyContinuation(session.id, 'continue through the API executor', conversationId);
    queueResume(session.id, token);

    await vi.waitFor(() => expect(pendingCommands()).toEqual([]));

    expect(opened).toEqual([]);
    expect(continuationByToken(token)?.state).toBe('aborted');
    expect(() => chatUrl(conversationId)).toThrow('This conversation has no supported provider page.');
  });

  it('does not create a browser compaction ticket for an API session', async () => {
    const session = await createSession({ conversationId: apiConversationId(randomUUID()) });

    await expect(compactSession(session.id)).rejects.toThrow('api_compaction_not_supported');

    expect(opened).toEqual([]);
  });

  it('ends a browser-open rejection immediately rather than blocking the command queue', async () => {
    setBrowserOpener(async () => {
      throw new Error('no browser');
    });
    await pair();
    const { sessionId, token } = await compactedSession(webProviderConversationId('deepseek', randomUUID()), 'browser open rejected');
    queueResume(sessionId, token);
    // The lease write and opener rejection are both asynchronous.
    await vi.waitFor(() => expect(pendingCommands()).toEqual([]));

    expect(pendingCommands()).toEqual([]);
  });

  /** Fails a command immediately when the app cannot open a browser. */
  it('ends a command outright when this process cannot open a browser at all', async () => {
    setBrowserOpener(null);
    await pair();
    const { sessionId, token } = await compactedSession(webProviderConversationId('deepseek', '77777777-8888-9999-aaaa-bbbbbbbbbbbb'), 'carry on');
    queueResume(sessionId, token);

    expect(pendingCommands()).toEqual([]);
    expect(continuationByToken(token)?.state).toBe('aborted');
  });

  it('does not spin automatic retirement when no browser opener exists and its durable removal fails', async () => {
    await pair();
    const { sessionId, token } = await automaticCompactedSession('71111111-8888-9999-aaaa-bbbbbbbbbbbb', 'keep the ticket');
    const durable = await import("../../../../backend/persistence/durable.js");
    const original = durable.writeDurableNow;
    let removals = 0;
    const write = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value) => {
      if (name === 'bridge-commands' && (value as any)?.commands?.length === 0) {
        removals++;
        // Bound the old failure's retry storm so the regression terminates even before repair.
        if (removals <= 3) throw new Error('retirement disk unavailable');
      }
      return original(name, value);
    });
    try {
      setBrowserOpener(null);
      const command = queueResume(sessionId, token)!;
      await vi.waitFor(() => expect(removals).toBeGreaterThan(0));
      for (let n = 0; n < 40; n++) await Promise.resolve();
      expect(removals).toBe(1);
      expect(pendingCommands().some(entry => entry.id === command.id)).toBe(true);
      expect(continuationByToken(token)?.state).not.toBe('aborted');
    } finally { write.mockRestore(); }
  });

  it.each(['committing', 'committed', 'manual'] as const)('rechecks %s continuation ownership when queued retirement starts', async phase => {
    await pair();
    const { sessionId, token } = await automaticCompactedSession('72222222-8888-9999-aaaa-bbbbbbbbbbbb', 'retain changed ownership');
    const continuations = await import("../../../../backend/domains/sessions/continuity/continuation.js");
    const original = continuations.continuationByToken;
    let changed = false;
    let refreshed = false;
    const durable = await import("../../../../backend/persistence/durable.js");
    const originalWrite = durable.writeDurableNow;
    let removals = 0;
    const write = vi.spyOn(durable, 'writeDurableNow').mockImplementation(async (name, value) => {
      if (name === 'bridge-commands' && (value as any)?.commands?.length === 0) removals++;
      return originalWrite(name, value);
    });
    const read = vi.spyOn(continuations, 'continuationByToken').mockImplementation(candidate => {
      const current = original(candidate);
      if (candidate === token && changed) refreshed = true;
      // Publish the newer authoritative projection after drop queues its async transition.
      return current && candidate === token && changed ? { ...current,
        ...(phase === 'manual' ? { automatic: false } : { state: phase }) } : current;
    });
    try {
      setBrowserOpener(null);
      const command = queueResume(sessionId, token)!;
      changed = true;
      for (let n = 0; n < 80; n++) await Promise.resolve();
      expect(refreshed).toBe(true);
      expect(removals).toBe(0);
      expect(pendingCommands().some(entry => entry.id === command.id)).toBe(true);
    } finally { read.mockRestore(); write.mockRestore(); }
  });

  it('collapses repeated presses for one session into one job, one command and one tab', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await pair();
    const { sessionId, token } = await compactedSession(webProviderConversationId('deepseek', randomUUID()), 'one command and one tab');
    const first = queueResume(sessionId, token)!;
    const second = queueResume(sessionId, token)!;
    const third = queueResume(sessionId, token)!;

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(pendingCommands()).toHaveLength(1);
    // Claimed by the first open, so the repeats find nothing deliverable.
    await waitForOpened(1);
    expect(opened).toEqual([commandUrl(first.id, 'deepseek')]);
  });

  it('supersedes a queued resume in place when the same session is compacted again', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await pair();
    const chat = '33333333-4444-5555-6666-777777777777';
    const older = await compactedSession(chat, 'the older brief');
    const first = queueResume(older.sessionId, older.token)!;
    const oldPage = await request('POST', '/commands/redeem', { body: { id: first.id, client: 'old-tab' } });
    expect(oldPage.body.command.text).toContain('the older brief');

    // Pressing the button again is a second compaction of the same session, with its own brief and its own one-time token. The first transaction ends where it stands.
    abortContinuation(older.token, 'the user pressed the button again');
    const newerToken = await readyContinuation(older.sessionId, 'the newer brief', chat);
    const second = queueResume(older.sessionId, newerToken)!;

    // One session is one queued replacement chat, however many times it is compacted.
    expect(second.id).toBe(first.id);
    expect(pendingCommands()).toHaveLength(1);

    // The old page may finish its send after the command has been replaced in place. It no longer owns this id, so its delayed ACK must not commit the newer continuation to the old page's conversation.
    const stale = await request('POST', '/commands/ack', {
      body: { id: second.id, status: 'sent', conversationId: chat, client: 'old-tab' }
    });
    expect(stale.status).toBe(409);
    expect(pendingCommands()).toHaveLength(1);

    const redeemed = await request('POST', '/commands/redeem', { body: { id: second.id, client: 'tab-1' } });
    expect(redeemed.body.command.text).toContain('the newer brief');
    expect(redeemed.body.command.text).not.toContain('the older brief');
  });

  /** The tab opened and then nothing happened. There is no scheduler waiting to try again. This is the whole failure model in one test: the app opens exactly one chat, gives that page a deadline, and when the deadline passes the attempt is over. Over means the continuation is aborted and the session is still attached to the chat it was already in — a state the user can see and act on — rather than a queue entry that reopens a tab minutes later, on its own, for something they have stopped expecting. */
  it('ends the continuation when the chat it opened never reports back', async () => {
    vi.useFakeTimers();
    try {
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await pair();
      const { sessionId, token } = await compactedSession(webProviderConversationId('deepseek', '44444444-5555-6666-7777-888888888888'), 'carry on');
      const command = queueResume(sessionId, token)!;
      await waitForOpened(1);
      expect(opened).toEqual([commandUrl(command.id, 'deepseek')]);

      // The page never redeems, never acks, never types.
      await vi.advanceTimersByTimeAsync(90_000);

      expect(pendingCommands()).toEqual([]);
      expect(continuationByToken(token)?.state).toBe('aborted');
      // And no second tab was opened for it on the way out.
      expect(opened).toEqual([commandUrl(command.id, 'deepseek')]);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The claim outliving the command that made it. Redeeming is what claims the brief: the app records the redeeming command as `claimedBy` so a second tab on the same marker cannot be handed the same handoff twice. An *automatic* ticket deliberately survives a failed attempt — `drop()` retires the command and keeps the ticket, so a later pickup can try again — but the claim was never released with it, and every later pickup is a *new* command id which can therefore never equal `claimedBy`. `claimContinuationNow` then returns null for the rest of the ticket's six-hour life, the command is handed out with an empty brief, and the page stops without typing, without an ack and without a log line. Observed on 2026-09-09: four pickups, four opened tabs, four silent stops, `claimedBy` still naming the first tab's command hours after it was closed. Nothing here was ever submitted — `destinationSend` never leaves `not-attempted` — so releasing the claim cannot re-send anything. */
  it('lets the next pickup claim a brief whose first chat died before typing anything', async () => {
    vi.useFakeTimers();
    try {
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await pair();
      const { sessionId, token } = await automaticCompactedSession(
        '55555555-6666-7777-8888-999999999999',
        'the wedged brief'
      );
      const first = queueResume(sessionId, token)!;
      await waitForOpened(1);

      // The chat opens and its page redeems, which is the act that claims the brief. Then the tab is closed: nothing is typed, nothing is acked, nothing is reported.
      expect((await redeem(first.id, 'tab-1')).text).toContain('the wedged brief');
      expect(continuationByToken(token)?.destinationSend.state).toBe('not-attempted');

      // The command's own deadline passes with nothing reported.
      await vi.advanceTimersByTimeAsync(16 * 60_000);

      // An automatic ticket is kept on purpose — this is the state a later pickup exists for.
      expect(continuationByToken(token)?.state).not.toBe('aborted');
      await vi.waitFor(() => expect(pendingCommands().some((entry) => entry.id === first.id)).toBe(false));

      // So the next pickup, whose id is necessarily different, has to be able to carry it.
      const second = queueResume(sessionId, token)!;
      expect(second.id).not.toBe(first.id);
      expect((await redeem(second.id, 'tab-2')).text).toContain('the wedged brief');
      for (const flag of ['destinationAttempt', 'destinationDispatch', 'destinationLost']) {
        expect((await request('POST', '/compact', { body: { token, commandId: first.id, client: 'tab-1', [flag]: true } })).status).toBe(409);
        expect((await request('POST', '/compact', { body: { token, commandId: second.id, client: 'tab-1', [flag]: true } })).status).toBe(409);
      }
      expect(continuationByToken(token)?.destinationSend.state).toBe('not-attempted');
      expect((await request('POST', '/compact', { body: { token, destinationAttempt: true } })).status).toBe(409);
      expect((await request('POST', '/compact', { body: { token, commandId: second.id, client: 'tab-2', destinationAttempt: true } })).body.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /** #882 (2026-10-04): the replacement chat of an automatic handoff stopped at "choosing the model and reasoning" and the app waited out its whole 15-minute window. Meanwhile the prime was mid-transfer, so its workers' calls were refused, and one ended up asleep. The next pickup then opened a chat that finished in ten seconds. */
  it.each([
    ['model', true], ['composer', true], ['composer-after-model', true], ['inserting', false]
  ] as const)('releases an automatic handoff attempt whose page stops at a step before typing (%s)', async (stalledAt, released) => {
    vi.useFakeTimers();
    try {
      setBrowserOpener(async (url) => { opened.push(url); });
      await pair();
      const { sessionId, token } = await automaticCompactedSession(
        `66666666-7777-8888-9999-${stalledAt === 'inserting' ? 'aaaaaaaaaaab' : stalledAt === 'model' ? 'aaaaaaaaaaac' : stalledAt === 'composer' ? 'aaaaaaaaaaad' : 'aaaaaaaaaaae'}`,
        'the stalled brief'
      );
      const first = queueResume(sessionId, token)!;
      await waitForOpened(1);
      expect((await redeem(first.id, 'tab-1')).text).toContain('the stalled brief');
      expect((await request('POST', '/commands/step', { body: { id: first.id, client: 'tab-1', step: stalledAt } })).body).toEqual({ ok: true });
      const prior = new Set(getLog());

      await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000);
      await vi.waitFor(() => expect(pendingCommands().some((entry) => entry.id === first.id)).toBe(!released));
      expect(continuationByToken(token)?.state).not.toBe('aborted');
      if (!released) return;
      const note = getLog().find(entry => !prior.has(entry) && entry.message.includes('without closing its ticket'))?.message ?? '';
      expect(note).toContain('last step:');
      // The ticket survives, and the next pickup can carry the brief.
      const second = queueResume(sessionId, token)!;
      expect((await redeem(second.id, 'tab-2')).text).toContain('the stalled brief');
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws a cancelled resume so no tab opens for it afterwards', async () => {
    setBrowserOpener(async (url) => {
      opened.push(url);
    });
    await pair();
    const command = queueResume('session-cancel', 'handoff-cancel')!;
    await waitForOpened(1);

    expect(cancelResume('session-cancel')).toBe(true);
    expect(pendingCommands()).toEqual([]);

    // The tab is already open on the marker, and this is what it finds when it redeems: nothing, so it types nothing. That is the whole of cancellation reaching the browser.
    expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } })).status).toBe(404);
    expect(opened).toHaveLength(1);
  });

  it('hands a marked page its own command by id, once, and refuses an unknown id', async () => {
    await pair();
    const { sessionId, token } = await compactedSession('44444444-5555-6666-7777-888888888888', 'the brief itself');
    const command = queueResume(sessionId, token)!;

    const redeemed = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.command.id).toBe(command.id);
    expect(redeemed.body.command.text).toContain('the brief itself');
    // Redeeming again is fine — the page may reload — and the same page is the same claimant, so it gets the same brief back rather than an empty command.
    const again = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } });
    expect(again.body.command.text).toContain('the brief itself');
    expect(pendingCommands()).toHaveLength(1);

    expect((await request('POST', '/commands/redeem', { body: { id: 'not-a-command', client: 'tab-1' } })).status).toBe(
      404
    );
  });

  it('keeps a redeemed resume alive past the short ACK deadline without outliving its continuation', async () => {
    vi.useFakeTimers();
    try {
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await pair();
      const sourceConversation = '44444444-5555-6666-7777-888888888888';
      const { sessionId, token } = await compactedSession(
        sourceConversation,
        'the slow-start brief'
      );
      const command = queueResume(sessionId, token)!;

      // Browser/ChatGPT startup consumes most of the original open-attempt deadline.
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await redeem(command.id, 'slow-tab')).text).toContain('the slow-start brief');

      // Hidden Chromium tabs can stretch content.js's conversation-id wait beyond 90s. The exact page already owns the one-shot continuation, so the short command deadline must not abort it while that existing continuation is still valid.
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(pendingCommands().map((entry) => entry.what)).toEqual([`resume:${sessionId}`]);
      expect(continuationByToken(token)?.state).toBe('claimed');

      // The claim is progress, then ten minutes without further progress ends its waiting lease.
      await vi.advanceTimersByTimeAsync(8 * 60_000 + 1);
      expect(pendingCommands()).toEqual([]);
      expect(continuationByToken(token)?.state).toBe('aborted');
      expect((await getSession(sessionId))?.conversationId).toBe(sourceConversation);
    } finally {
      vi.useRealTimers();
    }
  });
});
