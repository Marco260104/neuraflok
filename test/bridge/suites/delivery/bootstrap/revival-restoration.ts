import { bridgePort, bridgeState, compactedSession, CONTINUATIONS_STATE, currentRunId, describe, expect, finishAgent, flushDurable, it, onSwarmPersistNow, opened, pair, pendingCommands, PRIME_CHAT, queueResume, readDurable, redeem, request, requestWorkerRevivals, resetBridgeForTests, resetSwarm, restoreCommands, restoreContinuations, restoreSwarm, REVIVAL_ACTIVITY_MS, REVIVAL_DEADLINE_MS, setBrowserOpener, spawn, stageMessages, startBridge, stopBridge, swarmState, swarmStateForCaller, vi, waitForOpened, waitForRevival, wake, writeDurableNow } from "../../../test-context.js";
import type { ContinuationSnapshot, SwarmSnapshot } from "../../../test-context.js";

describe("delivering a bootstrap: revival restoration", () => {
  async function prepareExpiredDocumentOwnedRevivalRestoreFixture(options: {
      workerConversation: string;
      resumeConversation: string;
      client: string;
    }): Promise<{
      revivalId: string;
      resumeId: string;
      continuationSnapshot: ContinuationSnapshot;
      durableSwarm: SwarmSnapshot;
    }> {
      await pair();
      spawn({ workers: [{ task: 'become the stale document-owned revival' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: options.workerConversation, agent: 'worker-1' }
      });
      finishAgent({ conversationId: options.workerConversation }, 'sleep before restore reconciliation');
      wake([{ to: 'worker-1', text: 'this browser-owned wake will expire before restart' }]);
      const { id: revivalId } = await waitForRevival();
      expect(opened).toHaveLength(1);
      const claimed = await request('POST', '/commands/redeem', {
        body: { id: revivalId, client: options.client, conversationId: options.workerConversation }
      });
      expect(claimed.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'waking',
        revivable: false
      });

      // Queue an unrelated valid command behind the document-owned revival. Its presence is what makes these tests about restore atomicity/publication rather than merely pruning one row.
      const resume = await compactedSession(options.resumeConversation, 'resume after restore reconciliation');
      const resumeCommand = queueResume(resume.sessionId, resume.token)!;
      await waitForOpened(2);
      await flushDurable();

      const continuationSnapshot = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
      const durableSwarm = await readDurable<SwarmSnapshot>('swarm');
      expect(continuationSnapshot).not.toBeNull();
      expect(durableSwarm).not.toBeNull();

      await stopBridge();
      await flushDurable();
      const durableCommands = await readDurable<any>('bridge-commands');
      const revival = durableCommands?.commands?.find((entry: any) => entry?.id === revivalId);
      const resumeRow = durableCommands?.commands?.find((entry: any) => entry?.id === resumeCommand.id);
      expect(revival).toMatchObject({ phase: 'leased', owner: options.client });
      expect(resumeRow).toBeTruthy();
      const expiredAt = Date.now() - 30 * 60_000 - 5_000;
      revival.createdAt = expiredAt;
      revival.claimedAt = expiredAt;
      await writeDurableNow('bridge-commands', durableCommands);

      resetBridgeForTests();
      opened.length = 0;
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await restoreContinuations(continuationSnapshot!);
      return {
        revivalId,
        resumeId: resumeCommand.id,
        continuationSnapshot: continuationSnapshot!,
        durableSwarm: durableSwarm!
      };
    }

  it('gives a delivered revival the silence budget of a working worker, and no more', async () => {
      vi.useFakeTimers();
      try {
        await pair();
        spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
        const bootstrap = await redeem();
        const conversationId = 'dfdfdfdf-7654-3210-fedc-ba9876543210';
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
        });
        finishAgent({ conversationId }, 'reported, waiting for more');
        wake([{ to: 'worker-1', text: 'prove that the model reacted' }]);
        const { id } = await waitForRevival();

        await vi.advanceTimersByTimeAsync(REVIVAL_DEADLINE_MS - 1_000);
        await request('POST', '/commands/redeem', {
          body: { id, client: 'delivered-without-liveness', conversationId }
        });
        const ack = await request('POST', '/commands/ack', {
          body: { id, status: 'sent', client: 'delivered-without-liveness', conversationId }
        });
        expect(ack.body).toMatchObject({ committed: true });
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

        // The text is in the chat; the model reading it is what the rest of the budget is for. 2026-09-01: three woken workers were still thinking when the old thirty seconds ran out, and were reported unwakeable while their chats were visibly working.
        await vi.advanceTimersByTimeAsync(REVIVAL_ACTIVITY_MS - REVIVAL_DEADLINE_MS - 1_000);
        await vi.runAllTicks();
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
        expect(pendingCommands().some((entry) => entry.id === id)).toBe(true);

        await vi.advanceTimersByTimeAsync(2_000);
        await vi.runAllTicks();
        const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
        expect(worker).toMatchObject({ state: 'sleeping', revivable: true, pending: 1 });
        expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);

        // The accepted user message stays offered; a later explicit wake injects only genuinely new prime work instead of duplicating text already present in the worker chat.
        wake([{ to: 'worker-1', text: 'genuinely new work after the silent wake' }]);
        const { id: nextId } = await waitForRevival();
        const next = await request('POST', '/commands/redeem', {
          body: { id: nextId, client: 'later-explicit-wake', conversationId }
        });
        expect(next.body.command.text).toContain('genuinely new work after the silent wake');
        expect(next.body.command.text).not.toContain('prove that the model reacted');
      } finally {
        vi.useRealTimers();
      }
    });

  it('reconciles an expired owner-null revival to sleeping without opening another browser', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'eeeeeeee-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'expire this readiness wait on restart' }]);
      await waitForRevival();
      await flushDurable();
      const durable = await readDurable<any>('bridge-commands');
      const revive = durable?.commands?.find((entry: any) => entry?.spec?.type === 'revive');
      expect(revive).toBeTruthy();
      const id = revive.id as string;
      revive.createdAt = Date.now() - REVIVAL_ACTIVITY_MS - 1;
      expect(revive.phase).toBe('queued');
      expect(revive.owner).toBeNull();
      await writeDurableNow('bridge-commands', durable);

      await stopBridge();
      resetBridgeForTests();
      opened.length = 0;
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      let brokerPersistenceCalls = 0;
      onSwarmPersistNow(async (snapshot) => {
        brokerPersistenceCalls++;
        await writeDurableNow('swarm', snapshot);
      });

      const restarted = await startBridge();
      expect(restarted).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${restarted}`;
      expect(brokerPersistenceCalls).toBe(1);
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping',
        revivable: true,
        pending: 1
      });
      expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);
      expect(opened).toEqual([]);
    });

  it('fails bridge startup atomically when expired document-owned revival cleanup cannot be persisted', async () => {
      const fixture = await prepareExpiredDocumentOwnedRevivalRestoreFixture({
        workerConversation: 'f1f1f1f1-7654-4210-8edc-ba9876543210',
        resumeConversation: 'f2f2f2f2-7654-4210-8edc-ba9876543210',
        client: 'stale-owned-revival-page'
      });

      let failOnce = true;
      onSwarmPersistNow(async (snapshot) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('synthetic expired-revival cleanup fsync failure');
        }
        await writeDurableNow('swarm', snapshot);
      });

      const failed = await startBridge();
      expect(failed).toBeNull();
      expect(bridgePort()).toBeNull();
      // The plan is strictly local until broker reconciliation crosses its durability barrier. In particular the valid resume beside the stale revival must not leak into live state.
      expect(pendingCommands()).toEqual([]);
      expect(opened).toEqual([]);
      const afterFailure = await readDurable<any>('bridge-commands');
      expect(afterFailure?.commands?.some((entry: any) => entry?.id === fixture.revivalId)).toBe(true);
      expect(afterFailure?.commands?.some((entry: any) => entry?.id === fixture.resumeId)).toBe(true);

      // Model the next process attempt from the still-authoritative durable broker snapshot. The same rows are therefore retryable rather than having been half-pruned by the failed start.
      onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
      resetSwarm();
      restoreSwarm(fixture.durableSwarm);
      resetBridgeForTests();
      opened.length = 0;
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await restoreContinuations(fixture.continuationSnapshot);
      const restarted = await startBridge();
      expect(restarted).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${restarted}`;
      expect(pendingCommands().some((entry) => entry.id === fixture.revivalId)).toBe(false);
      expect(pendingCommands().some((entry) => entry.id === fixture.resumeId)).toBe(true);
    });

  it('admits no command traffic while expired document-owned revival reconciliation is still pending', async () => {
      const fixture = await prepareExpiredDocumentOwnedRevivalRestoreFixture({
        workerConversation: 'f3f3f3f3-7654-4210-8edc-ba9876543210',
        resumeConversation: 'f4f4f4f4-7654-4210-8edc-ba9876543210',
        client: 'held-owned-revival-page'
      });

      let releasePersist!: () => void;
      let markPersistStarted!: () => void;
      const persistStarted = new Promise<void>((resolve) => {
        markPersistStarted = resolve;
      });
      const persistGate = new Promise<void>((resolve) => {
        releasePersist = resolve;
      });
      onSwarmPersistNow(async (snapshot) => {
        markPersistStarted();
        await persistGate;
        await writeDurableNow('swarm', snapshot);
      });

      const starting = startBridge();
      await persistStarted;
      try {
        // listen() has succeeded, but recovery has not published its local command plan. The socket is allowed to exist only behind the explicit admission fence.
        const recoveringPort = bridgePort();
        expect(recoveringPort).not.toBeNull();
        bridgeState.base = `http://127.0.0.1:${recoveringPort}`;
        expect(pendingCommands()).toEqual([]);
        expect(opened).toEqual([]);

        const duringRecovery = await request('POST', '/commands/redeem', {
          body: { id: fixture.resumeId, client: 'page-during-recovery' }
        });
        expect(duringRecovery.status).toBe(503);
        expect(duringRecovery.body).toMatchObject({ error: 'bridge_recovering', retryable: true });
        expect(pendingCommands()).toEqual([]);
        const durableWhileHeld = await readDurable<any>('bridge-commands');
        expect(durableWhileHeld?.commands?.some((entry: any) => entry?.id === fixture.revivalId)).toBe(true);
        expect(durableWhileHeld?.commands?.some((entry: any) => entry?.id === fixture.resumeId)).toBe(true);
      } finally {
        releasePersist();
      }

      const restarted = await starting;
      expect(restarted).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${restarted}`;
      expect(pendingCommands().some((entry) => entry.id === fixture.revivalId)).toBe(false);
      expect(pendingCommands().some((entry) => entry.id === fixture.resumeId)).toBe(true);
      const after = await readDurable<any>('bridge-commands');
      expect(after?.commands?.some((entry: any) => entry?.id === fixture.revivalId)).toBe(false);
      expect(after?.commands?.some((entry: any) => entry?.id === fixture.resumeId)).toBe(true);
      onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
    });

  it('does not let an older expired disk revival cancel a newer retained wake for the same worker', async () => {
      await pair();
      spawn({ workers: [{ task: 'survive a stale durable revival row' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'acacacac-1111-4222-8333-777777777777';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'sleep before the first wake');

      wake([{ to: 'worker-1', text: 'old wake whose transport will remain stale on disk' }]);
      const { id: oldId } = await waitForRevival();
      const oldRedeem = await request('POST', '/commands/redeem', {
        body: { id: oldId, client: 'old-revival-page', conversationId }
      });
      expect(oldRedeem.status).toBe(200);
      await flushDurable();
      const staleDisk = await readDurable<any>('bridge-commands');
      const staleRevive = staleDisk?.commands?.find((entry: any) => entry?.id === oldId);
      expect(staleRevive).toBeTruthy();

      // Semantically settle/remove R in live state. Then manufacture the exact safe-side disk failure shape: broker/live state has moved on, but the old bridge file still contains R.
      const failedOld = await request('POST', '/commands/ack', {
        body: { id: oldId, status: 'failed', error: 'synthetic old transport failure', client: 'old-revival-page' }
      });
      expect(failedOld.status).toBe(200);
      expect(swarmState().running).toBe(false);
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((entry) => entry.id === 'worker-1')?.state).toBe('sleeping');

      const fresh = stageMessages({ conversationId: PRIME_CHAT }, [
        { to: 'worker-1', text: 'new wake must outrank the stale disk transport' }
      ]);
      fresh.commit();
      expect(fresh.waking).toEqual(['worker-1']);
      expect(requestWorkerRevivals(fresh.waking)).toBe(1);
      await vi.waitFor(() => {
        const revive = pendingCommands().find((entry) => entry.what === `revive:${currentRunId()}:worker-1`);
        expect(revive).toBeTruthy();
        expect(revive!.id).not.toBe(oldId);
      });
      const newId = pendingCommands().find((entry) => entry.what === `revive:${currentRunId()}:worker-1`)!.id;
      expect(swarmState().agents.find((entry) => entry.id === 'worker-1')?.state).toBe('waking');

      // Keep only the old transport on disk and make it expired. writeDurableNow supersedes the fresh command's pending debounced snapshot, while the fresh command itself remains in memory exactly as a settings-driven stop/start would retain it.
      staleRevive.createdAt = Date.now() - 30 * 60_000 - 5_000;
      staleDisk.commands = [staleRevive];
      staleDisk.receipts = [];
      await writeDurableNow('bridge-commands', staleDisk);
      await stopBridge();

      const port = await startBridge();
      expect(port).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${port}`;
      const worker = swarmState().agents.find((entry) => entry.id === 'worker-1')!;
      expect(worker.state).toBe('waking');
      expect(pendingCommands().some((entry) => entry.id === newId)).toBe(true);
      expect(pendingCommands().some((entry) => entry.id === oldId)).toBe(false);
      const rewritten = await readDurable<any>('bridge-commands');
      expect(rewritten?.commands?.some((entry: any) => entry?.id === newId)).toBe(true);
      expect(rewritten?.commands?.some((entry: any) => entry?.id === oldId)).toBe(false);
    });

  it('selects the newest durable revival before applying expiry to duplicate same-worker rows', async () => {
      await pair();
      spawn({ workers: [{ task: 'survive duplicate durable revival rows' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'adadadad-1111-4222-8333-888888888888';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'sleep before duplicate-row wake');
      wake([{ to: 'worker-1', text: 'new durable wake must survive its stale duplicate' }]);
      await waitForRevival();
      await flushDurable();

      const durable = await readDurable<any>('bridge-commands');
      const newest = durable?.commands?.find((entry: any) => entry?.spec?.type === 'revive');
      expect(newest).toBeTruthy();
      const oldId = 'stale-duplicate-revival';
      const old = {
        ...newest,
        id: oldId,
        createdAt: Date.now() - 30 * 60_000 - 5_000,
        phase: 'queued',
        claimedAt: null,
        owner: null
      };
      durable.commands = [old, newest];
      await writeDurableNow('bridge-commands', durable);

      // Cold bridge-memory restart: unlike the retained-live regression above, authority now has to be selected entirely from the durable file. Expiry is a property of the selected transport incarnation, not of the friendly worker key shared by both rows.
      resetBridgeForTests();
      await restoreCommands();
      expect(swarmState().agents.find((entry) => entry.id === 'worker-1')?.state).toBe('waking');
      expect(pendingCommands().some((entry) => entry.id === newest.id)).toBe(true);
      expect(pendingCommands().some((entry) => entry.id === oldId)).toBe(false);
      const rewritten = await readDurable<any>('bridge-commands');
      expect(rewritten?.commands?.some((entry: any) => entry?.id === newest.id)).toBe(true);
      expect(rewritten?.commands?.some((entry: any) => entry?.id === oldId)).toBe(false);
    });

  it('refuses to believe a revival that reports a different chat, and undoes it', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'bacabaca-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'wake up' }]);
      const { id } = await waitForRevival();
      await request('POST', '/commands/redeem', { body: { id, client: 'tab-wandered' } });

      // The page redeemed before ChatGPT had finished routing it and typed somewhere else. Reporting the send is not proof of where it landed; the chat id is.
      const ack = await request('POST', '/commands/ack', {
        body: { id, status: 'sent', conversationId: 'ffffffff-1111-4222-8333-444444444444', client: 'tab-wandered' }
      });
      expect(ack.status).toBe(200);
      expect(ack.body).toMatchObject({ committed: false });
      expect(swarmState().running).toBe(false);
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('sleeping');
      expect(worker.conversationId).toBe(conversationId);
    });
});
