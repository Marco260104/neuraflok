import { continuationByToken, continuationForSession, describe, expect, it, pair, readEvents, request, resetBridgeForTests, restoreContinuations, sweepStaleSwarm, vi } from "../test-context.js";
import { settled, over, withThreshold } from './bridge-compaction-support.js';

describe('automatic compaction', () => {
  it('does not immediately refile a rejected automatic compaction in the same working turn', async () => {
    await pair();
    const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac09';
    await withThreshold(10_000, async () => {
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_start', time: Date.now(), turnId: 'turn-rejected-compact' }, ...over()]
        }
      });
      await settled();
      const activity = await request('GET', `/activity?conversationId=${conversationId}`);
      const sessionId = activity.body.sessionId as string;
      await vi.waitFor(() => expect(continuationForSession(sessionId)).toMatchObject({ automatic: true, state: 'awaiting-summary' }), { timeout: 3000 });
      const first = continuationForSession(sessionId);

      const lost = await request('POST', '/compact', {
        body: { conversationId, token: first!.token, sourceLost: true }
      });
      expect(lost.status).toBe(200);
      expect(continuationForSession(sessionId)).toBeNull();

      // More live evidence from this exact turn must not create a fresh token behind the persistent composer draft that just rejected the previous one.
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{
            kind: 'assistant_message',
            time: Date.now(),
            turnId: 'turn-rejected-compact',
            text: 'still working',
            messageId: 'a-rejected-compact',
            state: 'streaming',
            activeNow: true
          }]
        }
      });
      await settled();
      expect(continuationForSession(sessionId)).toBeNull();

      // A genuine turn boundary spends the refusal. The next working turn can compact again.
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_end', time: Date.now(), turnId: 'turn-rejected-compact', outcome: 'completed' }]
        }
      });
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'turn_start', time: Date.now(), turnId: 'turn-after-rejection' },
            {
              kind: 'assistant_message',
              time: Date.now(),
              turnId: 'turn-after-rejection',
              text: 'new turn is working',
              messageId: 'a-after-rejection',
              state: 'streaming',
              activeNow: true
            }
          ]
        }
      });
      await settled();
      await vi.waitFor(() => expect(continuationForSession(sessionId)).toMatchObject({ automatic: true, state: 'awaiting-summary' }), { timeout: 3000 });
    });
  });

  // Before the prompt has reached ChatGPT the pickup starts on a two-minute clock. Exhausting that first browser-recovery budget is not terminal authority for an automatic ticket: a responsive source may have spent the whole interval draining local/native work. The exact token survives and retries on a slower cadence until explicit policy/user/page evidence ends it.
  it.each([false, true])('retains an unsent automatic ticket after its first pickup budget and retries after backoff (restored: %s)', async restored => {
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac06';
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'user_message', time: Date.now(), text: 'generate the huge handoff', messageId: 'm-auto-watch' }]
        }
      });
      const filed = await request('POST', '/compact', {
        body: { conversationId, ticket: true, automatic: true }
      });
      const token = filed.body.token as string;

      if (restored) {
        const { snapshotContinuations } = await import("../../../backend/domains/sessions/continuity/continuation.js");
        const snapshot = snapshotContinuations();
        resetBridgeForTests();
        await pair();
        await restoreContinuations({ ...snapshot, entries: snapshot.entries.map(entry => entry.token === token
          ? { ...entry, openedAt: Date.now() - 60_000 } : entry) });
      }

      const takeRepair = async (): Promise<{ conversationId: string; token: string; reason: string; focus: boolean } | null> => {
        await sweepStaleSwarm(Date.now());
        return (await request('GET', '/status')).body.repairs?.[0] ?? null;
      };
      await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
      expect(await takeRepair()).toBeNull();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await vi.advanceTimersByTimeAsync(attempt === 0 ? 1 : 2 * 60_000);
        const handout = await takeRepair();
        expect(handout).toMatchObject({ conversationId, reason: 'compaction', focus: true });
        await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`);
        expect(continuationByToken(token)).toMatchObject({ state: 'awaiting-summary' });
      }

      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(await takeRepair()).toBeNull();
      expect(continuationByToken(token)).toMatchObject({ automatic: true, state: 'awaiting-summary' });
      expect(continuationForSession(filed.body.sessionId as string)?.token).toBe(token);

      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(await takeRepair()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(await takeRepair()).toMatchObject({ conversationId, reason: 'compaction', focus: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // The retry is bounded. Each pickup reloads the source page, and a chat that can never reach Send (#419: a turn that died mid-tool-call leaves results the page never acknowledges) would otherwise be reloaded every two minutes for as long as it exists. After the first burst and two slowed bursts the ticket is abandoned as a manual one is, and the next working turn opens anew.
  it('abandons an automatic ticket that never reaches Send after its bounded retry bursts', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac07';
      await request('POST', '/events', {
        body: { conversationId, events: [{ kind: 'user_message', time: Date.now(), text: 'a chat that cannot send', messageId: 'm-auto-bound' }] }
      });
      const filed = await request('POST', '/compact', { body: { conversationId, ticket: true, automatic: true } });
      const token = filed.body.token as string;
      const takeRepair = async (): Promise<{ token: string; reason: string } | null> => {
        await sweepStaleSwarm(Date.now());
        return (await request('GET', '/status')).body.repairs?.[0] ?? null;
      };
      let reloads = 0;
      // Three bursts of five pickups; the pause between bursts is ten minutes.
      for (let burst = 0; burst < 3; burst += 1) {
        await vi.advanceTimersByTimeAsync(burst === 0 ? 2 * 60_000 : 10 * 60_000);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (attempt > 0) await vi.advanceTimersByTimeAsync(2 * 60_000);
          const handout = await takeRepair();
          expect(handout, `burst ${burst} attempt ${attempt}`).toMatchObject({ reason: 'compaction' });
          await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`);
          reloads += 1;
        }
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(await takeRepair()).toBeNull();
      }
      expect(reloads).toBe(15);
      expect(continuationForSession(filed.body.sessionId as string)?.token, 'abandoned, not retained').not.toBe(token);
      // No further reloads, however long the chat stays open.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(await takeRepair()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Once the marked prompt is with ChatGPT the pickup is a five-minute clock with three reloads, so a glitched writing page costs a quarter of an hour at most rather than three of them. The ticket itself is never failed by a pickup here; it stays open for the page to finish. The writing phase's three are its own — the asking phase spent none of them.
  it('reloads one automatic ticket at 5-minute checkpoints while the brief is being written', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac07';
      await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'user_message', time: Date.now(), text: 'generate the huge handoff', messageId: 'm-auto-watch-2' }]
        }
      });
      const filed = await request('POST', '/compact', {
        body: { conversationId, ticket: true, automatic: true }
      });
      const token = filed.body.token as string;

      const takeRepair = async (): Promise<{ conversationId: string; token: string; reason: string } | null> => {
        await sweepStaleSwarm(Date.now());
        return (await request('GET', '/status')).body.repairs?.[0] ?? null;
      };
      // One asking-phase pickup spent before the page gets the prompt out.
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      const asking = await takeRepair();
      expect(asking).toMatchObject({ conversationId, reason: 'compaction' });
      await request('GET', `/status?repaired=${asking!.token}&repairAction=reloaded`);

      expect((await request('POST', '/compact', { body: { conversationId, token, sourceAttempt: true } })).body.allowed).toBe(true);
      expect((await request('POST', '/compact', { body: { conversationId, token, sourceDispatch: true } })).body.armed).toBe(true);
      expect(continuationByToken(token)?.sourceSend.state).toBe('dispatched-unresolved');

      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(await takeRepair()).toBeNull();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.advanceTimersByTimeAsync(attempt === 0 ? 1 : 5 * 60_000);
        const handout = await takeRepair();
        expect(handout).toMatchObject({ conversationId, reason: 'compaction' });
        await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`);
      }

      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(await takeRepair()).toBeNull();
      expect(continuationByToken(token)).toMatchObject({ automatic: true, state: 'awaiting-summary' });
    } finally {
      vi.useRealTimers();
    }
  });

  // #787: writing pickup 3/3 used to end in silence. The sent request stays protected and collectable, no fourth reload is authorized, and the person is told exactly once.
  it('after writing pickup 3/3, records exactly one visible note, performs no fourth recovery, and retains awaiting-summary', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ac08';
      await request('POST', '/events', {
        body: { conversationId, events: [{ kind: 'user_message', time: Date.now(), text: 'generate the huge handoff', messageId: 'm-auto-told' }] }
      });
      const filed = await request('POST', '/compact', { body: { conversationId, ticket: true, automatic: true } });
      const token = filed.body.token as string;
      const sessionId = filed.body.sessionId as string;
      expect((await request('POST', '/compact', { body: { conversationId, token, sourceAttempt: true } })).body.allowed).toBe(true);
      expect((await request('POST', '/compact', { body: { conversationId, token, sourceDispatch: true } })).body.armed).toBe(true);

      const takeRepair = async (): Promise<{ conversationId: string; token: string; reason: string } | null> => {
        await sweepStaleSwarm(Date.now());
        return (await request('GET', '/status')).body.repairs?.[0] ?? null;
      };
      const stuckNotes = async () => (await readEvents(sessionId, { kinds: ['note'] }))
        .filter(event => event.kind === 'note' && /still waiting for this chat's handoff/.test(event.message.text));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        const handout = await takeRepair();
        expect(handout).toMatchObject({ conversationId, reason: 'compaction' });
        await request('GET', `/status?repaired=${handout!.token}&repairAction=reloaded`);
      }
      expect(await stuckNotes(), 'told before the budget was spent').toHaveLength(0);

      for (let sweep = 0; sweep < 4; sweep += 1) {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(await takeRepair(), `fourth recovery on sweep ${sweep}`).toBeNull();
      }
      expect(await stuckNotes()).toHaveLength(1);
      expect(continuationByToken(token)).toMatchObject({ state: 'awaiting-summary', sourceSend: { state: 'dispatched-unresolved' } });
    } finally {
      vi.useRealTimers();
    }
  });
});
