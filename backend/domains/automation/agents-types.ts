import type { AgentInfo, AgentMessage, ReasoningEffort, SwarmState } from '../../../contracts/session.js';

export const PRIME_ID = 'prime';

export interface Agent {
  info: AgentInfo;
  queue: AgentMessage[];
}

interface PrimeTransfer {
  from: string;
  at: number;
  frozen: boolean;
}

export interface Run {
  runId: string;
  formerRunIds?: string[];
  primeConversationId: string | null;
  primeRequestId?: string;
  startedAt: number;
  agents: Map<string, Agent>;
  transfer: PrimeTransfer | null;
  primeGoneAt: number | null;
}

export interface DormantRun {
  formerRunIds?: string[];
  primeConversationId: string | null;
  primeRequestId?: string;
  startedAt: number;
  parkedAt: number;
  agents: Map<string, Agent>;
  transfer: PrimeTransfer | null;
}

export interface SpawnStageState {
  run: Run;
  created: Agent[];
  becamePrime: boolean;
  resumedDormant: DormantRun | null;
  createdFreshRun: boolean;
  settled: boolean;
}

export interface FinishStageState {
  run: Run;
  agent: Agent;
  info: AgentInfo;
  report: AgentMessage;
  acknowledgedMessageIds: string[];
  settled: boolean;
}

export interface RetiredChat {
  id: string;
  conversationId: string;
  reason: string;
  retiredAt: number;
}

export interface WorkerSpawn {
  runId: string;
  primeConversationId: string | null;
  id: string;
  task: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

export interface CallerSwarmStatus {
  self: AgentInfo | null;
  state: SwarmState;
  runId: string | null;
  freeWorkerSlots: number;
}

export interface ClearResult {
  cleared: 'run' | 'worker' | 'none';
  report: AgentMessage | null;
  reason: string;
}
