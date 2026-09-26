import type { ReasoningEffort } from '../../../../contracts/session.js';
import type { Config } from '../../../../contracts/types.js';
import type { BridgeCommand, Command, CommandSpec } from './model.js';

export interface BridgeCommandAdmissionRuntime {
  MAX_COMMANDS: number;
  armDeadline(command: Command, delay?: number): void;
  askForTheTabToWakeIn(command: Command, lifecycle: number): Promise<void>;
  automaticCompactionAllowed: typeof import('../../sessions/history/store.js').automaticCompactionAllowed;
  bridgeLifecycleEpoch(): number;
  changed(): void;
  createCommandId(): string;
  deliver(): void | Promise<void>;
  describe(command: Command, client: string | null, claimedSummary?: string): BridgeCommand;
  drop(command: Command, why: string): boolean;
  getCommands(): Command[];
  getConfig(): Config;
  logInfo: typeof import('../../../infrastructure/settings/logger.js').logInfo;
  logWarn: typeof import('../../../infrastructure/settings/logger.js').logWarn;
  persistCommands(): void;
  rememberToken(sessionId: string, token: string): void;
  replaceCommands(commands: Command[]): void;
  revivalDeliveryProven(command: Command): boolean;
  swarmRunning: typeof import('../../automation/agents.js').swarmRunning;
  tidyCommands(): void;
}

export function specKey(spec: CommandSpec): string {
  if (spec.type === 'stop') return `stop:${spec.sessionId}:${spec.turnId}`;
  if (spec.type === 'worker') return `worker:${spec.runId}:${spec.agent}`;
  if (spec.type === 'revive') return `revive:${spec.runId}:${spec.agent}`;
  return `resume:${spec.sessionId}`;
}

