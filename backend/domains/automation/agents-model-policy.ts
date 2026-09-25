import { REASONING_EFFORTS, isReasoningEffort } from '../../../contracts/session.js';
import type { ReasoningEffort } from '../../../contracts/session.js';

interface AgentModelPolicyRuntime {
  agentError(message: string): Error;
}

const MAX_MODEL_CHARS = 80;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export function createAgentModelPolicy(runtime: AgentModelPolicyRuntime) {
  function normalizeModel(index: number, value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const model = value.trim();
    if (!model) return null;
    if (!isModelId(model)) {
      throw runtime.agentError(
        `Worker ${index + 1}'s model must be a provider model id using letters, digits, dot, underscore, colon, slash, or hyphen (limit ${MAX_MODEL_CHARS} characters)`
      );
    }
    return model;
  }

  function isModelId(value: unknown): value is string {
    return typeof value === 'string' && MODEL_ID_RE.test(value);
  }

  function normalizeReasoningEffort(index: number, value: string | null | undefined): ReasoningEffort | null {
    if (value === undefined || value === null) return null;
    const effort = value.trim().toLowerCase();
    if (!effort) return null;
    if (!isReasoningEffort(effort)) {
      throw runtime.agentError(
        `Worker ${index + 1}'s reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}`
      );
    }
    return effort;
  }

  return { normalizeModel, isModelId, normalizeReasoningEffort };
}
