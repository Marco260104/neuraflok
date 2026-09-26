import type { CallAttribution, ToolOutcome } from '../../../../contracts/session.js';
import type { CallEvidence } from '../../../infrastructure/tool-gateway/protocol/call-context.js';

export interface ToolContentPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallInput {
  nested?: boolean;
  tool: string;
  args: unknown;
  content: readonly ToolContentPart[];
  protocolResult?: unknown;
  outcome: ToolOutcome;
  durationMs: number;
  startedAt: number;
  evidence?: CallEvidence;
  agent?: string | null;
  bind?: string | null;
  requestId?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
  endsActivity?: boolean;
}

export interface ToolCallTarget {
  conversationId: string | null;
  sessionId: string | null;
  attribution: CallAttribution;
  turnId: string | null;
}