export function createBridgeCommandAdmission(runtime: BridgeCommandAdmissionRuntime) {
  const {
    MAX_COMMANDS,
    armDeadline,
    askForTheTabToWakeIn,
    automaticCompactionAllowed,
    bridgeLifecycleEpoch,
    changed,
    createCommandId,
    deliver,
    describe,
    drop,
    getCommands,
    getConfig,
    logInfo,
    logWarn,
    persistCommands,
    rememberToken,
    replaceCommands,
    revivalDeliveryProven,
    swarmRunning,
    tidyCommands
  } = runtime;

  function queue(spec: CommandSpec): Command {
    const commandRows = getCommands();
    const key = specKey(spec);
    const existing = commandRows.find((command) => specKey(command.spec) === key);
    if (existing) {
      // The same bootstrap arriving twice — a restart re-requesting a worker whose chat was never bound, or the user pressing Compact & Resume again — is one job, not two tabs.
      const superseded = JSON.stringify(existing.spec) !== JSON.stringify(spec);
      if (superseded) {
        // Only a genuinely different bootstrap restarts the clock and takes the lease back. An identical repeat must leave the claim alone: releasing it would let the deliver() that follows open a second tab for a chat that is already opening, which is precisely the storm of duplicate chats this queue exists to prevent.
        existing.createdAt = Date.now();
        existing.claimedAt = null;
        // Any page that redeemed the previous payload no longer owns the replacement. Current pages echo their document client on ACK, so a late result from that old payload is refused by /commands/ack rather than applied to this newer one.
        existing.owner = null;
        if (existing.timer) clearTimeout(existing.timer);
        existing.timer = null;
        // A newer handoff for the same chat replaces the older one in place. The queued job stays one job — what changes is which handoff the fresh chat will be told to resume — and its deadline starts again from this delivery, because this is new work.
        existing.spec = spec;
        existing.lastError = null;
      }
      changed();
      persistCommands();
      return existing;
    }
    const command: Command = {
      id: createCommandId(),
      spec,
      createdAt: Date.now(),
      claimedAt: null,
      timer: null,
      lastError: null,
      owner: null
    };
    commandRows.push(command);
    if (commandRows.length > MAX_COMMANDS) {
      // Through drop(), never a raw shift. A queued command is not just a row in an array: a worker command owns an `invited` agent slot that only ever ends when something ends it, and a resume command owns a job the page is sitting there waiting on. Shifting one out left both behind — the worker counted towards the limit and held the single in-flight agent bootstrap so nothing after it could open, and the resume job stayed `busy` with no command left to finish it, which disables Compact & resume until the app restarts. Overflow is rare, which is exactly why it must not be the one path that skips the cleanup.
      const oldest = commandRows[0];
      if (oldest) drop(oldest, 'the command queue was full and this was the oldest entry in it');
    }
    changed();
    persistCommands();
    return command;
  }

  function contextView(autoAllowed = true): {
    auto: boolean;
    threshold: number;
    warn: number;
    limit: number;
  } {
    const config = getConfig();
    return {
      auto: autoAllowed && automaticCompactionAllowed(),
      threshold: config.compaction.autoTokens,
      warn: config.sessions.advisoryTokens,
      limit: config.sessions.limitTokens
    };
  }

  // Queues the bootstrap for a worker chat. Called by the broker through onSpawnRequest. Nothing about identity is passed in or stored: the chat this opens is bound to the slot by the extension's report, and the recovery key exists only if the user asks the app for one after that has failed.
  function queueWorkerBootstrap(agent: string, task: string, model: string | null, reasoningEffort: ReasoningEffort | null, runId: string): BridgeCommand | null {
    // A worker bootstrap is authority for one concrete broker incarnation. There is no safe meaning for one outside a run, and manufacturing an unscoped command here is exactly how stale durable work later becomes somebody else's `worker-1`.
    if (!runId || !swarmRunning(runId)) return null;
    const command = queue({ type: 'worker', agent, task, model, reasoningEffort, runId });
    // Start the clock at broker admission, exactly as a revival does. A bootstrap that never reaches a page is the case that has no other clock at all.
    armDeadline(command);
    deliver();
    return describe(command, null);
  }

  // Queues the reopening of a sleeping worker's own chat. Called by the broker through onReviveRequest, and carrying nothing the broker did not already prove: the slot is reserved (`waking`) and the conversation is the one bound to it. The prime's words are deliberately not copied in here — they are read out of that worker's inbox when the page asks for them, so a revival that waits in the queue hands over what is true at hand-out time rather than a stale snapshot.
  function queueWorkerRevival(
    agent: string,
    conversationId: string,
    wake: readonly string[],
    runId: string
  ): BridgeCommand | null {
    // Same rule as a bootstrap: authority for one concrete broker incarnation, or nothing.
    if (!runId || !conversationId || !swarmRunning(runId)) return null;
    // An empty wake is not a wake. The broker republishes its whole `waking` list on every restart and on any staging that touches it, and a worker whose words the browser has already typed plans nothing further — its own call is what ends the wake, not another send. Superseding the command it is already living under would restart the one absolute deadline it has and open its tab a second time to type nothing.
    const carried = getCommands().find((entry) => entry.spec.type === 'revive' && entry.spec.agent === agent && entry.spec.runId === runId);
    if (wake.length === 0 && carried) return describe(carried, null);
    const command = queue({
      type: 'revive',
      agent,
      conversationId,
      runId,
      wake: wake.join(' ')
    });
    // Start the waking clock at broker admission, not only after a browser accepts the command.
    armDeadline(command);
    void askForTheTabToWakeIn(command, bridgeLifecycleEpoch()).catch(error => {
      logWarn(`bridge: could not inspect the tab for worker wake ${command.id}: ${String(error)}`);
    });
    return describe(command, null);
  }

  // Queues the replacement chat for a continuation whose brief has been captured. Keyed by session, and carrying the transaction's token rather than any text: the token is the single-use authority for this move, so the command cannot become a second way of claiming a continuation, and a second command for the same session folds into this one.
  function queueResume(sessionId: string, token: string): BridgeCommand | null {
    const command = queueResumeCommand(sessionId, token);
    void deliver();
    return describe(command, null);
  }

  function queueResumeCommand(sessionId: string, token: string): Command {
    rememberToken(sessionId, token);
    const command = queue({ type: 'resume', sessionId, token });
    changed();
    return command;
  }

  // Most wakes handed to the browser in one reply; more than any one run can wake at once.
  const MAX_REVIVALS_PER_REPLY = 16;

  // Process eligible existing-chat wakes oldest first without letting one unclaimed wake block the queue.
  function pendingBrowserRevivals(): Array<{ id: string; conversationId: string }> {
    tidyCommands();
    const waiting: Array<{ id: string; conversationId: string }> = [];
    for (const entry of getCommands()) {
      if (waiting.length >= MAX_REVIVALS_PER_REPLY) break;
      if (entry.spec.type === 'revive' && entry.owner === null && !revivalDeliveryProven(entry))
        waiting.push({ id: entry.id, conversationId: entry.spec.conversationId });
    }
    return waiting;
  }

  // The oldest of them, for an extension older than 2.1.27 that reads one `revival`.
  function pendingBrowserRevival(): { id: string; conversationId: string } | null {
    return pendingBrowserRevivals()[0] ?? null;
  }

  // Withdraws queued worker chats, immediately. Cancellation has to reach the browser in the same beat as the app: the queue is emptied here, and the next /commands poll tells the extension which ids are still alive so a tab it is already holding a bootstrap for is dropped rather than opened. With `agent`, only that worker's bootstrap is withdrawn. Clearing one slot must not take the queued tabs of its siblings with it — the whole-run form is what `onSwarmEnd` uses, and pointing it at a single agent is what makes a per-worker clear safe.
  function cancelWorkerCommands(reason: string, agent?: string, runId?: string): number {
    const commands = getCommands();
    const doomed = commands.filter(
      (command) =>
        (command.spec.type === 'worker' || command.spec.type === 'revive') &&
        (agent === undefined || command.spec.agent === agent) &&
        (runId === undefined || command.spec.runId === runId)
    );
    if (doomed.length === 0) return 0;
    const dead = new Set(doomed.map((command) => command.id));
    replaceCommands(commands.filter((command) => !dead.has(command.id)));
    const what = agent === undefined ? 'worker chat(s)' : `worker chat(s) for ${agent}`;
    logInfo(`bridge: cancelled ${doomed.length} queued ${what} — ${reason}`);
    changed();
    persistCommands();
    // No deliver() here on purpose. drop() reaches this path from inside a delivery and documents that its callers are already in one; the next poll picks up whatever was queued behind the cancelled command.
    return doomed.length;
  }

  // What the UI shows about work waiting on the browser.
  function pendingCommands(): Array<{
    id: string;
    what: string;
    lastError: string | null;
  }> {
    return getCommands().map((command) => ({
      id: command.id,
      what: specKey(command.spec),
      lastError: command.lastError
    }));
  }

  return {
    cancelWorkerCommands,
    contextView,
    pendingBrowserRevival,
    pendingBrowserRevivals,
    pendingCommands,
    queue,
    queueResume,
    queueResumeCommand,
    queueWorkerBootstrap,
    queueWorkerRevival
  };
}
