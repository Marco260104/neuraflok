import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { once } from "node:events";
import { foldProgress } from "../../../../../contracts/session.js";
import { beforeEach, bridgeState, BROWSER_RECOVERY_COOLDOWN_MS, describe, expect, EXTENSION_ORIGIN, findSessionByConversation, getConfig, getLog, it, pair, readEvents, recordProgress, request, resetBridgeForTests, saveConfig, unattributedRepairEta, vi } from "../../../test-context.js";
import type { SessionEvent } from "../../../test-context.js";
import { attributed, chatOf, endTurn, events, maintenance, maintenanceBatch, openTurn, reopened, unattributed, unattributedTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: extension presence and stalled repairs", () => {
  beforeEach(resetRecoveryFixture);

  it.each([1, 2, 3])('wakes the extension at the exact deadline for %i suspects without a status poll', async count => {
        vi.useFakeTimers();
        let socket: WebSocket | undefined;
        try {
          await pair();
          const chats = [recoveryState.PRIME, recoveryState.WORKER, recoveryState.OTHER].slice(0, count);
          for (const chat of chats) await events(chat, [openTurn(`wake-${chat}`)]);
          socket = new WebSocket(bridgeState.base.replace('http:', 'ws:') + '/wake', { origin: EXTENSION_ORIGIN });
          await once(socket, 'open');
          const authenticated = once(socket, 'message'); socket.send(bridgeState.token!); await authenticated;
          const wake = new Promise<void>(resolve => socket!.on('message', bytes => {
            if (bytes.toString() === 'wake') resolve();
          }));
          await unattributed();
          const delay = count === 1 ? 15_000 : 60_000;
          if (delay) {
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(await maintenanceBatch()).toEqual([]);
          }
          await vi.advanceTimersByTimeAsync(delay ? 1 : 0);
          await wake;
          expect((await maintenanceBatch()).map(row => row.conversationId).sort()).toEqual(chats.sort());
        } finally {
          socket?.terminate();
          vi.useRealTimers();
        }
      });

  it('reports persistent helper transitions and keeps short loading changes quiet', async () => {
        await pair();
        const first = randomUUID(), other = randomUUID();
        const ask = (fiber: string | null, id = first) =>
          request('GET', `/activity?conversationId=${id}&since=0${fiber === null ? '' : `&fiber=${fiber}`}`);
        const lines = () => getLog().filter(entry => entry.message.includes('page-model helper as') &&
          (entry.message.includes(first) || entry.message.includes(other)));
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
          await ask(null); await ask('invalid'); await ask('ok');
          expect(lines()).toHaveLength(0);
          await ask('absent');
          clock.mockReturnValue(now + 2_000);
          await ask('empty');
          clock.mockReturnValue(now + 3_000);
          await ask('ok');
          expect(lines()).toHaveLength(0);
    
          await ask('absent');
          clock.mockReturnValue(now + 17_999);
          await ask('absent');
          expect(lines()).toHaveLength(0);
          clock.mockReturnValue(now + 18_000);
          await ask('absent'); await ask('absent');
          expect(lines()).toHaveLength(1);
          expect(lines()[0]).toMatchObject({ level: 'warn' });
          expect(lines()[0]!.message).toContain('after the helper repair attempt');
    
          await ask('empty');
          clock.mockReturnValue(now + 33_000);
          await ask('empty'); await ask(null);
          expect(lines()).toHaveLength(2);
          expect(lines()[1]).toMatchObject({ level: 'info' });
          await ask('ok'); await ask('ok');
          expect(lines()).toHaveLength(3);
          expect(lines()[2]!.message).toContain('readable turns');
          await ask('absent', other);
          clock.mockReturnValue(now + 48_000);
          await ask('absent', other);
          expect(lines()).toHaveLength(4);
        } finally { clock.mockRestore(); }
      });

  it('restarts helper grace on state changes and clock rollback, and clears it on bridge reset', async () => {
        await pair();
        const conversationId = randomUUID();
        const ask = (fiber: string) => request('GET', `/activity?conversationId=${conversationId}&fiber=${fiber}`);
        const lines = () => getLog().filter(entry => entry.message.includes(`bridge: ${conversationId} reports its page-model helper as`));
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
          await ask('absent');
          clock.mockReturnValue(now + 14_000);
          await ask('empty');
          clock.mockReturnValue(now + 15_000);
          await ask('empty');
          expect(lines()).toHaveLength(0);
          clock.mockReturnValue(now - 10_000);
          await ask('empty');
          clock.mockReturnValue(now + 4_999);
          await ask('empty');
          expect(lines()).toHaveLength(0);
          clock.mockReturnValue(now + 5_000);
          await ask('empty');
          expect(lines()).toHaveLength(1);
          await ask('absent');
          resetBridgeForTests();
          clock.mockReturnValue(now + 21_000);
          await ask('absent');
          expect(lines()).toHaveLength(1);
          clock.mockReturnValue(now + 36_000);
          await ask('absent');
          expect(lines()).toHaveLength(2);
        } finally { clock.mockRestore(); }
      });

  it('starts the helper grace over when no page was reporting at all', async () => {
        // The grace measures how long a helper has been broken, and only a live page reports it. So a chat whose tab closed, whose browser exited, or which this app reopened elsewhere is contributing nothing for that whole stretch — and the stretch used to satisfy the grace the instant the *new* page said its first word. Measured 2026-09-19: the prime's tab went at 08:47:49, the app reopened the chat at 08:52:44, and the warning was written 0.4 seconds later about a page that was reading ChatGPT's model again 6.5 seconds after that. Five minutes with no page counted as five minutes of being broken.
        await pair();
        // Its own conversation: the reporter keeps one degraded-state record per chat, and the neighbouring helper test drives PRIME through both faults and out the other side.
        const chat = 'fbfbfbfb-1111-2222-3333-000000000001';
        const ask = (fiber: string) =>
          request('GET', `/activity?conversationId=${chat}&since=0&fiber=${fiber}`);
        const lines = () =>
          getLog().filter((entry) => entry.message.includes('page-model helper as') && entry.message.includes(chat));
    
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
          await ask('absent');
          expect(lines()).toHaveLength(0);
    
          // The tab goes. Nothing reports for five minutes — which is not five minutes of a broken helper, it is five minutes of no helper being asked.
          clock.mockReturnValue(now + 5 * 60_000);
          await ask('absent');
          expect(lines(), 'a page 0 seconds old has not failed to come back').toHaveLength(0);
    
          // It earns its line the ordinary way: by still being absent a grace period later.
          clock.mockReturnValue(now + 5 * 60_000 + 16_000);
          await ask('absent');
          expect(lines()).toHaveLength(1);
        } finally {
          clock.mockRestore();
        }
      });

  it('bounds helper observations before any degraded state has been announced', async () => {
        await pair();
        const ids = Array.from({ length: 201 }, () => randomUUID());
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        const ask = (id: string) => request('GET', `/activity?conversationId=${id}&fiber=absent`);
        const lines = () => getLog().filter(entry => entry.message.includes('page-model helper as') &&
          ids.some(id => entry.message.includes(id)));
        try {
          const oldest = ids[0]!;
          for (const id of ids) await ask(id);
          expect(lines()).toHaveLength(0);
          clock.mockReturnValue(Date.now() + 15_000);
          await ask(oldest);
          expect(lines()).toHaveLength(0);
          clock.mockReturnValue(Date.now() + 15_000);
          await ask(oldest);
          expect(lines()).toHaveLength(1);
        } finally { clock.mockRestore(); }
      });

  it.each([30_000, 89_999, 90_000])('measures helper continuity across a %i ms reporting gap', async gap => {
        await pair();
        const chat = randomUUID(), now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const ask = () => request('GET', `/activity?conversationId=${chat}&fiber=absent`);
        const notices = () => getLog().filter(entry => entry.message.includes(`bridge: ${chat} reports its page-model helper as`));
        try {
          await ask();
          clock.mockReturnValue(now + gap);
          await ask();
          expect(notices()).toHaveLength(gap < 90_000 ? 1 : 0);
          clock.mockReturnValue(now + gap + 15_000);
          await ask();
          expect(notices()).toHaveLength(1);
        } finally { clock.mockRestore(); }
      });

  it('restarts helper grace when the clock moves behind the latest observation but not the first', async () => {
        await pair();
        const chat = randomUUID(), now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const ask = () => request('GET', `/activity?conversationId=${chat}&fiber=empty`);
        const notices = () => getLog().filter(entry => entry.message.includes(`bridge: ${chat} reports its page-model helper as`));
        try {
          await ask();
          clock.mockReturnValue(now + 14_000); await ask();
          clock.mockReturnValue(now + 10_000); await ask();
          clock.mockReturnValue(now + 15_000); await ask();
          expect(notices()).toHaveLength(0);
          clock.mockReturnValue(now + 25_000); await ask();
          expect(notices()).toHaveLength(1);
        } finally { clock.mockRestore(); }
      });

  it('explains a refused stalled-tab reload once a minute, not once a pass', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await attributed(recoveryState.PRIME);
          await vi.advanceTimersByTimeAsync(60 * 60_000);
          const stalled = () => request('POST', '/status', {
            body: { openConversations: [recoveryState.PRIME], stalledConversations: [recoveryState.PRIME] }
          });
          const lines = () => getLog().filter(entry => entry.message.includes('is a stalled browser tab — not reloaded'));
          await stalled();
          const first = lines().length;
          expect(first).toBeGreaterThan(0);
          for (let pass = 0; pass < 4; pass++) {
            await vi.advanceTimersByTimeAsync(10_000);
            await stalled();
          }
          expect(lines()).toHaveLength(first);
          await vi.advanceTimersByTimeAsync(20_000);
          await stalled();
          expect(lines()).toHaveLength(first + 1);
          // Clock rollback must not silence the refusal until wall time catches up.
          vi.setSystemTime(Date.now() - 120_000);
          await stalled();
          expect(lines()).toHaveLength(first + 2);
        } finally { vi.useRealTimers(); }
      });

  it('waits 15 seconds before handing a lone suspect to the browser once attribution has failed', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-live')]);
          await unattributed();
    
          expect(unattributedRepairEta()).toBe(15);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(14_999);
          expect(unattributedRepairEta()).toBe(1);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          const handout = await maintenance();
          expect(chatOf(handout)).toBe(recoveryState.PRIME);
          // Reported carried out, and that is the end of it: a reload whose effect there is any point waiting to observe is never repeated.
          expect(await maintenance(handout!.token)).toBeNull();
          expect(await maintenance()).toBeNull();
          // And the app opened nothing itself: that chat has a tab, and a url open would make a second one of it - the duplicate this path exists to avoid.
          expect(reopened(recoveryState.PRIME)).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
      });

  /** The session outlives Compact & Resume, so chat B's feed is cut from a log that also holds chat A's reloads. Every other row names a turn and finds none in B; a reload notice names none and was painted before B's first user message — the bootstrap — as if B had been reloaded three times before it was born. The bootstrap this app typed is the durable boundary: reloads before it are A's and leave the feed, reloads after it stay. */
      it('keeps an earlier chat’s reload notices out of the chat that resumed it', async () => {
        await pair();
        await events(recoveryState.PRIME, [
          { kind: 'user_message', time: Date.now(), text: 'build the level editor', messageId: 'm-a-1' }
        ]);
        const session = await findSessionByConversation(recoveryState.PRIME, { requireUnique: true });
        expect(session).not.toBeNull();
        expect(await recordProgress(session!.id, 'browser-repair:old', 'Reloaded chat to recover an interrupted response.')).not.toBeNull();
        await events(recoveryState.PRIME, [
          {
            kind: 'user_message',
            time: Date.now(),
            text: '[[NEURAFLOK-RESUME:O8THi8gMTC6LvH9GLclDIQ]]\n\nContinuing a NEURAFLOK session that was compacted.',
            messageId: 'm-b-bootstrap'
          }
        ]);
        expect(await recordProgress(session!.id, 'browser-repair:new', 'Reloaded chat to recover missing connector attribution.')).not.toBeNull();
    
        const feed = await request('GET', `/activity?conversationId=${recoveryState.PRIME}`);
        expect(feed.status).toBe(200);
        const notices = feed.body.stream.filter(
          (row: { kind: string; progressId?: string }) => row.kind === 'progress' && row.progressId?.startsWith('browser-repair:')
        );
        expect(notices.map((row: { progressId: string }) => row.progressId)).toEqual(['browser-repair:new']);
        // The bootstrap itself still anchors: the surviving notice sits after it.
        const bootstrap = feed.body.userAnchors.find((anchor: { messageId: string }) => anchor.messageId === 'm-b-bootstrap');
        expect(bootstrap).toBeDefined();
        expect(notices[0].seq).toBeGreaterThan(bootstrap.seq);
      });

  it('replaces one recovery timeline row as the browser attempt fails, retries and succeeds', async () => {
        vi.useFakeTimers();
        try {
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-reload-note')]);
          await unattributedTurn('timeline-retry');
          const openedAt = Date.now();
          await vi.advanceTimersByTimeAsync(60_000);
          const session = await findSessionByConversation(recoveryState.PRIME, { requireUnique: true });
          expect(session).not.toBeNull();
          const before = (await readEvents(session!.id)).reduce((seq, event) => Math.max(seq, event.seq), 0);
          const snapshots = async () => (await readEvents(session!.id, { kinds: ['progress'] })).filter(
            (event): event is Extract<SessionEvent, { kind: 'progress' }> => event.seq > before && event.kind === 'progress'
          );
    
          const handout = await maintenance();
          expect(chatOf(handout)).toBe(recoveryState.PRIME);
          expect((await snapshots()).map((event) => event.message.text)).toEqual([
            'Trying to reload chat to recover missing connector attribution…'
          ]);
          // The row names the turn it is repairing, so every reader files it inside that turn — the page paints it among the turn's tool calls rather than between turns.
          expect((await snapshots()).map((event) => event.turnId)).toEqual(['turn-reload-note']);
    
          await request('POST', '/repairs/claim', { body: { token: handout!.token } });
          const failed = await request(
            'GET',
            `/status?repairFailed=${encodeURIComponent(handout!.token)}&repairAction=reloaded`
          );
          expect(failed.status).toBe(200);
          expect(failed.body.repairs).toEqual([]);
          expect(foldProgress(await snapshots()).map((event) => event.kind === 'progress' ? event.message.text : '')).toEqual([
            'Reload failed while recovering missing connector attribution.'
          ]);
    
          await vi.advanceTimersByTimeAsync(1);
          await unattributedTurn('timeline-retry');
          await vi.advanceTimersByTimeAsync(openedAt + 300_000 - Date.now());
          const retry = await maintenance();
          expect(chatOf(retry)).toBe(recoveryState.PRIME);
          expect(foldProgress(await snapshots()).map((event) => event.kind === 'progress' ? event.message.text : '')).toEqual([
            'Trying to reload chat to recover missing connector attribution…'
          ]);
    
          await maintenance(retry!.token, 'reloaded');
          // Replaying the same receipt is harmless: only the still-handed token can update the row.
          const recorded = (await snapshots()).length;
          await maintenance(retry!.token, 'reloaded');
          expect(await snapshots()).toHaveLength(recorded);
          expect(foldProgress(await snapshots()).map((event) => event.kind === 'progress' ? event.message.text : '')).toEqual([
            'Reloaded chat to recover missing connector attribution.'
          ]);
          // Every rewrite of the row keeps the turn the first snapshot named.
          expect((await snapshots()).every((event) => event.turnId === 'turn-reload-note')).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

  /** A browser worker can disappear after collecting a handout but before reporting an action. Its next plain maintenance pass is the negative acknowledgement: success would have been reported in the same request, while an action-level exception uses the explicit failure receipt tested above. Either path must keep the repair retryable. */
      it('retains an issued unattributed token without issuing another action on polling', async () => {
        vi.useFakeTimers();
        try {
          await pair(); await events(recoveryState.PRIME, [openTurn('held-token')]);
          await unattributed(); await vi.advanceTimersByTimeAsync(15_000);
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.PRIME);
          expect(await maintenance()).toBeNull();
          expect(await maintenance()).toBeNull();
          expect(await maintenance(first!.token)).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  /** A repair answers one broken turn, not a chat forever. Nothing else retires it: the attributed call that clears a chat is exactly what a repaired turn need never make, so a turn that reloads, finishes and says nothing more would leave that chat permanently unrepairable - the next broken turn in it silently ignored. */
      it('repairs a later broken turn in a chat it has already repaired once', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('turn-first')]);
          await unattributed();
          await vi.advanceTimersByTimeAsync(60_000);
          expect(await maintenance((await maintenance())!.token)).toBeNull();
    
          // That turn ends without ever making an attributable call, and the next one breaks too.
          await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS);
          await events(recoveryState.PRIME, [endTurn('turn-first', 'completed')]);
          await vi.advanceTimersByTimeAsync(1);
          await events(recoveryState.PRIME, [{ kind: 'user_message', messageId: 'next-authored-turn', time: Date.now(), text: 'new work' }, openTurn('turn-second')]);
          await unattributed();
          await vi.advanceTimersByTimeAsync(60_000);
          expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
        } finally {
          vi.useRealTimers();
        }
      });

  it('retries a continuing request once at five minutes after the ordinary activity label expires', async () => {
        vi.useFakeTimers();
        try {
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
          await pair(); await events(recoveryState.PRIME, [openTurn('two-attempts')]);
          await unattributedTurn('req-two-attempts');
          const openedAt = Date.now();
          await vi.advanceTimersByTimeAsync(15_000);
          const first = await maintenance(); expect(chatOf(first)).toBe(recoveryState.PRIME);
          await maintenance(first!.token);
          await vi.advanceTimersByTimeAsync(1);
          await unattributedTurn('req-two-attempts');
          await vi.advanceTimersByTimeAsync(openedAt + 300_000 - Date.now() - 1);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          const second = await maintenance(); expect(chatOf(second)).toBe(recoveryState.PRIME);
          expect(second!.token).not.toBe(first!.token);
          await maintenance(second!.token);
          await unattributedTurn('req-two-attempts');
          await vi.advanceTimersByTimeAsync(600_000);
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it('reports only the requested ID budget and withholds ETA without a qualified retry', async () => {
        vi.useFakeTimers();
        try {
          await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
          await pair(); await events(recoveryState.PRIME, [openTurn('eta-request-budget')]);
          expect(unattributedRepairEta(Date.now(), 'eta-new-request')).toBe(15);
          await unattributedTurn('eta-known-request'); const openedAt = Date.now();
          await vi.advanceTimersByTimeAsync(15_000);
          const first = await maintenance(); await maintenance(first!.token);
          expect(unattributedRepairEta(Date.now(), 'eta-known-request')).toBeNull();
          await vi.advanceTimersByTimeAsync(1); await unattributedTurn('eta-known-request');
          expect(unattributedRepairEta(Date.now(), 'eta-known-request')).toBe(Math.ceil((openedAt + 300_000 - Date.now()) / 1000));
          await vi.advanceTimersByTimeAsync(openedAt + 300_000 - Date.now());
          const second = await maintenance(); await maintenance(second!.token);
          await events(recoveryState.OTHER, [openTurn('another-incident-chat')]);
          await unattributedTurn('eta-other-request');
          expect(unattributedRepairEta(Date.now(), 'eta-known-request')).toBeNull();
          await request('POST', '/correlations', { body: { conversationId: recoveryState.OTHER,
            calls: [{ requestId: 'eta-other-request', messageId: 'eta-resolved', tool: 'read', order: 0, answered: false }] } });
          expect(unattributedRepairEta(Date.now(), 'eta-other-request')).toBeNull();
        } finally { vi.useRealTimers(); }
      });
});
