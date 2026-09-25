import type { ShellType } from '../execution/shell.js';
import { hasUnsupportedShellLexemes, tokenize } from '../exec-command-parser.js';
import { quoteArgument } from './powershell-globs.js';
import { rebuild } from './text-rebuild.js';

export function bindBundledRipgrep(command: string, shellType: ShellType, executable: string | null): string {
  if (shellType === 'cmd' || !executable || hasUnsupportedShellLexemes(command)) return command;
  let changed = false;
  const bound = rebuild(command, [';', '&&', '||', '\n'], (statement) =>
    rebuild(statement, ['|'], (segment) => {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment);
      if (!match) return segment;
      const lead = match[1] ?? '';
      const body = match[2] ?? '';
      const trail = match[3] ?? '';
      const first = tokenize(body)[0];
      if (!first || first.raw !== first.value) return segment;
      if (!/^(?:rg|rg\.exe|ripgrep|ripgrep\.exe)$/i.test(first.value)) return segment;
      if (/[\\/]/.test(first.value)) return segment;
      const at = body.indexOf(first.raw);
      if (at < 0) return segment;
      changed = true;
      const replacement = shellType === 'powershell'
        ? `& ${quoteArgument(executable)}`
        : quotePosixArgument(executable);
      return `${lead}${body.slice(0, at)}${replacement}${body.slice(at + first.raw.length)}${trail}`;
    })
  );
  return changed ? bound : command;
}

/** One literal POSIX-shell argument. Single quotes close/reopen around an embedded apostrophe. */
function quotePosixArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
