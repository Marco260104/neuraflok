import { randomUUID } from "node:crypto";
import { compactSession, continuationForSession, createSession, describe, expect, findSessionByConversation, getLog, it, pair, readEvents, request, setStuckNotifier } from "../test-context.js";
import { settled } from './bridge-compaction-support.js';

describe('automatic compaction', () => {
  // A repair nobody ever claims. Re-offering an unclaimed repair is right — a claim can be missed, and the page that missed it is the one that needs the reload — but it had no end. Every give-up here reads what the page reports back, so a page that never returns reports nothing, no counter moves, and no ceiling can fire. Measured on 2026-09-21: one chat whose tab was gone took 645 offers in five and a half hours, one of them ever confirmed, and it stopped only because the app was restarted.
  it('stops offering a repair the browser never claims, and says the chat has no page', async () => {
    await pair();
    const conversationId = randomUUID();
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'user_message', time: Date.now(), text: 'Continue this task', messageId: 'never-claimed' },
      { kind: 'turn_start', time: Date.now(), turnId: 'never-claimed-turn' },
      { kind: 'chat_error', time: Date.now(), turnId: 'never-claimed-turn', recoverable: true,
        text: 'Connection interrupted. Waiting for the complete answer' }
    ] } });
    await settled();

    const offered = async (): Promise<boolean> => {
      const status = await request('GET', '/status');
      return (status.body.repairs as Array<{ conversationId: string }>)
        .some(row => row.conversationId === conversationId);
    };
    expect(await offered(), 'no repair was offered at all').toBe(true);

    // Never claimed, only re-read. Bounded well above the ceiling so the loop cannot be what passes: if the offers were still unbounded this would still be true on the last pass.
    let seen = 1;
    for (let pass = 0; pass < 40 && await offered(); pass++) seen += 1;

    expect(seen, 'the repair was still being offered after forty reads').toBeLessThan(40);
    expect(await offered(), 'it came back after being retired').toBe(false);

    // The ceiling above bounds one repair, not the supply of them: the chat goes quiet, the sweep reads silence, and a fresh repair used to arrive with its own budget. Measured on 2026-09-21 over seven hours after a tab was discarded — four `no page` verdicts, 106 reload attempts, 600 offers, all into an empty room. A new failure must not restart it.
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'turn_start', time: Date.now(), turnId: 'never-claimed-again' },
      { kind: 'chat_error', time: Date.now(), turnId: 'never-claimed-again', recoverable: true,
        text: 'Connection interrupted. Waiting for the complete answer' }
    ] } });
    await settled();
    expect(await offered(), 'a fresh failure handed the same page-less chat a new budget').toBe(false);

    // Lifted by the one thing that can disprove it: the page itself, asking for its chat.
    await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'chat_error', time: Date.now(), turnId: 'never-claimed-again', recoverable: true,
        text: 'Connection interrupted. Waiting for the complete answer' }
    ] } });
    await settled();
    expect(await offered(), 'a page that came back was still refused recovery').toBe(true);

    const session = (await findSessionByConversation(conversationId))!;
    const notes = (await readEvents(session.id, { kinds: ['note'] }))
      .map(event => (event as { message: { text: string } }).message.text);
    expect(notes.some(text => text.includes('has no page to reload')),
      'the chat was dropped without saying why').toBe(true);
  });

  // The verdict above was a timeline note and a log line, which is where nobody is looking. Measured on 2026-09-30: a chat whose page stayed on "Resume stream unavailable" sat for hours, and the only trace was that note. Giving up is the moment to tell the person.
  it('tells the user once when the browser never claims a repair and recovery gives up', async () => {
    const told: Array<{ title: string; body: string; sessionId: string }> = [];
    setStuckNotifier((title, body, sessionId) => { told.push({ title, body, sessionId }); return true; });
    try {
      await pair();
      const conversationId = randomUUID();
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'user_message', time: Date.now(), text: 'Continue this task', messageId: 'never-claimed-notice' },
        { kind: 'turn_start', time: Date.now(), turnId: 'never-claimed-notice-turn' },
        { kind: 'chat_error', time: Date.now(), turnId: 'never-claimed-notice-turn', recoverable: true,
          text: 'Connection interrupted. Waiting for the complete answer' }
      ] } });
      await settled();

      const offered = async (): Promise<boolean> => {
        const status = await request('GET', '/status');
        return (status.body.repairs as Array<{ conversationId: string }>)
          .some(row => row.conversationId === conversationId);
      };
      expect(await offered(), 'no repair was offered at all').toBe(true);
      expect(told, 'told before the ceiling was reached').toEqual([]);
      for (let pass = 0; pass < 40 && await offered(); pass++);
      expect(await offered(), 'the repair was still being offered').toBe(false);

      const session = (await findSessionByConversation(conversationId))!;
      expect(told).toHaveLength(1);
      expect(told[0]!.sessionId).toBe(session.id);
      expect(told[0]!.body).toContain('tab');
      // Later reads of the same retired repair say nothing more.
      for (let pass = 0; pass < 5; pass++) await request('GET', '/status');
      expect(told).toHaveLength(1);
    } finally {
      setStuckNotifier(null);
    }
  });

  it.each([false, true])('hands manual compaction the pending repair only before browser claim (claimed=%s)', async claimed => {
    await pair();
    const conversationId = randomUUID();
    await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'user_message', time: Date.now(), text: 'Continue this task', messageId: 'manual-after-error' },
      { kind: 'turn_start', time: Date.now(), turnId: 'manual-after-error-turn' },
      { kind: 'chat_error', time: Date.now(), turnId: 'manual-after-error-turn', recoverable: true,
        text: 'Connection interrupted. Waiting for the complete answer' }
    ] } });
    await settled();
    const before = await request('GET', '/status');
    const errorRepair = before.body.repairs.find((row: { conversationId: string }) => row.conversationId === conversationId);
    expect(errorRepair?.reason).toBe('assistant-error');
    if (claimed) expect((await request('POST', '/repairs/claim', { body: { token: errorRepair.token } })).body.allowed).toBe(true);
    const session = (await findSessionByConversation(conversationId))!;
    await compactSession(session.id);
    const after = await request('GET', '/status');
    const repairs = after.body.repairs.filter((row: { conversationId: string }) => row.conversationId === conversationId);
    expect(repairs).toHaveLength(claimed ? 0 : 1);
    if (!claimed) expect(repairs[0]).toMatchObject({ reason: 'compaction', requiresClaim: true });
    expect((await request('POST', '/repairs/claim', { body: { token: errorRepair.token } })).body.allowed).toBe(false);
  });

  it.each(['cancelled', 'replaced', 'dispatched'] as const)('opens a manual source immediately and revokes a %s ticket before browser action', async scenario => {
    await pair();
    const conversationId = randomUUID();
    const session = await createSession({ conversationId });
    await compactSession(session.id);
    const ticket = continuationForSession(session.id)!;
    const status = await request('GET', '/status');
    const repair = status.body.repairs?.find((row: { conversationId: string }) => row.conversationId === conversationId);
    expect(repair).toMatchObject({ conversationId, reason: 'compaction', requiresClaim: true });
    if (scenario === 'dispatched') {
      await request('POST', '/compact', { body: { conversationId, token: ticket.token, sourceAttempt: true } });
      await request('POST', '/compact', { body: { conversationId, token: ticket.token, sourceDispatch: true } });
    } else {
      await request('POST', '/compact', { body: { conversationId, cancel: true } });
      if (scenario === 'replaced') await request('POST', '/compact', { body: { conversationId, ticket: true } });
    }
    expect((await request('POST', '/repairs/claim', { body: { token: repair.token } })).body.allowed).toBe(false);
    const after = await request('GET', '/status');
    expect(after.body.repairs?.some((row: { token: string }) => row.token === repair.token)).toBe(false);
  });

  it('logs once, in words, why the page held a handed repair, and hands nothing out for that report', async () => {
    await pair();
    const conversationId = randomUUID();
    const session = await createSession({ conversationId });
    await compactSession(session.id);
    const handout = (await request('GET', '/status')).body.repairs
      .find((row: { conversationId: string }) => row.conversationId === conversationId);
    const held = () => getLog().filter(entry => entry.message.includes(`held the compaction repair for ${conversationId}`)).map(entry => entry.message);
    for (let pass = 0; pass < 3; pass++) {
      const reply = await request('GET', `/status?repairHeld=${encodeURIComponent(handout.token)}&why=sending`);
      expect(reply.body.repairs).toEqual([]);
    }
    await request('GET', `/status?repairHeld=${encodeURIComponent(handout.token)}&why=draft`);
    await request('GET', `/status?repairHeld=unknown-token&why=sending`);
    expect(held()).toEqual([
      `bridge: the page held the compaction repair for ${conversationId}: a sent message is still waiting for the provider to confirm it`,
      `bridge: the page held the compaction repair for ${conversationId}: text or attachments are in the provider message box`
    ]);
    // The repair itself is untouched: the next ordinary pass still offers it.
    expect((await request('GET', '/status')).body.repairs.some((row: { token: string }) => row.token === handout.token)).toBe(true);
  });
});
