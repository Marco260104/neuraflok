import type { ShellType } from '../execution/shell.js';
import { hasUnsupportedShellLexemes, RIPGREP_NAMES, RG_BOOLEAN_FLAGS, RG_NO_PATTERN_FLAGS, RG_PATTERN_FLAGS, RG_VALUE_FLAGS, programName, splitTopLevel, tokenize, type Token } from '../exec-command-parser.js';
import type { NormalizedCommand } from './types.js';

/** Where one double-quoted string sits in a command line, read under bash's escape rules. */
interface QuotedRegion {
  /** Index of the opening quote. */
  open: number;
  /** Index of the closing quote. */
  close: number;
  /** Everything between the quotes, exactly as written. */
  body: string;
}

/** Whether PowerShell would reach the end of this line with every quote closed. PowerShell's escapes are its own. Inside a double-quoted string a backtick escapes the next character and a doubled quote stands for one quote; inside a single-quoted string nothing escapes but a doubled apostrophe. A backslash is an ordinary character in both, which is the entire point of this function: a bash-style backslash-quote does not escape anything here, it *closes* the string the caller meant it to sit inside, and every character after that is read as a different kind of token. */
function powershellQuotingTerminates(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote === null) {
      if (char === '"' || char === "'") quote = char;
      continue;
    }
    if (quote === '"' && char === '`') {
      i++;
      continue;
    }
    if (char === quote) {
      if (command.charAt(i + 1) === quote) {
        i++;
        continue;
      }
      quote = null;
    }
  }
  return quote === null;
}

/** The double-quoted strings in a command line, read the way the caller evidently wrote it. bash's rules, not PowerShell's: a backslash escapes the next character both outside quotes and inside double quotes, and a single-quoted string is literal throughout. Returns null when even this reading leaves a quote open, because then there is no coherent intent to recover and nothing below is entitled to act. */
function bashDoubleQuotedRegions(command: string): QuotedRegion[] | null {
  const regions: QuotedRegion[] = [];
  let quote: '"' | "'" | null = null;
  let open = -1;

  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote === null) {
      if (char === '\\') i++;
      else if (char === '"') {
        quote = '"';
        open = i;
      } else if (char === "'") quote = "'";
      continue;
    }
    if (quote === '"') {
      if (char === '\\') i++;
      else if (char === '"') {
        regions.push({ open, close: i, body: command.slice(open + 1, i) });
        quote = null;
      }
      continue;
    }
    if (char === "'") quote = null;
  }

  return quote === null ? regions : null;
}

