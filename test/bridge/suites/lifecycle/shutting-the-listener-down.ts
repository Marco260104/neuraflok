import http from "node:http";
import { once } from "node:events";
import { BRIDGE_PROTOCOL } from "../../../../backend/infrastructure/settings/version.js";
import { bridgePort, bridgeState, describe, expect, EXTENSION_ORIGIN, it, pair, startBridge, stopBridge, vi } from "../../test-context.js";

describe("shutting the listener down", () => {
  it('drains a request that was still in flight instead of waiting out the force timeout', async () => {
      // Node hands `close()` the connections it already has and waits for them to end. A request that is *mid-flight* at that moment is not idle, so the one `closeIdleConnections()` sweep at stop time cannot see it — and once its response finishes the socket goes back to keep-alive idle, where nothing looks again. The extension polls constantly, so on a real quit that socket was almost always mid-request, and every quit sat for the full 15s force: long enough to look like the app has hung.
      await pair();
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const payload = Buffer.from(JSON.stringify({ conversationId: 'cafe0009-0000-4000-8000-000000000009', events: [] }), 'utf8');

      let req!: http.ClientRequest;
      const answered = new Promise<number>((resolve, reject) => {
        req = http.request(
          `${bridgeState.base}/events`,
          {
            method: 'POST',
            agent,
            headers: {
              origin: EXTENSION_ORIGIN,
              authorization: `Bearer ${bridgeState.token}`,
              expect: '100-continue',
              'content-type': 'application/json',
              'x-extension-protocol': String(BRIDGE_PROTOCOL),
              'content-length': String(payload.length)
            }
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
      });

      // HTTP 100 Continue proves the server accepted the request. Withhold the last byte ourselves; timer subtraction (150 - 50 ms) is not proof that shutdown drained it.
      const accepted = once(req, 'continue');
      req.write(payload.subarray(0, payload.length - 1));
      await accepted;
      const started = Date.now();
      let stopped = false;
      const stopping = stopBridge().then(() => { stopped = true; });
      try {
        await vi.waitFor(() => expect(bridgePort()).toBeNull());
        expect(stopped).toBe(false);
        req.end(payload.subarray(payload.length - 1));
        expect(await answered).toBe(200);
        await stopping;
        expect(Date.now() - started).toBeLessThan(3_000);
      } finally {
        agent.destroy();
      }

      const restarted = await startBridge();
      expect(restarted).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${restarted}`;
    });
});
