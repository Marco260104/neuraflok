import { apiConversationId } from '../../../contracts/chat-protocol.js';
import { webProviderConversationId } from '../../../contracts/web-providers.js';
import { originTitle, type SessionOrigin } from '../../../contracts/session.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { configuredApiEndpoint } from '../providers/api-settings.js';
import { sendDesktopInput, onLocalExecutorTurnSettled } from '../sessions/input/start-input.js';
import { listInputs, onLocalExecutorInputAccepted, type InputArgs, type InputEntry } from '../sessions/input/input.js';
import { createSession, findSessionByConversation, getSession, observeSessionModel, readCompletedFinal } from '../sessions/history/store.js';
import { recordAgentMessage } from '../sessions/history/recorder.js';
import {
  agentConversation,
  agentInfoForOwnedConversation,
  bindConversation,
  failAgent,
  failWorkerRevival,
  setLocalAgentDeliveryActive,
  onReviveRequest,
  onSpawnRequest,
  releaseQuiescentRun,
  requestWorkerRevivals,
  sleepWorker,
  stageQueuedWorkerRevivals,
  stageWorkerConversationFinish,
  swarmState,
  type WorkerSpawn
} from './agents.js';
import { workerBootstrapText } from '../../../contracts/worker-brief.js';
import { createLocalAgentRevivalDelivery } from './local-agent-delivery-revivals.js';
import { persistAgentChange, recordAgentDeliveryReport } from './local-agent-delivery-reports.js';
import { deterministicDeliveryUuid, routeForConversation, workerInput } from './local-agent-delivery-primitives.js';

let deliveryQueue = Promise.resolve();
let stopped = false;
let activeDisposer: (() => Promise<void>) | null = null;
const revivalDelivery = createLocalAgentRevivalDelivery();

