import { once } from "node:events";
import { WebSocket } from "ws";
import { bridgeState, describe, expect, EXTENSION_ORIGIN, it, pair, request, revealChatInBrowser, vi } from "../../test-context.js";

describe("opening a chat in the browser that runs the extension (#882)", () => {
  const CHAT = 'abcdabcd-1111-4222-8333-444444444444';

  const BROWSER_A = 'aaaaaaaaaaaaaaaa1111';

  const BROWSER_B = 'bbbbbbbbbbbbbbbb2222';

  const connect = async () => {
      const socket = new WebSocket(bridgeState.base.replace('http:', 'ws:') + '/wake', { origin: EXTENSION_ORIGIN });
      await once(socket, 'open');
      const authenticated = once(socket, 'message'); socket.send(bridgeState.token!); await authenticated;
      return socket;
    };

  const close = async (socket: WebSocket) => { const closed = once(socket, 'close'); socket.close(); await closed; };

  const poll = async (browser: string, openConversations: string[] = [], canReveal = true) =>
      (await request('POST', '/status', { browser, body: { openConversations, ...(canReveal ? { canReveal } : {}) } })).body;

  it('leaves the chat to the OS when no extension is connected', async () => {
      await pair();
      await poll(BROWSER_A);
      await expect(revealChatInBrowser(CHAT)).resolves.toBe(false);
    });

  it('leaves the chat to the OS when the connected extension cannot show chats yet', async () => {
      await pair();
      const socket = await connect();
      try {
        const older = await poll(BROWSER_A, [], false);
        expect(older.reveals).toBeUndefined();
        await expect(revealChatInBrowser(CHAT)).resolves.toBe(false);
      } finally { await close(socket); }
    });

  it('hands the chat to the extension once and resolves when it is taken', async () => {
      await pair();
      const socket = await connect();
      try {
        await poll(BROWSER_A);
        const woken = once(socket, 'message');
        const shown = revealChatInBrowser(CHAT);
        expect(String((await woken)[0])).toBe('wake');
        expect((await poll(BROWSER_A)).reveals).toEqual([CHAT]);
        await expect(shown).resolves.toBe(true);
        expect((await poll(BROWSER_A)).reveals).toEqual([]);
      } finally { await close(socket); }
    });

  it('goes to the browser that already has the chat open', async () => {
      await pair();
      const socket = await connect();
      try {
        await poll(BROWSER_A);
        await poll(BROWSER_B, [CHAT]);
        const shown = revealChatInBrowser(CHAT);
        expect((await poll(BROWSER_A)).reveals).toEqual([]);
        expect((await poll(BROWSER_B, [CHAT])).reveals).toEqual([CHAT]);
        await expect(shown).resolves.toBe(true);
      } finally { await close(socket); }
    });

  it('falls back to the OS when no browser takes the chat in time', async () => {
      await pair();
      const socket = await connect();
      try {
        await poll(BROWSER_A);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const shown = revealChatInBrowser(CHAT);
        await vi.advanceTimersByTimeAsync(4_000);
        await expect(shown).resolves.toBe(false);
        vi.useRealTimers();
        // Withdrawn, so a late poll cannot open the chat a second time beside the OS's copy.
        expect((await poll(BROWSER_A)).reveals).toEqual([]);
      } finally { vi.useRealTimers(); await close(socket); }
    });
});
