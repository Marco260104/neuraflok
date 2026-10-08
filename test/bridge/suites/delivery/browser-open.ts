import { webProviderConversationId } from "../../../../contracts/web-providers.js";
import { randomUUID } from "node:crypto";
import { commandUrl, compactedSession, compactSession, createSession, describe, expect, it, opened, pair, pendingCommands, queueResume, readDurable, redeem, request, SAMPLE_BRIEF, vi, waitForOpened, writeDurableNow } from '../../test-context.js';
import type { Reply } from '../../test-context.js';

// ------------------------------------------------- which browser opens chat B

/** Two Chrome instances, and the one thing the operating system cannot be told. The user had two Chrome instances open. A chat finished in the background one, Compact & Resume captured its brief, and the app asked the OS to open chat B — which resolved to the foreground instance, because that is what handing `chrome.exe` a URL does. The summary was typed into a chat in a browser this extension was not loaded in, so nothing redeemed the command and the handoff ended up connected to nothing at all. Nothing on the OS side can fix it: no argument names a window, and an extension cannot say which instance it is. But the capture request comes from chat A's own page, so the reply to it can hand that browser the successor to open — and a tab that browser creates is in A's window by construction, in a browser that has the extension by construction. */
describe('which browser opens the replacement chat', () => {
  const HOME = 'c0c0c0c0-1111-4222-8333-000000000b01';

  /** The real capture path: A's page files the ticket and then hands over its brief. */
  async function captureFrom(conversationId: string): Promise<Reply> {
    await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'user_message', time: Date.now(), text: 'build the site', messageId: `m-${conversationId}` }
        ]
      }
    });
    const filed = await request('POST', '/compact', { body: { conversationId } });
    const token = filed.body.token as string;
    expect(token, 'no continuation was opened, so there is no brief to capture').toBeTruthy();
    return request('POST', '/compact', {
      body: { conversationId, token, summary: `carry on

${SAMPLE_BRIEF}` }
    });
  }

  it('answers the capture with the chat to open instead of opening it through the OS', async () => {
    await pair();
    const stored = await captureFrom(HOME);

    expect(stored.body.stored).toBe(true);
    expect(stored.body.placement).toMatchObject({ id: stored.body.commandId, model: null, reasoningEffort: null, active: true });
    // The whole point: this app did not ask the operating system where its own chat should go.
    expect(opened).toEqual([]);
    expect(pendingCommands()).toEqual([
      { id: stored.body.commandId, what: expect.stringContaining('resume:'), lastError: null }
    ]);
  });

  it('spends the placement on the reply that carries it, so one handoff is one tab', async () => {
    await pair();
    const stored = await captureFrom(HOME);
    expect(stored.body.placement).not.toBeNull();

    // A's own feed is the recovery route for a capture reply that never reached the page. It must not hand out a second copy of an offer the page already has.
    const feed = await request('GET', `/activity?conversationId=${HOME}`);
    expect(feed.body.placement).toBeNull();
  });

  /** A resume with no page waiting to be told still opens the way it always did. The automatic pickup and restart recovery both queue a resume with nothing in flight from chat A — its tab may have been closed for an hour. Holding the OS opener back for those would trade a wrong window for no window at all. */
  it('opens through the OS when no page is asking for the handoff', async () => {
    await pair();
    const { sessionId, token } = await compactedSession(webProviderConversationId('deepseek', 'c0c0c0c0-1111-4222-8333-000000000b02'), 'carry on');
    const command = queueResume(sessionId, token)!;

    await waitForOpened(1);
    expect(opened).toEqual([commandUrl(command.id, 'deepseek')]);
  });

  /** Live 2.1.21, 2026-09-30: the extension ran in two browsers and chat A lived in one of them. Work owed to A was handed to both, and the browser without A answered it by opening A itself. With A in both, the copy in the other browser wrote the handoff, the replacement was placed beside that copy, and the user found chat B in the browser they were not working in. */
  describe('with the extension in two browsers', () => {
    const holder = 'e'.repeat(32), other = 'f'.repeat(32);
    const poll = async (browser: string, open: string[]) =>
      (await request('POST', '/status', { body: { openConversations: open }, browser })).body;

    it('offers a message for a chat only to the browser that holds that chat', async () => {
      await pair();
      const input = await import("../../../../backend/domains/sessions/input/input.js");
      input.resetInputForTests();
      await writeDurableNow('session-input', []);
      const home = randomUUID();
      const session = await createSession({ conversationId: home });
      try {
        await poll(holder, [home]);
        const { id } = await input.enqueueInput({ id: randomUUID(), sessionId: session.id, text: 'Next step', mode: 'auto',
          dueAt: Date.now(), model: null, reasoningEffort: null });
        const offered = (body: { inputs: Array<{ id: string }> }) => body.inputs.some(row => row.id === id);
        expect(offered(await poll(other, [])), 'the browser without the chat would open a second copy of it').toBe(false);
        expect(offered(await poll(holder, [home]))).toBe(true);
        // Closed in the holder, the chat is open nowhere: its opening stays with the first browser handed it, exactly like a new chat's.
        expect(offered(await poll(holder, []))).toBe(true);
        expect(offered(await poll(other, []))).toBe(false);
      } finally {
        input.resetInputForTests();
        await writeDurableNow('session-input', []);
      }
    });

    it('hands the Compact & Resume repair only to the browser that holds the source chat', async () => {
      await pair();
      const home = randomUUID();
      const session = await createSession({ conversationId: home });
      await poll(holder, [home]);
      await compactSession(session.id);
      const repairs = (body: { repairs: Array<{ conversationId: string }> }) => body.repairs.filter(row => row.conversationId === home);
      expect(repairs(await poll(other, [])), 'the browser without the chat would reopen it and run the handoff there').toEqual([]);
      expect(repairs(await poll(holder, [home]))).toMatchObject([{ reason: 'compaction', requiresClaim: true }]);
    });

    it('places a replacement nobody is waiting for beside its source chat, in that browser', async () => {
      await pair();
      const home = 'c0c0c0c0-1111-4222-8333-000000000b03';
      const { sessionId, token } = await compactedSession(home, 'carry on');
      await poll(holder, [home]);
      await poll(other, []);
      const command = queueResume(sessionId, token)!;
      await vi.waitFor(async () => expect((await readDurable<any>('bridge-commands'))?.commands?.[0]?.phase).toBe('leased'));
      expect(opened, 'the operating system picks a browser, not the one holding the chat').toEqual([]);
      expect((await poll(other, [])).placement).toBeNull();
      expect((await poll(holder, [home])).placement).toMatchObject({ id: command.id, homeConversationId: home, active: true });
    });
  });

  it('never issues a second open while the handed-out browser tab is still hydrating', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      const stored = await captureFrom(HOME);
      expect(stored.body.placement).not.toBeNull();
      expect(opened).toEqual([]);

      // No receipt yet is ambiguous: a slow provider page can already own a real tab.
      await vi.advanceTimersByTimeAsync(20_001);
      expect(opened).toEqual([]);
      expect((await request('GET', `/activity?conversationId=${HOME}`)).body.placement).toBeNull();
      expect((await redeem(stored.body.commandId)).type).toBe('resume');
    } finally {
      vi.useRealTimers();
    }
  });
});
