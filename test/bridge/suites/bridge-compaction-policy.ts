import type { Reply } from "../test-context.js";
import { bindConversation, continuationByToken, continuationForSession, describe, expect, findSessionByConversation, getConfig, it, pair, pendingCommands, PRIME_CHAT, recordToolCall, request, resetBlockedChatsForTests, setChatBlocked, spawn, vi } from "../test-context.js";
import { settled, over, withThreshold } from './bridge-compaction-support.js';

describe('automatic compaction', () => {
  it('files the ticket itself for a working chat over the line, once, and never for a finished one', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac01';
    await withThreshold(10_000, async () => {
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-live' }, ...over()]
        }
      });
      // Ticket creation and its durable job publication are asynchronous. Observe the published job instead of assuming a fixed sleep covers filesystem contention.
      let working!: Reply;
      await vi.waitFor(async () => {
        working = await request('GET', `/activity?conversationId=${conversationId}`);
        expect(working.body.job).toMatchObject({ stage: 'handoff-pending', automatic: true });
      }, { timeout: 3000 });
      const sessionId = working.body.sessionId as string;
      const ticket = continuationForSession(sessionId);
      expect(ticket).toMatchObject({ automatic: true, state: 'awaiting-summary', from: conversationId });
      // The page reads the ticket back as its job and resumes it; nothing else is asked of it.
      expect(working.body.job).toMatchObject({ stage: 'handoff-pending', automatic: true });

      // More work in the same turn is the same ticket.
      await request('POST', '/events', {
        body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-live' }] }
      });
      await settled();
      expect(continuationForSession(sessionId)?.token).toBe(ticket!.token);

      // Auto Off cancels it; the chat finishing its answer does not earn another one. Still far over the line, and deliberately untouched: there is nothing left to carry into a fresh chat once the answer has been written.
      expect((await request('POST', '/settings', { body: { conversationId, autoCompact: false } })).status).toBe(200);
      expect((await request('POST', '/settings', { body: { conversationId, autoCompact: true } })).status).toBe(200);
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-live', outcome: 'completed' }]
        }
      });
      await settled();
      const finished = await request('GET', `/activity?conversationId=${conversationId}`);
      expect(finished.body.tokens).toBeGreaterThan(10_000);
      expect(continuationForSession(sessionId)).toBeNull();
    });
  });

  // Block is the user's stop for a chat: its tools are refused. The loop, a goal and the automatic compaction are three more hands this app has on the same chat, and each one would carry ChatGPT on without those tools — the loop typing the next message, a resume opening a replacement chat the block does not even cover. So the block fences all of them, says why on the feed, and lifts cleanly when the chat is released.
  it('suspends Goal, Loop and compaction for a chat the user blocked, until it is released', async () => {
    await pair();
    const conversationId = 'b10cced0-0000-4000-8000-00000000ac05';
    await request('POST', '/goal/objective', { body: { conversationId, text: 'finish the level editor' } });
    await request('POST', '/settings', { body: { conversationId, loop: true } });
    setChatBlocked(conversationId, true);
    try {
      await withThreshold(10_000, async () => {
        await request('POST', '/events', {
          body: {
            conversationId,
            events: [{ kind: 'turn_start', time: Date.now(), turnId: 'blocked-turn-live' }, ...over()]
          }
        });
        await settled();
        const activity = await request('GET', `/activity?conversationId=${conversationId}`);
        expect(activity.body.tokens).toBeGreaterThan(10_000);
        expect(continuationForSession(activity.body.sessionId as string)).toBeNull();
        expect(activity.body.context).toMatchObject({ auto: false });
        expect(activity.body.goal).toMatchObject({ enabled: false, own: true, blocked: 'blocked', pending: null });
        expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);

        const manual = await request('POST', '/compact', { body: { conversationId } });
        expect(manual.status).toBe(409);
        expect(manual.body.error).toBe('chat_blocked');
        const goalOn = await request('POST', '/settings', { body: { conversationId, goal: true } });
        expect(goalOn.status).toBe(409);
        expect(goalOn.body.error).toBe('chat_blocked');
        const autoOn = await request('POST', '/settings', { body: { conversationId, autoCompact: true } });
        expect(autoOn.status).toBe(409);
        expect(autoOn.body.error).toBe('chat_blocked');
        const newGoal = await request('POST', '/goal/objective', { body: { conversationId, text: 'something else' } });
        expect(newGoal.status).toBe(409);
        expect(newGoal.body.error).toBe('chat_blocked');
        // Turning things off stays the user's to do from either side.
        const loopOff = await request('POST', '/settings', { body: { conversationId, loop: false } });
        expect(loopOff.status).toBe(200);
        const draft = await request('POST', '/goal/draft', {
          body: { conversationId, turnId: 'blocked-turn-live', clientId: 'tab-1' }
        });
        expect(draft.status).toBe(409);
        expect(draft.body.error).toBe('goal_disabled');
        expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);
      });

      // Released: the stored goal is still there and the loop is back on the chat's own terms.
      setChatBlocked(conversationId, false);
      const released = await request('GET', `/activity?conversationId=${conversationId}`);
      expect(released.body.goal).toMatchObject({ blocked: '', objective: 'finish the level editor' });
      expect(released.body.context).toMatchObject({ auto: true });
    } finally {
      resetBlockedChatsForTests();
    }
  });

  it('never compacts a worker out of the conversation that is its agent identity', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac04';
    spawn({ workers: [{ task: 'stay in this worker chat' }], caller: { conversationId: PRIME_CHAT } });
    expect(bindConversation('worker-1', conversationId)).toBe(true);

    await withThreshold(10_000, async () => {
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_start', time: Date.now(), turnId: 'worker-turn-live' }, ...over()]
        }
      });
      await settled();
      const activity = await request('GET', `/activity?conversationId=${conversationId}`);
      expect(activity.body.tokens).toBeGreaterThan(10_000);
      expect(continuationForSession(activity.body.sessionId as string)).toBeNull();
      expect(activity.body.context).toMatchObject({ auto: false, threshold: 10_000 });
      expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);

      const manual = await request('POST', '/compact', { body: { conversationId } });
      expect(manual.status).toBe(409);
      expect(manual.body.error).toBe('worker_compaction_disabled');
      const settings = await request('POST', '/settings', {
        body: { conversationId, autoCompact: false }
      });
      expect(settings.status).toBe(409);
      expect(settings.body.error).toBe('worker_compaction_disabled');
      expect(getConfig().compaction.auto).toBe(true);
      // No compaction path may create the replacement-chat transport a worker is forbidden to use. Its conversation remains its agent identity.
      expect(pendingCommands().some((command) => command.what.startsWith('resume:'))).toBe(false);
    });
  });

  it('files an automatic ticket before page work, cancels it on Auto Off, and does not refile on On', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac05';
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'user_message', time: Date.now(), text: 'keep the long run going', messageId: 'm-auto-ticket' }]
      }
    });
    const session = await findSessionByConversation(conversationId, { requireUnique: true });
    expect(session).not.toBeNull();

    const filed = await request('POST', '/compact', {
      body: { conversationId, ticket: true, automatic: true }
    });
    expect(filed.status).toBe(202);
    expect(filed.body).toMatchObject({ filed: true, prompt: null });
    const token = filed.body.token as string;
    expect(continuationByToken(token)).toMatchObject({ automatic: true, state: 'awaiting-summary' });

    const off = await request('POST', '/settings', { body: { conversationId, autoCompact: false } });
    expect(off.status).toBe(200);
    expect(continuationByToken(token)?.state).toBe('aborted');

    expect((await request('POST', '/settings', { body: { conversationId, autoCompact: true } })).status).toBe(200);
    expect(continuationForSession(session!.id)).toBeNull();
  });

  it('durably ends an automatic ticket when the source page proves the handoff never reached Send', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac08';
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'user_message', time: Date.now(), text: 'composer rejected the handoff', messageId: 'm-auto-lost' }]
      }
    });
    const filed = await request('POST', '/compact', {
      body: { conversationId, ticket: true, automatic: true }
    });
    const token = filed.body.token as string;
    expect((await request('POST', '/compact', { body: { conversationId, token, sourceAttempt: true } })).body.allowed).toBe(true);

    const lost = await request('POST', '/compact', { body: { conversationId, token, sourceLost: true } });
    expect(lost.status).toBe(200);
    expect(lost.body.aborted).toBe(true);
    expect(continuationByToken(token)).toMatchObject({ state: 'aborted', error: 'handoff_never_sent' });
    expect(continuationForSession(filed.body.sessionId as string)).toBeNull();
    expect((await request('POST', '/compact', { body: { conversationId, token, sourceDispatch: true } })).status).toBe(409);
  });

  // The chat that kept working after its ticket was refused, with no turn on its page. A refusal is a verdict about the turn that would not take the handoff, and it is read as standing while no turn is running. That is right for a chat that stopped and wrong for one whose page lost its turn while the connector went on answering tool calls for it: `activeTurnId` is null for that whole stretch, so the refusal never lapses and the level rule that protects an oversized chat can never fire again. Measured on 2026-09-21 with the threshold at 400,000: a ticket given up at 417,733 tokens, twenty-two minutes of work with no turn on the page, nothing filed, 632,211 by the time the run stopped on its own.
  it('files again for an oversized chat still working after its ticket was refused', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac0b';
    await withThreshold(10_000, async () => {
      await request('POST', '/events', { body: { conversationId, events: over() } });
      await settled();
      const activity = await request('GET', `/activity?conversationId=${conversationId}`);
      const sessionId = activity.body.sessionId as string;

      // The verdict a given-up ticket leaves behind. Its turn is null because the chat had none, which is exactly the state the read below used to treat as "no turn is running".
      const { refuseAutomaticCompactionNow } = await import("../../../backend/domains/sessions/history/store.js");
      await refuseAutomaticCompactionNow(sessionId, conversationId, null);
      const open = continuationForSession(sessionId);
      if (open) await request('POST', '/compact', { body: { conversationId, token: open.token, sourceLost: true } });
      expect(continuationForSession(sessionId)).toBeNull();

      // Working, and with no turn of its own: exactly attributed local calls, close enough together that the chat never stops working between them.
      for (let index = 0; index < 3; index += 1) {
        const requestId = `wfr_refused_still_working_${index}`;
        await request('POST', '/events', { body: { conversationId, events: [{
          kind: 'tool_evidence', time: Date.now(),
          calls: [{ messageId: `m-refused-working-${index}`, tool: 'read', order: 0, answered: false, requestId }]
        }] } });
        await recordToolCall({ tool: 'read', args: { paths: ['/project/a.ts'] },
          content: [{ type: 'text' as const, text: 'ok' }], outcome: 'ok' as const,
          durationMs: 1, startedAt: Date.now(), requestId });
        await settled();
      }

      await vi.waitFor(() => expect(continuationForSession(sessionId))
        .toMatchObject({ automatic: true, state: 'awaiting-summary' }), { timeout: 3000 });
    });
  });

  // 2026-10-09: briefly opening an old worker chat whose turn had been open since 09-25 filed an automatic compaction at 408k tokens, and its pickups reloaded the chat for 50 minutes.
  it('does not compact a chat whose only claim to work is a turn opened long ago', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac1d';
    await withThreshold(10_000, async () => {
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_start', time: Date.now() - 8 * 24 * 60 * 60_000, turnId: 'turn-left-open' }, ...over()]
        }
      });
      await settled();
      const activity = await request('GET', `/activity?conversationId=${conversationId}`);
      const sessionId = activity.body.sessionId as string;
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(continuationForSession(sessionId)).toBeNull();

      // A turn that really runs now still compacts.
      await request('POST', '/events', { body: { conversationId, events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-now' }, ...over()] } });
      await settled();
      await vi.waitFor(() => expect(continuationForSession(sessionId)).toMatchObject({ automatic: true }), { timeout: 3000 });
    });
  });
});