// Repairs escaped quotes in shell commands written with Bash quoting syntax.
export function repairPowerShellQuoting(cmd: string, shellType: ShellType): NormalizedCommand {
  if (shellType !== 'powershell') return { cmd, notes: [] };
  if (!cmd.includes('\\"')) return { cmd, notes: [] };
  const powerShellBalanced = powershellQuotingTerminates(cmd);
  // A balanced line might be valid PowerShell. The one safe exception below proves the affected token is ripgrep's pattern, but that proof uses the lightweight command parser and therefore inherits its fail-closed boundary around backticks/comments/here-strings.
  if (powerShellBalanced && hasUnsupportedShellLexemes(cmd)) return { cmd, notes: [] };
  const regions = bashDoubleQuotedRegions(cmd);
  if (regions === null) return { cmd, notes: [] };

  // Same offsets and bash-intended quote boundaries, for inspecting flags with the small PowerShell tokenizer. Escaped quotes in another pattern must not conceal a later -F, and a pipeline's Select-Object -First must not look like rg's -F.
  const shapeParts: string[] = [];
  let shapeCursor = 0;
  for (const region of regions) {
    shapeParts.push(cmd.slice(shapeCursor, region.open + 1), region.body.replace(/\\"/g, '__'));
    shapeCursor = region.close;
  }
  shapeParts.push(cmd.slice(shapeCursor));
  const shellShape = shapeParts.join('');

  let out = '';
  let cursor = 0;
  let repaired = 0;
  let regexQuotes = false;
  for (const region of regions) {
    if (!region.body.includes('\\"')) continue;
    if (powerShellBalanced && !isRipgrepPatternRegion(cmd, region)) continue;
    // Interpolation, an escape this reading does not model, or a backslash whose meaning differs between the two shells. Any of them makes the move lossy; leave it to the hint.
    if (/[$`]|\\\\/.test(region.body)) continue;
    // PowerShell 5.1 can still split a single-quoted native argument at whitespace AFTER an embedded \". Merely changing the outer quotes does not repair it. In rg's proven regex slot, \x22 denotes the same literal quote without a native quote round trip (and works with modern pwsh too). Fixed-string mode may appear after the pattern; never substitute regex syntax in that mode.
    const suffix = splitTopLevel(shellShape.slice(region.close + 1), [';', '|', '&&', '||', '\n'])[0] ?? '';
    const patternCommand = `${bashSegmentPrefix(shellShape, region.open) ?? ''} ${suffix}`;
    const regexPattern = isRipgrepPatternRegion(cmd, region) && !/\\[QE]/.test(region.body) &&
      !/[`$#]/.test(patternCommand) &&
      !tokenize(patternCommand).some(token => token.value === '--fixed-strings' || /^-[^-]*F/.test(token.value));
    const body = regexPattern ? region.body.replace(/\\"/g, '\\x22') : region.body;
    regexQuotes ||= regexPattern;
    out += cmd.slice(cursor, region.open);
    out += `'${body.replace(/'/g, "''")}'`;
    cursor = region.close + 1;
    repaired++;
  }
  if (repaired === 0) return { cmd, notes: [] };
  out += cmd.slice(cursor);
  if (!powershellQuotingTerminates(out)) return { cmd, notes: [] };

  return {
    cmd: out,
    notes: [
      'PowerShell does not use backslash to escape quotes. Re-quoted the affected argument with single quotes.' +
        (regexQuotes ? ' In ripgrep regex patterns, literal double quotes use \\x22 to preserve one native argument on Windows PowerShell and pwsh.' :
          ' Native embedded-quote handling also depends on the shell; use a script file for complex code arguments.')
    ]
  };
}

/** The pipeline/statement prefix immediately before one bash-read quoted argument. This scanner exists only for balanced-line quote recovery. It uses the same bash reading that found the region, tracks grouping, and returns null on anything it cannot place at a top-level command boundary. The returned text ends immediately before the opening quote. */
function bashSegmentPrefix(command: string, end: number): string | null {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let start = 0;

  for (let i = 0; i < end; i++) {
    const char = command.charAt(i);
    if (quote === '"') {
      if (char === '\\') i++;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(' || char === '{') {
      depth++;
      continue;
    }
    if (char === ')' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;

    if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      start = i + 1;
      if (
        (char === '|' && command.charAt(i + 1) === '|') ||
        (char === '\r' && command.charAt(i + 1) === '\n')
      ) {
        start = ++i + 1;
      }
      continue;
    }
    if (char === '&' && command.charAt(i + 1) === '&') {
      start = ++i + 1;
    }
  }

  return quote === null && depth === 0 ? command.slice(start, end) : null;
}

/** Whether the next argument after `tokens` is provably ripgrep's search pattern. */
function nextRipgrepArgumentIsPattern(tokens: readonly Token[]): boolean {
  if (!RIPGREP_NAMES.has(programName(tokens[0]))) return false;
  let seenPattern = false;
  let optionsEnded = false;
  let pendingValue: 'pattern' | 'other' | null = null;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (pendingValue !== null) {
      if (pendingValue === 'pattern') seenPattern = true;
      pendingValue = null;
      continue;
    }
    if (!optionsEnded && token.value === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.value.startsWith('-')) {
      const flag = token.value.split('=')[0] as string;
      if (!RG_VALUE_FLAGS.has(flag) && !RG_BOOLEAN_FLAGS.has(flag)) return false;
      if (RG_NO_PATTERN_FLAGS.has(flag)) seenPattern = true;
      if (RG_VALUE_FLAGS.has(flag)) {
        if (token.value.includes('=')) {
          if (RG_PATTERN_FLAGS.has(flag)) seenPattern = true;
        } else {
          pendingValue = RG_PATTERN_FLAGS.has(flag) ? 'pattern' : 'other';
        }
      }
      continue;
    }
    if (!seenPattern) seenPattern = true;
  }

  if (pendingValue !== null) return pendingValue === 'pattern';
  return !seenPattern;
}

/** A balanced PowerShell line is changed only when the affected bash-read string is one whole argument in ripgrep's pattern slot. Paths, flag values and arbitrary shell strings remain untouched even when they contain the same characters. */
function isRipgrepPatternRegion(command: string, region: QuotedRegion): boolean {
  const before = region.open === 0 ? '' : command.charAt(region.open - 1);
  const after = command.charAt(region.close + 1);
  if (before !== '' && !/\s/.test(before)) return false;
  if (after !== '' && !/[\s;|&\r\n)]/.test(after)) return false;
  const prefix = bashSegmentPrefix(command, region.open);
  if (prefix === null) return false;
  return nextRipgrepArgumentIsPattern(tokenize(prefix));
}
