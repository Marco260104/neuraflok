import { webProviderConversationId } from "../../../../contracts/web-providers.js";
import { describe, expect, getSession, it, pair, recoveryBrowserWake, request, resetBridgeForTests, resetRecorderForTests, sessionControlsFor } from "../../test-context.js";

describe("app requests to stop one exact active turn", () => {
  it('does not present a persisted unfinished turn as live after recorder restart', async () => {
      const { sessionControlsFor } = await import("../../../../backend/domains/browser/bridge.js");
      const sessionId = await active('e5555555-aaaa-4bbb-8ccc-111111111111');
      expect((await sessionControlsFor(sessionId)).activeTurnId).toBe('stop-turn-one');
      resetRecorderForTests();
      resetBridgeForTests(); // A process restart clears the live activity owner too.
      expect((await getSession(sessionId))?.activeTurnId).toBe('stop-turn-one');
      expect((await sessionControlsFor(sessionId)).activeTurnId).toBeNull();
    });

  async function active(conversationId: string, turnId = 'stop-turn-one') {
      await pair();
      const result = await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'turn_start', time: Date.now(), turnId }
      ] } });
      expect(result.status).toBe(200);
      return result.body.sessionId as string;
    }

  it('refuses Stop for provider-page activity without a live local executor', async () => {
      const { stopSessionTurn } = await import("../../../../backend/domains/browser/bridge.js");
      const conversationId = webProviderConversationId('deepseek', 'e6666666-aaaa-4bbb-8ccc-111111111111');
      const sessionId = await active(conversationId);
      expect((await sessionControlsFor(sessionId)).activeTurnId).toBeNull();
      await expect(stopSessionTurn(sessionId, 'stop-turn-one')).rejects.toThrow('active_turn_changed');
      expect((await request('GET', '/status')).body.stopTurns).toEqual([]);
      expect(recoveryBrowserWake).not.toHaveBeenCalled();
    });
});
