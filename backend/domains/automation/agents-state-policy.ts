import type { AgentInfo, AgentState } from '../../../contracts/session.js';
import type { Agent } from './agents-types.js';

export const WORKER_CONTEXT_CEILING_TOKENS = 400_000;

export function isOver(state: AgentState): boolean {
  return state === 'finished' || state === 'failed';
}

export function occupiesSlot(state: AgentState): boolean {
  return state === 'invited' || state === 'active' || state === 'detached' || state === 'waking';
}

export function ceilingCrossed(info: AgentInfo): boolean {
  return info.contextTokens >= WORKER_CONTEXT_CEILING_TOKENS;
}

export function hasStopped(state: AgentState): boolean {
  return isOver(state) || state === 'sleeping';
}

export function canStop(state: AgentState): boolean {
  return !hasStopped(state) && state !== 'waking';
}

export function canStageFinish(agent: Agent): boolean {
  return canStop(agent.info.state) || (
    agent.info.state === 'sleeping' &&
    !agent.info.revivable &&
    agent.info.silenceParked === true &&
    ceilingCrossed(agent.info)
  );
}
