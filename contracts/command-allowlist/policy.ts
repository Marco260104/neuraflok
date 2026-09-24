import type { CommandAllowlistDecision, CommandAllowlistSettings, CommandAllowlistShell, ParsedInvocation } from './types.js';
import { parseInvocation } from './invocation-parser.js';
import { matchesCommandRule, validateCommandAllowlistRule } from './rules.js';

export function evaluateCommandAllowlist(
  policy: CommandAllowlistSettings,
  commands: readonly string[],
  shell: CommandAllowlistShell
): CommandAllowlistDecision {
  if (!policy.enabled) return { allowed: true, args: [] };
  if (policy.mode !== 'allow' && policy.mode !== 'deny') {
    return { allowed: false, commandIndex: 0, kind: 'invalid-policy', detail: 'Saved command policy mode is invalid.' };
  }

  const rules: ParsedInvocation[] = [];
  for (const [index, rule] of policy.rules.entries()) {
    const message = validateCommandAllowlistRule(rule);
    if (message) {
      return { allowed: false, commandIndex: 0, kind: 'invalid-policy', detail: `Saved rule ${index + 1} is invalid: ${message}` };
    }
    rules.push(parseInvocation(rule.trim(), 'neutral', 'rule'));
  }

  const parsed: string[][] = [];
  for (const [index, command] of commands.entries()) {
    let invocation: ParsedInvocation;
    try {
      invocation = parseInvocation(command, shell, 'command');
    } catch (error) {
      return { allowed: false, commandIndex: index, kind: 'unsupported', detail: error instanceof Error ? error.message : 'Unsupported shell syntax.' };
    }
    parsed.push(invocation.args);
    const matchedRule = rules.findIndex(rule => matchesCommandRule(rule, invocation.args));
    if (policy.mode === 'allow' && matchedRule === -1) {
      return { allowed: false, commandIndex: index, kind: 'unmatched', detail: 'No allowlist rule matched the executable and complete argument list.' };
    }
    if (policy.mode === 'deny' && matchedRule !== -1) {
      return { allowed: false, commandIndex: index, kind: 'denied', detail: `Denylist rule ${matchedRule + 1} matched the executable and complete argument list.` };
    }
  }
  return { allowed: true, args: parsed };
}

export function commandHasSameArguments(expected: readonly string[], command: string, shell: CommandAllowlistShell): boolean {
  try {
    const parsed = parseInvocation(command, shell, 'command').args;
    return parsed.length === expected.length && parsed.every((argument, index) => argument === expected[index]);
  } catch {
    return false;
  }
}
