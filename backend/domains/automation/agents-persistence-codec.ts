import { isReasoningEffort, type AgentInfo, type AgentMessage } from '../../../contracts/session.js';
import type { Agent, FinishStageState } from './agents-types.js';

export interface SerializedAgent {
  info: AgentInfo;
  queue: AgentMessage[];
}

export interface AgentPersistenceCodecRuntime {
  PRIME_ID: string;
  activeFinishStages: ReadonlyMap<Agent, FinishStageState>;
  isProviderModelId(value: unknown): value is string;
  logWarn(message: string): void;
  recount(agent: Agent): void;
  unpublishedAgents: WeakSet<Agent>;
  unpublishedMessages: WeakSet<AgentMessage>;
}

export function serializeAgents(
  agents: Map<string, Agent>,
  includeUnpublished: boolean,
  runtime: AgentPersistenceCodecRuntime
): SerializedAgent[] {
  const stagedFinishes = includeUnpublished
    ? [...runtime.activeFinishStages.values()].filter((stage) => !stage.settled && stage.run.agents === agents)
    : [];
  return [...agents.values()]
    .filter((agent) => includeUnpublished || !runtime.unpublishedAgents.has(agent))
    .map((agent) => {
      const finish = includeUnpublished ? runtime.activeFinishStages.get(agent) : undefined;
      const info =
        finish && !finish.settled && finish.run.agents === agents
          ? {
              ...agent.info,
              state: finish.info.state,
              finishedAt: finish.info.finishedAt,
              sleptAt: finish.info.sleptAt,
              result: finish.info.result,
              revivable: finish.info.revivable,
              silenceParked: finish.info.silenceParked,
              silenceRecoveryTurnId: finish.info.silenceRecoveryTurnId,
              silenceRecoveryRequestOriginMax: finish.info.silenceRecoveryRequestOriginMax
            }
          : { ...agent.info };
      const finishAcknowledged =
        includeUnpublished && finish && !finish.settled && finish.run.agents === agents
          ? new Set(finish.acknowledgedMessageIds)
          : null;
      if (finishAcknowledged && finishAcknowledged.size > 0) {
        const newlyDelivered = agent.queue.filter(
          (message) => message.ackedAt === null && finishAcknowledged.has(message.id)
        ).length;
        info.delivered += newlyDelivered;
      }
      const queue = agent.queue
        .filter(
          (message) =>
            message.ackedAt === null &&
            (!finishAcknowledged || !finishAcknowledged.has(message.id)) &&
            (includeUnpublished || !runtime.unpublishedMessages.has(message))
        )
        .map((message) => ({ ...message }));
      if (finishAcknowledged) {
        info.pending = queue.length;
        info.awaitingAck = queue.filter((message) => message.offeredAt !== null).length;
      }
      if (includeUnpublished && agent.info.id === runtime.PRIME_ID) {
        queue.push(...stagedFinishes.map((stage) => ({ ...stage.report })));
      }
      return { info, queue };
    });
}

export function deserializeAgents(
  entries: readonly SerializedAgent[],
  savedAt: number,
  runtime: Pick<AgentPersistenceCodecRuntime, 'isProviderModelId' | 'logWarn' | 'recount'>
): { agents: Map<string, Agent>; repaired: boolean } {
  const agents = new Map<string, Agent>();
  let repaired = false;
  for (const entry of entries) {
    if (!entry?.info?.id || agents.has(entry.info.id)) {
      repaired = true;
      continue;
    }
    const agent: Agent = {
      info: {
        ...entry.info,
        model: runtime.isProviderModelId(entry.info.model) ? entry.info.model : null,
        reasoningEffort: isReasoningEffort(entry.info.reasoningEffort) ? entry.info.reasoningEffort : null,
        sleptAt: typeof entry.info.sleptAt === 'number' ? entry.info.sleptAt : null,
        contextTokens: Number.isFinite(entry.info.contextTokens) ? entry.info.contextTokens : 0,
        lastRevivalCommandId:
          typeof entry.info.lastRevivalCommandId === 'string' && entry.info.lastRevivalCommandId
            ? entry.info.lastRevivalCommandId
            : null,
        silenceRecoveryTurnId:
          typeof entry.info.silenceRecoveryTurnId === 'string' && entry.info.silenceRecoveryTurnId
            ? entry.info.silenceRecoveryTurnId
            : null,
        silenceRecoveryRequestOriginMax:
          typeof entry.info.silenceRecoveryRequestOriginMax === 'number' &&
          Number.isFinite(entry.info.silenceRecoveryRequestOriginMax)
            ? entry.info.silenceRecoveryRequestOriginMax
            : null,
        silenceParked: entry.info.silenceParked === true
      },
      queue: (Array.isArray(entry.queue) ? entry.queue : []).map((message) => ({
        ...message,
        offeredAt:
          message.offeredViaRevival === true && typeof message.offeredAt === 'number' && Number.isFinite(message.offeredAt)
            ? message.offeredAt
            : null,
        offeredOnFinish: message.offeredOnFinish ?? false,
        offeredViaRevival: message.offeredViaRevival === true
      }))
    };
    if (agent.info.role === 'worker') {
      if (agent.info.state === 'invited' && agent.info.conversationId) {
        agent.info.state = 'active';
        agent.info.activatedAt ??= savedAt || Date.now();
        agent.info.revivable = false;
        repaired = true;
        runtime.logWarn(`multi-agent: repaired restored ${agent.info.id} from bound/invited to active`);
      }
      if (agent.info.state === 'finished' && agent.info.revivable) {
        agent.info.revivable = false;
        repaired = true;
      }
      if (agent.info.state === 'waking' && !agent.info.conversationId) {
        agent.info.state = 'sleeping';
        agent.info.sleptAt ??= savedAt || Date.now();
        agent.info.revivable = false;
        repaired = true;
        runtime.logWarn(`multi-agent: restored ${agent.info.id} out of waking; it has no chat to be woken in`);
      }
      if (
        agent.info.state === 'sleeping' &&
        ((!agent.info.revivable && !agent.info.silenceParked) || !agent.info.conversationId)
      ) {
        agent.info.state = 'finished';
        agent.info.finishedAt ??= agent.info.sleptAt ?? (savedAt || Date.now());
        agent.info.revivable = false;
        repaired = true;
      }
    }
    runtime.recount(agent);
    agents.set(entry.info.id, agent);
  }
  return { agents, repaired };
}
