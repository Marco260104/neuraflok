import { bindConversation, createSession, describe, expect, findSessionByConversation, finishAgent, flushDurable, it, opened, pair, pendingCommands, redeem, request, requestWorkerRevivals, resetBridgeForTests, restoreCommands, restoreSwarm, setBrowserOpener, snapshotSwarm, spawn, stageMessages, swarmStateForCaller } from "../../test-context.js";

describe("independent prime browser transports", () => {
  const primeA = 'abababab-1111-4111-8111-111111111111';

  const primeB = 'bcbcbcbc-2222-4222-8222-222222222222';

  const workerA = 'cacacaca-3333-4333-8333-333333333333';

  const workerB = 'dbdbdbdb-4444-4444-8444-444444444444';

  it('keeps same-named bootstrap commands separate and clearing A preserves B and its parentage', async () => {
      const { clearAgent } = await import("../../../../backend/domains/automation/agents.js");
      await pair();
      const parentB = await createSession({ title: 'Independent Prime B', conversationId: primeB });
      const a = spawn({ caller: { conversationId: primeA }, workers: [{ task: 'A isolated task' }] });
      const b = spawn({ caller: { conversationId: primeB }, workers: [{ task: 'B isolated task' }] });
      const commandA = pendingCommands().find(c => c.what === `worker:${a.runId}:worker-1`)!;
      const commandB = pendingCommands().find(c => c.what === `worker:${b.runId}:worker-1`)!;
      expect(commandA.id).not.toBe(commandB.id);
      clearAgent('prime', a.runId);
      expect(pendingCommands().map(c => c.id)).toEqual([commandB.id]);
      const stale = await request('POST', '/commands/redeem', { body: { id: commandA.id, client: 'old-A' } });
      expect(stale.status).not.toBe(200);
      const offeredB = await redeem(commandB.id, 'owned-B');
      expect(offeredB.text).toContain('B isolated task');
      expect(offeredB.text).not.toContain('A isolated task');
      const ack = await request('POST', '/commands/ack', { body: { id: commandB.id, client: 'owned-B', status: 'sent', conversationId: workerB } });
      expect(ack.status).toBe(200);
      expect(ack.body.committed).toBe(true);
      expect(swarmStateForCaller({ conversationId: primeB }).agents.find(row => row.id === 'worker-1')?.conversationId).toBe(workerB);
      await request('POST', '/events', { body: { conversationId: workerB, events: [
        { kind: 'user_message', time: Date.now(), messageId: 'parallel-worker-b-task', text: 'B isolated task' }
      ] } });
      const child = await findSessionByConversation(workerB, { requireUnique: true });
      expect(child?.origin?.fromSessionId).toBe(parentB.id);
    });

  it('isolates concurrent revival payloads and failing A cannot stop B', async () => {
      await pair();
      const a = spawn({ caller: { conversationId: primeA }, workers: [{ task: 'A first piece' }] });
      const b = spawn({ caller: { conversationId: primeB }, workers: [{ task: 'B first piece' }] });
      bindConversation('worker-1', workerA, a.runId);
      bindConversation('worker-1', workerB, b.runId);
      await request('GET', '/status');
      finishAgent({ conversationId: workerA }, 'A done');
      finishAgent({ conversationId: workerB }, 'B done');
      for (const [conversationId, runId, text] of [[primeA, a.runId, 'A confidential instruction'], [primeB, b.runId, 'B separate instruction']] as const) {
        const stage = stageMessages({ conversationId }, [{ to: 'worker-1', text }]);
        stage.commit();
        requestWorkerRevivals(stage.waking, runId);
      }
      const cmdA = pendingCommands().find(c => c.what === `revive:${a.runId}:worker-1`)!;
      const cmdB = pendingCommands().find(c => c.what === `revive:${b.runId}:worker-1`)!;
      expect(cmdA.id).not.toBe(cmdB.id);
      const wrong = await request('POST', '/commands/redeem', { body: { id: cmdA.id, client: 'A-page', conversationId: workerB } });
      expect(wrong.status).not.toBe(200);
      const offeredA = await request('POST', '/commands/redeem', { body: { id: cmdA.id, client: 'A-page', conversationId: workerA } });
      expect(offeredA.status).toBe(200);
      expect(offeredA.body.command.text).toContain('A confidential instruction');
      expect(offeredA.body.command.text).not.toContain('B separate instruction');
      const failed = await request('POST', '/commands/ack', { body: { id: cmdA.id, client: 'A-page', conversationId: workerA, status: 'failed', error: 'A browser refused' } });
      expect(failed.status).toBe(200);
      expect(swarmStateForCaller({ conversationId: primeA }).agents.find(row => row.id === 'worker-1')?.state).toBe('sleeping');
      expect(swarmStateForCaller({ conversationId: primeB }).agents.find(row => row.id === 'worker-1')?.state).toBe('waking');
      const offeredB = await request('POST', '/commands/redeem', { body: { id: cmdB.id, client: 'B-page', conversationId: workerB } });
      expect(offeredB.status).toBe(200);
      expect(offeredB.body.command.text).toContain('B separate instruction');
      expect(offeredB.body.command.text).not.toContain('A confidential instruction');
    });

  it('restores both outstanding commands against their independently restored incarnations', async () => {
      await pair();
      const a = spawn({ caller: { conversationId: primeA }, workers: [{ task: 'durable queued A' }] });
      const b = spawn({ caller: { conversationId: primeB }, workers: [{ task: 'durable queued B' }] });
      await flushDurable();
      const commandIds = pendingCommands().map(c => c.id);
      const saved = JSON.parse(JSON.stringify(snapshotSwarm()));
      resetBridgeForTests();
      setBrowserOpener(async url => { opened.push(url); });
      // Restore starts before bridge registration in production, so no replay callback can create a replacement command before the separately durable transport is restored.
      const { onSpawnRequest } = await import("../../../../backend/domains/automation/agents.js");
      const stopReplay = onSpawnRequest(() => undefined);
      restoreSwarm(saved);
      stopReplay();
      await restoreCommands();
      expect(pendingCommands().map(c => c.id).sort()).toEqual(commandIds.sort());
      expect(pendingCommands().map(c => c.what).sort()).toEqual([`worker:${a.runId}:worker-1`, `worker:${b.runId}:worker-1`].sort());
    });
});
