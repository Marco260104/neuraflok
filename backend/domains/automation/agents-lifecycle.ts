import { createAgentContextRecovery } from './agents-context-recovery.js';
import { createAgentConversationLifecycle } from './agents-lifecycle-conversations.js';
import { createAgentLiveness } from './agents-lifecycle-liveness.js';
import { createAgentPrimeTransfers } from './agents-lifecycle-transfers.js';
import type { AgentLifecycleRuntime } from './agents-lifecycle-types.js';

export type { AliveResult } from './agents-lifecycle-types.js';

export function createAgentLifecycle(runtime: AgentLifecycleRuntime) {
  return {
    ...createAgentContextRecovery(runtime),
    ...createAgentConversationLifecycle(runtime),
    ...createAgentLiveness(runtime),
    ...createAgentPrimeTransfers(runtime),
  };
}