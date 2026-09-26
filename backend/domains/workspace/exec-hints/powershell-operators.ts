import { isWindowsPowerShell5, type ShellType } from '../execution/shell.js';
import { hasUnsupportedShellLexemes, splitTopLevel } from '../exec-command-parser.js';
import type { NormalizedCommand } from './types.js';

/** Rewrites only small, top-level conditional chains that PowerShell 5.1 would reject outright. */
export function normalizePowerShellOperators(
  cmd: string,
  shellType: ShellType,
  shellPath: string
): NormalizedCommand {
  if (shellType !== 'powershell' || !isWindowsPowerShell5(shellPath)) return { cmd, notes: [] };
  if ((!cmd.includes('&&') && !cmd.includes('||')) || hasUnsupportedShellLexemes(cmd)) return { cmd, notes: [] };

  const operators: string[] = [];
  const operands = splitTopLevel(cmd, ['&&', '||'], operators);
  if (operators.length === 0 || operands.length !== operators.length + 1 || operands.length > 4) {
    return { cmd, notes: [] };
  }
  if (
    operands.some((operand) => {
      const value = operand.trim();
      return !value || value.includes('>') || value.includes('$?') || splitTopLevel(value, [';', '\n']).length !== 1;
    })
  ) {
    return { cmd, notes: [] };
  }

  const rewritten = operands
    .map((operand, index) => {
      if (index === 0) return operand.trim();
      const guard = operators[index - 1] === '&&' ? 'if ($?)' : 'if (-not $?)';
      return `${guard} { ${operand.trim()} }`;
    })
    .join('; ');
  return {
    cmd: rewritten,
    notes: ['Windows PowerShell 5.1 cannot parse && or ||, so this simple chain was rewritten as guards on `$?`.']
  };
}
