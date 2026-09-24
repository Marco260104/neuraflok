import { MAX_COMMAND_ALLOWLIST_RULE_CHARS, MAX_COMMAND_ALLOWLIST_RULES } from './types.js';
import type { CommandAllowlistIssue, ParsedInvocation } from './types.js';
import { parseInvocation } from './invocation-parser.js';

export function validateCommandAllowlistRule(rule: string): string | null {
  if (rule.length > MAX_COMMAND_ALLOWLIST_RULE_CHARS) {
    return `Rule is longer than ${MAX_COMMAND_ALLOWLIST_RULE_CHARS} characters.`;
  }
  try {
    parseInvocation(rule.trim(), 'neutral', 'rule');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid rule.';
  }
}

export function parseCommandAllowlistText(text: string): { rules: string[]; issues: CommandAllowlistIssue[] } {
  const rules: string[] = [];
  const issues: CommandAllowlistIssue[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const rule = raw.trim();
    if (!rule) continue;
    if (rules.length >= MAX_COMMAND_ALLOWLIST_RULES) {
      issues.push({ line: index + 1, message: `At most ${MAX_COMMAND_ALLOWLIST_RULES} rules are allowed.` });
      continue;
    }
    const message = validateCommandAllowlistRule(rule);
    if (message) issues.push({ line: index + 1, message });
    else rules.push(rule);
  }
  return { rules, issues };
}

export function matchesCommandRule(rule: ParsedInvocation, args: readonly string[]): boolean {
  if (rule.wildcard ? args.length < rule.args.length : args.length !== rule.args.length) return false;
  return rule.args.every((argument, index) => argument === args[index]);
}
