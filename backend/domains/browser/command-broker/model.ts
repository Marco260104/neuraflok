import type { ReasoningEffort } from '../../../../contracts/session.js';

export const COMMAND_STEPS = [
  'revival-waiting',
  'revival-busy',
  'revival-draft',
  'revival-editor',
  'composer',
  'model',
  'composer-after-model',
  'inserting',
  'sending'
] as const;

export type CommandStep = typeof COMMAND_STEPS[number];

export type CommandSpec =
  | {
      type: 'worker';
      agent: string;
      task: string;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
      runId: string;
    }
  | {
      type: 'revive';
      agent: string;
      conversationId: string;
      runId: string;
      wake: string;
    }
  | { type: 'resume'; sessionId: string; token: string }
  | { type: 'stop'; sessionId: string; conversationId: string; turnId: string; userMessageId?: string };

export interface Command {
  id: string;
  spec: CommandSpec;
  createdAt: number;
  claimedAt: number | null;
  placement?: { conversationId: string | null; background: boolean };
  timer: NodeJS.Timeout | null;
  lastError: string | null;
  owner: string | null;
  progress?: { opened?: 'browser' | 'os'; step?: CommandStep; stepAt?: number };
}

type CommandReceiptOutcome = 'committed' | 'terminal-failure';

export interface CommandReceipt {
  id: string;
  client: string | null;
  conversationId: string | null;
  outcome: CommandReceiptOutcome;
  committed: boolean;
  error: string | null;
  completedAt: number;
}

export interface BridgeCommand {
  id: string;
  expiresAt: number;
  kind: 'open-chat' | 'stop-turn';
  turnId?: string;
  userMessageId?: string;
  type: CommandSpec['type'];
  text: string;
  agent: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  conversationId: string | null;
}

export type AckStatus = 'sent' | 'failed';
