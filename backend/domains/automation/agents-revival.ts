import type { AgentInfo, AgentMessage } from '../../../contracts/session.js';
import type { Agent, FinishResult, agentsRevivalRuntime } from './agents.js';
import { createAgentRevivalReceipts } from './agents-revival-receipts.js';

// Owns worker sleep and revival transitions.
type Runtime = typeof agentsRevivalRuntime;

// Browser wake data bound to one worker conversation and run incarnation.
export interface WorkerRevival {
  primeConversationId: string | null;
  id: string;
  conversationId: string;
  runId: string;
  text: string;
  messageIds: string[];
}

export function createAgentRevival(runtime: Runtime) {
  const {
    AgentError,
    MAX_INBOX_OFFER_CHARS,
    MAX_TASK_CHARS,
    PRIME_ID,
    WAKE_FAILURES_BEFORE_GIVING_UP,
    activeFinishStages,
    canStop,
    changed,
    ceilingCrossed,
    consecutiveWakeFailures,
    dormantRuns,
    failAgent,
    freeWorkerSlots,
    globalFreeWorkerSlots,
    logInfo,
    logWarn,
    newMessage,
    primeAgent,
    recount,
    runForAgent,
    runs,
    scopedRun,
    unpublishedMessages
  } = runtime;
  const receipts = createAgentRevivalReceipts(runtime);
  // Puts a worker to sleep on evidence that it stopped working, without ending it. The app-owned half of the lifecycle, and the reason a run can outlive any individual piece of work. Every caller here is an observation rather than a verdict — a settled final answer, a chat that went quiet with its tab gone, a durably quiescent turn — so none of them may throw anything away. The conversation, the transcript, the workspace and the unacknowledged queue all survive, because the next thing that happens to this worker is most likely the prime waking it up in that same chat. The context ceiling makes a proven stop final, and it is read here rather than enforced anywhere earlier: a worker that crossed it mid-task was never interrupted, it simply has no room left for another task once this one ends. Ambiguous silence with a durably open turn is parked before this helper, because silence alone does not prove that current task ended.
  function sleepAgent(agent: Agent, reason: string): FinishResult | null {
    const run = runForAgent(agent);
    if (!run || agent.info.role !== 'worker') return null;
    if (!canStop(agent.info.state)) return null;
    // A finish crossing its own durable acceptance barrier is the stronger, more specific statement about the same transition. Never publish two of them.
    if (activeFinishStages.has(agent)) return null;
    const terminal = ceilingCrossed(agent.info);
    const now = Date.now();
    agent.info.state = terminal ? 'finished' : 'sleeping';
    agent.info.sleptAt = now;
    agent.info.finishedAt = terminal ? now : null;
    agent.info.detachedAt = null;
    agent.info.revivable = !terminal;
    recount(agent);
    const report = newMessage(
      agent.info.id,
      PRIME_ID,
      terminal
        ? `[${agent.info.id} finished] ${reason} Its chat has also reached the context limit, so it cannot be woken ` +
          'again. Its worker slot is free; spawn a new worker if that work still matters.'
        : `[${agent.info.id} is sleeping] ${reason} Its worker slot is free and its chat is intact — wake it with ` +
          `agents action=message to="${agent.info.id}" when you have more for it, rather than spawning a new worker.`
    );
    const prime = primeAgent(run);
    prime.queue.push(report);
    recount(prime);
    logInfo(`multi-agent: ${agent.info.id} ${terminal ? 'finished for good' : 'is sleeping'} — ${reason}`);
    changed();
  return { info: { ...agent.info }, report: { ...report }, repeat: false };
}

/** Sleeps a worker by slot id. Used by sweeps that already know which row they proved quiet. */
function sleepWorker(id: string, reason: string, runId?: string): FinishResult | null {
  const run = scopedRun(runId);
  const agent = run?.agents.get(id);
  if (!agent) return null;
  return sleepAgent(agent, reason);
}


let reviveRequest: ((revivals: WorkerRevival[]) => void) | null = null;

// The bridge registers here, exactly as it does for spawn bootstraps. Registration replays whatever is already owed, for the same reason: a restart restores the run before the bridge exists, so a worker left mid-revival has nobody to ask for a tab.
function onReviveRequest(handler: (revivals: WorkerRevival[]) => void): () => void {
  reviveRequest = handler;
  const owed = pendingWorkerRevivals();
  if (owed.length > 0) {
    handler(owed);
    logInfo(`multi-agent: ${owed.length} worker chat(s) still owed a revival`);
  }
  return () => {
    if (reviveRequest === handler) reviveRequest = null;
  };
}

/** Workers whose slot is reserved and whose chat has not been typed into yet. */
function pendingWorkerRevivals(): WorkerRevival[] {
  const out: WorkerRevival[] = [];
  for (const run of runs.values()) for (const agent of run.agents.values()) {
    if (agent.info.state !== 'waking' || !agent.info.conversationId) continue;
    const plan = planRevivalText(agent);
    out.push({
      id: agent.info.id,
      conversationId: agent.info.conversationId,
      runId: run.runId,
      primeConversationId: run.primeConversationId,
      text: plan.text,
      messageIds: plan.messageIds
    });
  }
  return out;
}

// The user message the extension types into a woken worker's chat. The prime's own words, delivered the way a person would deliver them, because that is what they are: this app is not asking the worker to go and fetch something, it is handing it the instruction. The short parenthetical afterwards exists only because the worker's last turn ended with it being told to stop — without it, a well-behaved worker reads a new user turn and still believes it is finished.
function planRevivalText(agent: Agent): { text: string; messageIds: string[] } {
  const waiting: AgentMessage[] = [];
  let chars = 0;
  for (const message of agent.queue) {
    // A browser `sent` ACK proves the provider accepted this worker message, so revival must not send it again.
    if (message.ackedAt !== null || message.offeredViaRevival || unpublishedMessages.has(message)) continue;
    if (waiting.length > 0 && chars + message.text.length > MAX_INBOX_OFFER_CHARS) break;
    waiting.push(message);
    chars += message.text.length;
  }
  const body = waiting.map((message) => message.text).join('\n\n');
  const text =
    (body || 'The prime agent has more work for you; check your inbox on the next tool result.') +
    `\n\n(NEURAFLOK: you are still ${agent.info.id} in the same run, and this is the prime agent talking to ` +
    'you again in the chat you already know. Pick up from what you did here before rather than starting over. ' +
    'Report through the agents tool: action=message to="prime" as you go and action=finish when this piece is done.)';
  return { text, messageIds: waiting.map((message) => message.id) };
}

type WorkerAssignment = Pick<
  AgentInfo,
  'label' | 'task' | 'result' | 'silenceParked' | 'silenceRecoveryTurnId' | 'silenceRecoveryRequestOriginMax'
>;

// Reserves a slot for a sleeping worker and asks the browser to wake it, or refuses. Slot reservation is the whole reason this is a state transition rather than a side effect. Two messages to two sleeping workers arriving at once must not both see the same last free slot, so the transition into `waking` — which {@link occupiesSlot} counts — happens here, synchronously, before anything touches the browser.
function beginRevival(agent: Agent, label?: string): WorkerAssignment {
  const previous = {
    label: agent.info.label,
    task: agent.info.task,
    result: agent.info.result,
    silenceParked: agent.info.silenceParked,
    silenceRecoveryTurnId: agent.info.silenceRecoveryTurnId,
    silenceRecoveryRequestOriginMax: agent.info.silenceRecoveryRequestOriginMax
  };
  // The prime explicitly names new work; an omitted label preserves the existing name. An old report must not masquerade as the result of the waking assignment. Keep that report in the prime's existing inbox/history; status carries only a bounded task preview.
  if (label !== undefined) agent.info.label = label;
  agent.info.task = agent.queue
    .filter((message) => message.ackedAt === null && !message.offeredViaRevival)
    .map((message) => message.text).join('\n\n').slice(0, MAX_TASK_CHARS);
  agent.info.result = null;
  agent.info.state = 'waking';
  // `sleptAt` stays: the worker is still stopped while waking, and that timestamp is what tells a turn the page reports *now* apart from the page replaying the turn that ended before the sleep. It is cleared by the revival's own proof, in noteAgentAlive().
  agent.info.detachedAt = null;
  // True only for the pre-claim arbitration window. A proven tool call may still show that the old server-side turn never stopped and take the worker active; `/commands/redeem` flips this false durably before it returns any payload, after which the browser owns the wake instead.
  agent.info.revivable = true;
  // A prime-authorized new task supersedes the ambiguous old-turn parking authority. Rollback restores this field from `previous`; once the wake is accepted, only the normal wake proof may take the worker active.
  agent.info.silenceParked = false;
  agent.info.silenceRecoveryTurnId = null;
  agent.info.silenceRecoveryRequestOriginMax = null;
  agent.info.lastRevivalCommandId = null;
  logInfo(`multi-agent: ${agent.info.id} is being woken in conversation ${agent.info.conversationId}`);
  return previous;
}

// Reserves workers that have stopped with prime work which was never offered to them. A message sent while a worker is `detached` cannot safely be injected immediately: its server-side turn may still be running. Once that worker is later proved stopped, however, leaving the already-accepted message in a sleeping inbox strands it until the prime happens to send a *second* message. This stages the missing handoff from "stopped" to "waking". No browser side effect happens here. The caller must persist this critical revision, commit it, and only then call requestWorkerRevivals(). That keeps the same durable-before-publish boundary as an ordinary message-to-sleeping-worker revival.
function stageQueuedWorkerRevivals(ids: readonly string[], runId?: string): {
  waking: string[];
  commit: () => void;
  rollback: () => void;
} {
  const run = scopedRun(runId);
  if (!run || ids.length === 0) return { waking: [], commit: () => undefined, rollback: () => undefined };
  const wanted = new Set(ids);
  const reserved: Array<{ agent: Agent; sleptAt: number | null; assignment: WorkerAssignment }> = [];
  for (const agent of run.agents.values()) {
    if (
      agent.info.role !== 'worker' ||
      !wanted.has(agent.info.id) ||
      agent.info.state !== 'sleeping' ||
      !agent.info.revivable ||
      !agent.info.conversationId ||
      ceilingCrossed(agent.info)
    ) {
      continue;
    }
    const hasUnseen = agent.queue.some(
      (message) =>
        message.ackedAt === null &&
        message.offeredAt === null &&
        !unpublishedMessages.has(message)
    );
    if (!hasUnseen || freeWorkerSlots(run.runId) <= 0 || globalFreeWorkerSlots() <= 0) continue;
    const sleptAt = agent.info.sleptAt;
    const assignment = beginRevival(agent);
    reserved.push({ agent, sleptAt, assignment });
  }
  if (reserved.length === 0) return { waking: [], commit: () => undefined, rollback: () => undefined };
  changed();
  let settled = false;
  return {
    waking: reserved.map(({ agent }) => agent.info.id),
    commit: () => {
      if (settled) return;
      settled = true;
      changed('telemetry');
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      for (const { agent, sleptAt, assignment } of reserved) {
        if (agent.info.state !== 'waking') continue;
        Object.assign(agent.info, assignment);
        returnWakingWorkerToStopped(
          agent,
          sleptAt ?? Date.now(),
          'Its queued-work revival was rolled back before the browser could safely deliver it.'
        );
      }
      changed();
    }
  };
}

// Publishes revival bootstraps for workers that are still genuinely waking. The second half of the `message` transaction, mirroring {@link requestWorkerBootstraps}: the broker plans and reserves first, that revision is made durable, and only then is a browser asked to open anything. A retry after a failed disk barrier is safe because a worker that is already awake is skipped.
function requestWorkerRevivals(ids: readonly string[], runId?: string): number {
  const run = scopedRun(runId);
  if (!run || ids.length === 0) return 0;
  const wanted = new Set(ids);
  const owed = pendingWorkerRevivals().filter((revival) => revival.runId === run.runId && wanted.has(revival.id));
  if (owed.length === 0) return 0;
  if (reviveRequest) reviveRequest(owed);
  else logWarn('multi-agent: no browser extension is paired, so sleeping worker chats cannot be reopened');
  return owed.length;
}

// Permanently closes a worker that is already stopped and is now known to be at the context ceiling. This can happen after it was first reported sleeping, or while a wake transaction is being rolled back. Messages never offered to the worker cannot ever be consumed once this state is terminal. Remove those rows and tell the prime exactly what became undeliverable rather than leaving a finished worker with a permanently nonzero inbox. Already-offered rows stay for the existing lost-result retry semantics: they may genuinely have reached the worker.
function finishStoppedWorkerAtCeiling(agent: Agent, reason: string, sleptAt = Date.now()): AgentMessage {
  const now = Date.now();
  const neverOffered = agent.queue.filter(
    (message) => message.ackedAt === null && message.offeredAt === null && !unpublishedMessages.has(message)
  );
  if (neverOffered.length > 0) {
    const doomed = new Set(neverOffered);
    agent.queue = agent.queue.filter((message) => !doomed.has(message));
  }

  agent.info.state = 'finished';
  agent.info.sleptAt = sleptAt;
  agent.info.finishedAt = now;
  agent.info.detachedAt = null;
  agent.info.revivable = false;
  agent.info.silenceParked = false;
  agent.info.silenceRecoveryTurnId = null;
  agent.info.silenceRecoveryRequestOriginMax = null;
  recount(agent);

  const missed =
    neverOffered.length > 0
      ? ` ${neverOffered.length} queued message${neverOffered.length === 1 ? '' : 's'} could not be delivered before that limit` +
        ` (${neverOffered
          .slice(0, 3)
          .map((message) => `“${message.text.slice(0, 180)}”`)
          .join(', ')}${neverOffered.length > 3 ? ', …' : ''}). Those instructions are no longer queued.`
      : '';
  const report = newMessage(
    agent.info.id,
    PRIME_ID,
    `[${agent.info.id} finished for good] ${reason} Its chat has reached the context limit, so it cannot be woken again.` +
      `${missed} Its worker slot is free; spawn a new worker for any remaining work.`
  );
  const prime = primeForOwnedAgent(agent);
  if (!prime) throw new AgentError(`Cannot find the prime that owns ${agent.info.id}.`);
  prime.queue.push(report);
  recount(prime);
  return report;
}

/** Finds the prime row that owns this exact Agent object, active or dormant. */
function primeForOwnedAgent(agent: Agent): Agent | null {
  const run = runForAgent(agent);
  if (run && [...run.agents.values()].includes(agent)) return run.agents.get(PRIME_ID) ?? null;
  for (const dormant of dormantRuns.values()) {
    if ([...dormant.agents.values()].includes(agent)) return dormant.agents.get(PRIME_ID) ?? null;
  }
  return null;
}

/** Returns a failed/rolled-back wake to the only stopped state its current context permits. */
function returnWakingWorkerToStopped(agent: Agent, sleptAt: number, reason: string): AgentMessage | null {
  if (ceilingCrossed(agent.info)) return finishStoppedWorkerAtCeiling(agent, reason, sleptAt);
  agent.info.state = 'sleeping';
  agent.info.sleptAt = sleptAt;
  agent.info.finishedAt = null;
  agent.info.detachedAt = null;
  agent.info.revivable = true;
  recount(agent);
  return null;
}


// The browser could not wake this worker, so the slot it was holding goes back. Deliberately not a failure of the worker. Nothing was typed into its chat, its queue is untouched and still unacknowledged, and the chat itself is exactly as reusable as it was a moment ago — so it returns to `sleeping` and the prime can try again. The prime is told, because it is holding a message it believes was delivered.
function failWorkerRevival(id: string, why: string, runId?: string): AgentMessage | null {
  const run = scopedRun(runId);
  const agent = run?.agents.get(id);
  if (!agent || agent.info.state !== 'waking') return null;
  const chat = agent.info.conversationId ?? id;
  const strikes = (consecutiveWakeFailures.get(chat) ?? 0) + 1;
  consecutiveWakeFailures.set(chat, strikes);
  if (strikes >= WAKE_FAILURES_BEFORE_GIVING_UP && !ceilingCrossed(agent.info)) {
    // The second failed wake with nothing heard from the chat in between is the verdict on the chat, not on the browser. On 2026-09-03 worker-7's provider conversation answered every load with "This content is unavailable"; four wakes each waited out their deadline and each told the prime "try once more", which it did — thirty minutes and four prime turns before it spawned the replacement it could have spawned after the first repeat. A revivable failure keeps its inbox: the chat calling again brings it back as usual.
    const failed = failAgent(
      id,
      `its chat did not answer ${strikes} revivals in a row (${why})`,
      `[${id} failed] Its chat did not answer ${strikes} revivals in a row: ${why} Treat it as gone — do not try to ` +
        'wake it again. Do that part of the work yourself or spawn a replacement worker. Should its chat ever call ' +
        'in again, you will be told it is back.',
      { revivable: true }, run?.runId
    );
    if (failed) {
      consecutiveWakeFailures.delete(chat);
      return failed.report;
    }
  }
  const terminal = returnWakingWorkerToStopped(
    agent,
    Date.now(),
    `The browser could not complete its revival: ${why}`
  );
  if (terminal) {
    consecutiveWakeFailures.delete(chat);
    logWarn(`multi-agent: could not wake ${id}; the chat crossed its context ceiling while revival was in flight`);
    changed();
    return terminal;
  }
  const report = newMessage(
    id,
    PRIME_ID,
    `[${id} could not be woken] ${why} It is still asleep and still holds everything it knew. Any revival text the assistant ` +
      'accepted remains offered but was not proven read, so it will not be injected twice. Its slot is free again: try agents action=message to="' +
      id +
      '" once more, or do that work another way.'
  );
  const prime = primeAgent(run);
  prime.queue.push(report);
  recount(prime);
  logWarn(`multi-agent: could not wake ${id} — ${why}`);
  changed();
  return report;
}

  return {
    beginRevival,
    failWorkerRevival,
    finishStoppedWorkerAtCeiling,
    onReviveRequest,
    pendingWorkerRevivals,
    primeForOwnedAgent,
    requestWorkerRevivals,
    returnWakingWorkerToStopped,
    sleepAgent,
    sleepWorker,
    stageQueuedWorkerRevivals,
    ...receipts,
    reset: () => { reviveRequest = null; }
  };
}
