import type { ToolOutcome } from '../../../../contracts/session.js';
import type { CallEvidence } from '../../../infrastructure/tool-gateway/protocol/call-context.js';

export interface SummaryInput {
  tool: string;
  args: unknown;
  evidence: CallEvidence;
  outcome: ToolOutcome;
  durationMs: number;
  resultHead?: string;
}

