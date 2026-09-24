export const MAX_COMMAND_ALLOWLIST_RULES = 100;
export const MAX_COMMAND_ALLOWLIST_RULE_CHARS = 1000;

export type CommandAllowlistShell = 'zsh' | 'bash' | 'powershell' | 'sh' | 'cmd';
export type CommandPolicyMode = 'allow' | 'deny';

export interface CommandAllowlistSettings {
  enabled: boolean;
  mode: CommandPolicyMode;
  rules: string[];
}

export interface CommandAllowlistIssue {
  line: number;
  message: string;
}

export interface ParsedInvocation {
  args: string[];
  wildcard: boolean;
}

export type ParseMode = 'command' | 'rule';
export type ParseShell = CommandAllowlistShell | 'neutral';

export type CommandAllowlistDecision =
  | { allowed: true; args: string[][] }
  | { allowed: false; commandIndex: number; kind: 'unsupported' | 'unmatched' | 'denied' | 'invalid-policy'; detail: string };