function schedule(work: () => Promise<void>): void {
  deliveryQueue = deliveryQueue.then(work).catch(error => {
    logWarn(`multi-agent: local delivery failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function parentSessionFor(conversationId: string | null) {
  if (!conversationId) throw new Error('The owning conversation could not be proven.');
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (!summary) throw new Error('The owning conversation has no durable local session.');
  const session = await getSession(summary.id);
  if (!session || session.conversationId !== conversationId) throw new Error('The owning session changed before worker delivery.');
  return session;
}

async function workerSession(
  conversationId: string,
  parentSessionId: string,
  agentId: string,
  task: string
) {
  const origin: SessionOrigin = { kind: 'worker', fromSessionId: parentSessionId, agentId, task };
  const previous = await findSessionByConversation(conversationId, { requireUnique: true });
  if (previous) {
    const session = await getSession(previous.id);
    if (!session || session.conversationId !== conversationId || session.origin?.kind !== 'worker' ||
        session.origin.agentId !== agentId || session.origin.fromSessionId !== parentSessionId || session.origin.task !== task) {
      throw new Error('The deterministic worker conversation is already owned by another session.');
    }
    return session;
  }
  return createSession({ conversationId, origin, title: originTitle(origin, null), titleSource: 'fallback' });
}

async function prepareApiModel(
  sessionId: string,
  conversationId: string,
  parent: Awaited<ReturnType<typeof parentSessionFor>>,
  model: string | null,
  reasoningEffort: InputArgs['reasoningEffort']
): Promise<void> {
  const selected = parent.selectedModel?.conversationId === parent.conversationId ? parent.selectedModel : null;
  const chosenModel = model ?? selected?.model ?? getConfig().goal.model;
  if (!chosenModel) return;
  await observeSessionModel(sessionId, conversationId, chosenModel, Date.now(),
    reasoningEffort ?? selected?.reasoningEffort, selected?.apiProvider ?? configuredApiEndpoint());
}

async function failSpawn(worker: WorkerSpawn, error: unknown): Promise<void> {
  const reason = `Local worker delivery failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 400)}`;
  const result = failAgent(worker.id, reason, undefined, { revivable: true }, worker.runId);
  if (result?.report) await recordAgentDeliveryReport(result.report, agentConversation(worker.id, worker.runId));
}

async function deliverSpawn(worker: WorkerSpawn): Promise<void> {
  if (stopped || !getConfig().multiAgent.enabled) return;
  const current = swarmState(worker.runId).agents.find(agent => agent.id === worker.id && agent.role === 'worker');
  if (!current || current.state !== 'invited') return;
  try {
    const parent = await parentSessionFor(worker.primeConversationId);
    const route = routeForConversation(parent.conversationId!);
    const conversationId = agentConversation(worker.id, worker.runId) ?? (
      route.executor === 'api'
        ? apiConversationId(deterministicDeliveryUuid(`conversation:${worker.runId}:${worker.id}`))
        : webProviderConversationId(route.executor, deterministicDeliveryUuid(`conversation:${worker.runId}:${worker.id}`))
    );
    if (routeForConversation(conversationId).executor !== route.executor) {
      throw new Error('The bound worker chat does not match its prime provider.');
    }
    const session = await workerSession(conversationId, parent.id, worker.id, worker.task);
    if (route.executor === 'api') {
      await prepareApiModel(session.id, conversationId, parent, worker.model, worker.reasoningEffort);
    }
    if (!bindConversation(worker.id, conversationId, worker.runId)) {
      throw new Error('The worker conversation could not be bound to its exact broker slot.');
    }
    if (!(await persistAgentChange())) throw new Error('The worker binding could not be saved before local execution.');
    const input = workerInput(
      deterministicDeliveryUuid(`bootstrap:${worker.runId}:${worker.id}`),
      session.id,
      workerBootstrapText(worker.id, worker.task),
      route,
      worker.model,
      worker.reasoningEffort
    );
    const entry = await sendDesktopInput(input);
    if (entry.state === 'failed' || entry.state === 'cancelled') {
      throw new Error(entry.error || 'The initial worker message was not accepted.');
    }
    logInfo(`multi-agent: ${worker.id} started through the local ${route.executor} executor`);
  } catch (error) {
    await failSpawn(worker, error);
    logWarn(`multi-agent: could not start ${worker.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function wakeQueuedStoppedWorker(agentId: string, runId: string): Promise<void> {
  const staged = stageQueuedWorkerRevivals([agentId], runId);
  if (staged.waking.length === 0) return;
  if (!(await persistAgentChange())) {
    staged.rollback();
    return;
  }
  staged.commit();
  requestWorkerRevivals(staged.waking, runId);
}

async function settleLocalTurn(result: {
  entry: Readonly<InputEntry>;
  conversationId: string | null;
  turnId: string | null;
  aborted: boolean;
  error: Error | null;
}): Promise<void> {
  const { conversationId, entry, turnId } = result;
  if (stopped || !conversationId || !entry.sessionId) return;
  const worker = agentInfoForOwnedConversation(conversationId);
  if (!worker || worker.role !== 'worker' || !worker.runId) return;
  if (result.error || !turnId) {
    if (result.aborted) {
      const report = sleepWorker(worker.id, 'its local provider turn was stopped by the user', worker.runId)?.report;
      await recordAgentDeliveryReport(report ?? null, conversationId);
      return;
    }
    const reason = `The local provider turn did not complete: ${result.error?.message ?? 'no final turn receipt was recorded'}`;
    if (worker.state === 'waking') {
      await recordAgentDeliveryReport(failWorkerRevival(worker.id, reason, worker.runId), conversationId);
    } else {
      const failed = failAgent(worker.id, reason, undefined, { revivable: true }, worker.runId);
      await recordAgentDeliveryReport(failed?.report ?? null, conversationId);
    }
    return;
  }
  const final = await readCompletedFinal(entry.sessionId, conversationId, turnId);
  if (!final) return;
  const staged = stageWorkerConversationFinish(conversationId, final.text || 'Worker completed its assigned task.');
  if (!staged?.report) return;
  if (!(await persistAgentChange())) {
    staged.rollback();
    return;
  }
  staged.commit();
  await recordAgentMessage(staged.report, 'sent', conversationId);
  if (staged.info.runId) {
    await wakeQueuedStoppedWorker(worker.id, staged.info.runId);
    releaseQuiescentRun({}, staged.info.runId);
  }
}

async function recoverBoundWorkers(): Promise<void> {
  if (!getConfig().multiAgent.enabled) return;
  const inputs = await listInputs();
  for (const worker of swarmState().agents) {
    if (stopped || worker.role !== 'worker' || worker.state !== 'active' || !worker.conversationId || !worker.runId) continue;
    const inputId = deterministicDeliveryUuid(`bootstrap:${worker.runId}:${worker.id}`);
    const previous = inputs.find(entry => entry.id === inputId);
    if (previous?.state === 'sent') {
      const session = previous.sessionId ? await getSession(previous.sessionId).catch(() => null) : null;
      const completed = session?.conversationId === worker.conversationId && !session.activeTurnId && session.lastTurnOutcome === 'completed'
        ? await readCompletedFinal(session.id, worker.conversationId).catch(() => null) : null;
      if (completed) {
        await settleLocalTurn({ entry: previous, conversationId: worker.conversationId, turnId: completed.turnId, aborted: false, error: null });
      } else {
        const failed = failAgent(worker.id, 'The app restarted after the initial worker input was accepted; the uncertain send was not repeated.', undefined,
          { revivable: true }, worker.runId);
        await recordAgentDeliveryReport(failed?.report ?? null, worker.conversationId);
      }
      continue;
    }
    if (previous && previous.state !== 'queued') continue;
    const sessionSummary = await findSessionByConversation(worker.conversationId, { requireUnique: true });
    const session = sessionSummary ? await getSession(sessionSummary.id) : null;
    if (!session || session.origin?.kind !== 'worker' || session.origin.agentId !== worker.id) continue;
    const route = routeForConversation(worker.conversationId);
    const input = workerInput(inputId, session.id, workerBootstrapText(worker.id, worker.task), route, worker.model, worker.reasoningEffort);
    try {
      await sendDesktopInput(input);
    } catch (error) {
      const failed = failAgent(worker.id, `Local worker recovery failed: ${(error as Error).message}`,
        undefined, { revivable: true }, worker.runId);
      await recordAgentDeliveryReport(failed?.report ?? null, worker.conversationId);
    }
  }
}

export function startLocalAgentDelivery(): () => Promise<void> {
  if (activeDisposer) return activeDisposer;
  stopped = false;
  setLocalAgentDeliveryActive(true);
  const dropAcceptance = onLocalExecutorInputAccepted(revivalDelivery.acceptRevivalReceipt);
  const dropSettled = onLocalExecutorTurnSettled(result => settleLocalTurn(result));
  schedule(recoverBoundWorkers);
  const dropSpawn = onSpawnRequest(workers => schedule(async () => {
    for (const worker of workers) await deliverSpawn(worker);
  }));
  const dropRevival = onReviveRequest(revivals => schedule(async () => {
    for (const revival of revivals) {
      if (stopped) return;
      await revivalDelivery.deliverRevival(revival);
    }
  }));
  const dispose = async () => {
    if (activeDisposer !== dispose) return;
    stopped = true;
    setLocalAgentDeliveryActive(false);
    activeDisposer = null;
    dropAcceptance();
    dropSettled();
    dropSpawn();
    dropRevival();
    revivalDelivery.clearPendingReceipts();
    await deliveryQueue.catch(() => undefined);
  };
  activeDisposer = dispose;
  return dispose;
}

export async function stopLocalAgentDelivery(): Promise<void> {
  await activeDisposer?.();
}
