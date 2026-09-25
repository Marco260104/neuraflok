import type { BridgeCommand, Command, CommandSpec } from './model.js';
import type { SessionOrigin } from '../../../../contracts/session.js';
import { continuationByToken } from '../../sessions/continuity/continuation.js';
import { findSessionByConversation } from '../../sessions/history/store.js';
import { pendingWorkerRevivals, primeConversation, swarmRunning } from '../../automation/agents.js';
import { resumeBootstrapText } from '../../sessions/continuity/handoff.js';
import { workerBootstrapText } from '../../../../contracts/worker-brief.js';

export interface BridgeCommandProjectionRuntime {
  commandDeadlineDelay(command: Command): number;
  getCommands(): Command[];
}

export function createBridgeCommandProjection(runtime: BridgeCommandProjectionRuntime) {
  function revivalFor(agent: string, runId: string) {
    return pendingWorkerRevivals().find(revival => revival.id === agent && revival.runId === runId) ?? null;
  }

  function commandHomeConversation(spec: CommandSpec): string | null {
    if (spec.type === 'stop') return spec.conversationId;
    if (spec.type === 'resume') return continuationByToken(spec.token)?.from ?? null;
    if (spec.type === 'revive') return null;
    return primeConversation(spec.runId);
  }

  function bootstrapText(spec: CommandSpec, summary: string): string {
    if (spec.type === 'stop') return '';
    if (spec.type === 'revive') return revivalFor(spec.agent, spec.runId)?.text ?? '';
    if (spec.type === 'worker') return workerBootstrapText(spec.agent, spec.task);
    return resumeBootstrapText(summary, spec.token);
  }

  function describe(command: Command, client: string | null, claimedSummary?: string): BridgeCommand {
    const spec = command.spec;
    const selection = spec.type === 'resume' ? continuationByToken(spec.token)?.requestedModel : null;
    const expiresAt = Date.now() + Math.max(1, runtime.commandDeadlineDelay(command));
    if (spec.type === 'stop') return {
      id: command.id,
      expiresAt,
      kind: 'stop-turn',
      type: 'stop',
      text: '',
      agent: null,
      model: null,
      reasoningEffort: null,
      conversationId: spec.conversationId,
      turnId: spec.turnId,
      ...(spec.userMessageId ? { userMessageId: spec.userMessageId } : {})
    };
    const text = spec.type === 'resume'
      ? client && claimedSummary !== undefined ? bootstrapText(spec, claimedSummary) : ''
      : bootstrapText(spec, '');
    return {
      id: command.id,
      expiresAt,
      kind: 'open-chat',
      type: spec.type,
      text,
      agent: spec.type === 'resume' ? null : spec.agent,
      model: spec.type === 'worker' ? spec.model : selection?.model ?? null,
      reasoningEffort: spec.type === 'worker' ? spec.reasoningEffort : selection?.reasoningEffort ?? null,
      conversationId: spec.type === 'revive' ? spec.conversationId : null
    };
  }

  async function commandOrigin(id: string): Promise<SessionOrigin | null> {
    const spec = runtime.getCommands().find(entry => entry.id === id)?.spec;
    if (!spec || spec.type === 'stop') return null;
    if (spec.type === 'worker') {
      const prime = swarmRunning(spec.runId) ? primeConversation(spec.runId) : null;
      return {
        kind: 'worker',
        fromSessionId: prime ? (await findSessionByConversation(prime, { requireUnique: true }))?.id ?? null : null,
        agentId: spec.agent,
        task: spec.task
      };
    }
    if (spec.type === 'revive') return null;
    return { kind: 'resume', fromSessionId: spec.sessionId, agentId: null, task: '' };
  }

  return { bootstrapText, commandHomeConversation, commandOrigin, describe, revivalFor };
}
