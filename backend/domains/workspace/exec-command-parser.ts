// Conservative shell token analysis for safe command handling.

/** Programs whose exit code 1 means "found nothing", not "went wrong". */
export const NO_MATCH_MEANS_EXIT_1 = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr']);

/** Search programs whose glob arguments PowerShell will not expand for them. */
export const RIPGREP_NAMES = new Set(['rg', 'ripgrep']);

/** The ripgrep release this option table was read out of. Named so the pin and the table can be checked against each other. Bumping the bundled binary without revisiting the table is exactly how a flag goes missing, and a missing flag does not fail — it silently changes what was searched for. */
export const RG_OPTION_TABLE_VERSION = '15.2.0';

/** ripgrep's own option table, derived from `rg --help` of the binary this app ships rather than from memory. Both halves are listed: the flags that consume the next argument, so a glob that is already a flag's *value* is never mistaken for a path operand and rewritten (`-g *.md` must survive this file untouched), and the flags that consume nothing, so the operand after them is known to be one. Getting this wrong is not a failed call, it is a changed one. A flag that consumes the next argument and is not listed here makes that argument look like the search pattern, which makes the *pattern* look like a path — and a path is what this file expands. The live example was `rg --engine pcre2 foo.* src`: with `--engine` unknown, `pcre2` was read as the pattern and `foo.*` was expanded against the working directory, so ripgrep was asked a different question than the one that was typed and answered it successfully. So both halves are listed, and anything in neither is unknown arity: the segment is then left exactly as written. Rewriting nothing is always a safe answer; guessing is not. */
export const RG_VALUE_FLAGS = new Set([
  '--after-context', '--before-context', '--color', '--colors', '--context',
  '--context-separator', '--dfa-size-limit', '--encoding', '--engine',
  '--field-context-separator', '--field-match-separator', '--file', '--generate', '--glob',
  '--hostname-bin', '--hyperlink-format', '--iglob', '--ignore-file', '--max-columns',
  '--max-count', '--max-depth', '--max-filesize', '--path-separator', '--pre', '--pre-glob',
  '--regex-size-limit', '--regexp', '--replace', '--sort', '--sortr', '--threads', '--type',
  '--type-add', '--type-clear', '--type-not', '-A', '-B', '-C', '-E', '-M', '-T', '-d', '-e',
  '-f', '-g', '-j', '-m', '-r', '-t'
]);

export const RG_BOOLEAN_FLAGS = new Set([
  '--auto-hybrid-regex', '--binary', '--block-buffered', '--byte-offset', '--case-sensitive',
  '--column', '--count', '--count-matches', '--crlf', '--debug', '--files',
  '--files-with-matches', '--files-without-match', '--fixed-strings', '--follow',
  '--glob-case-insensitive', '--heading', '--help', '--hidden', '--ignore-case',
  '--ignore-file-case-insensitive', '--include-zero', '--invert-match', '--json',
  '--line-buffered', '--line-number', '--line-regexp', '--max-columns-preview', '--mmap',
  '--multiline', '--multiline-dotall', '--no-config', '--no-filename', '--no-ignore',
  '--no-ignore-dot', '--no-ignore-exclude', '--no-ignore-files', '--no-ignore-global',
  '--no-ignore-messages', '--no-ignore-parent', '--no-ignore-vcs', '--no-line-number',
  '--no-messages', '--no-pcre2-unicode', '--no-require-git', '--no-unicode', '--null',
  '--null-data', '--one-file-system', '--only-matching', '--passthru', '--pcre2',
  '--pcre2-version', '--pretty', '--quiet', '--search-zip', '--smart-case', '--sort-files',
  '--stats', '--stop-on-nonmatch', '--text', '--trace', '--trim', '--type-list',
  '--unrestricted', '--version', '--vimgrep', '--with-filename', '--word-regexp', '-.', '-0',
  '-F', '-H', '-I', '-L', '-N', '-P', '-S', '-U', '-V', '-a', '-b', '-c', '-h', '-i', '-l', '-n',
  '-o', '-p', '-q', '-s', '-u', '-v', '-w', '-x', '-z'
]);

/** Flags that fill the search-pattern slot, so the next bare token is a path and not the pattern. Without them `rg -e foo *.go` reads `*.go` as the pattern it has already been given and leaves the glob to fail; `--files` takes no pattern at all and its first operand met the same fate. */
export const RG_PATTERN_FLAGS = new Set(['-e', '--regexp', '-f', '--file']);
export const RG_NO_PATTERN_FLAGS = new Set(['--files', '--type-list']);

export interface Token {
  /** Exactly as written, quotes included, so a command can be rebuilt without damage. */
  raw: string;
  /** Quotes stripped, for comparison. */
  value: string;
  quoted: boolean;
}

/** Splits one command line into tokens, respecting single and double quotes. Not a shell parser and not trying to be. It has to be right about quoting only well enough that a quoted argument containing a space or a semicolon is never split, because a mis-split is what would turn a rewrite into a broken command. */
export function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let raw = '';
  let value = '';
  let quoted = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (raw === '') return;
    tokens.push({ raw, value, quoted });
    raw = '';
    value = '';
    quoted = false;
  };

  for (const char of segment) {
    if (quote !== null) {
      raw += char;
      if (char === quote) quote = null;
      else value += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      raw += char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    raw += char;
    value += char;
  }
  flush();
  return tokens;
}

/** Shell syntax this intentionally-small parser cannot model without guessing. Backticks can escape separators/quotes/whitespace. `#` starts comments outside quotes, so a textual `; rg ...` after it may never execute. PowerShell here-strings (`@"` / `@'`) are multiline quoting constructs whose interior may contain every separator this file splits. Any one of those turns a separator-only parse into an unsafe approximation. The caller's command still runs unchanged; we simply decline rewrites and benign-exit inference. */
export function hasUnsupportedShellLexemes(command: string): boolean {
  if (command.includes('`') || command.includes('@"') || command.includes("@'")) return true;
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return true;
  }
  return false;
}

/** Index of every top-level occurrence of any separator in `seps`, ignoring quoted text. */
export function splitTopLevel(command: string, seps: readonly string[], hits?: string[]): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;

  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    // `$( … )`, `@( … )` and plain grouping all hide separators that are not statement boundaries. Depth-tracking keeps `(a; b)` from being read as two statements.
    if (char === '(' || char === '{') depth++;
    else if (char === ')' || char === '}') {
      if (depth === 0) return [command];
      depth--;
    }

    if (depth === 0) {
      const hit = seps.find((sep) => command.startsWith(sep, i));
      if (hit !== undefined) {
        parts.push(current);
        hits?.push(hit);
        current = '';
        i += hit.length - 1;
        continue;
      }
    }
    current += char;
  }
  if (quote !== null || depth !== 0) {
    hits?.splice(0);
    return [command];
  }
  parts.push(current);
  return parts.filter((part) => part.trim() !== '');
}

/** The bare program name of a token, lowercased and stripped of its path and `.exe`. `.exe` and nothing else. Everything this name is used to decide is a claim about a *program's* contract — ripgrep spending exit 1 on "no matches" — and `rg.cmd`, `rg.bat` or `rg.ps1` is a local script that merely happens to be named after it. A wrapper is free to exit 1 for its own reasons, and calling that ripgrep's no-match answer would launder exactly the failure this file exists to stop laundering. So an extension that is not `.exe` stays part of the name, which no set of known programs contains. */
export function programName(token: Token | undefined): string {
  if (!token) return '';
  const tail = token.value.split(/[\\/]/).pop() ?? '';
  return tail.toLowerCase().replace(/\.exe$/, '');
}

/** PowerShell aliases that are cmdlets despite not being spelled Verb-Noun. Only needed to tell "this stage leaves $LASTEXITCODE alone" from "this stage sets it". Anything not recognised here is assumed to be a program, which is the safe assumption: it can only ever cost an exemption, never grant one. */
const CMDLET_ALIASES = new Set([
  'select', 'where', 'foreach', 'sort', 'measure', 'group', 'tee', 'ft', 'fl', 'fw', 'gc',
  'gci', 'gi', 'ls', 'dir', 'cat', 'echo', 'write', 'sls', 'ogv', '%', '?'
]);

/** Recognizes PowerShell cmdlets by exact name because executable names can share the same Verb-Noun shape. Unknown names remain native commands so genuine process failures cannot be mistaken for empty search results. */
const KNOWN_CMDLETS = new Set([
  'add-content', 'add-member', 'clear-content', 'compare-object', 'convertfrom-csv',
  'convertfrom-json', 'convertfrom-stringdata', 'convertto-csv', 'convertto-html',
  'convertto-json', 'copy-item', 'export-clixml', 'export-csv', 'format-custom',
  'format-list', 'format-table', 'format-wide', 'get-childitem', 'get-command',
  'get-content', 'get-date', 'get-filehash', 'get-item', 'get-itemproperty',
  'get-location', 'get-member', 'get-process', 'get-random', 'get-unique', 'group-object',
  'import-csv', 'join-path', 'measure-object', 'move-item', 'new-item', 'new-object',
  'out-file', 'out-gridview', 'out-host', 'out-null', 'out-string', 'remove-item',
  'rename-item', 'resolve-path', 'select-object', 'select-string', 'select-xml',
  'set-content', 'set-location', 'sort-object', 'split-path', 'tee-object', 'test-path',
  'where-object', 'write-error', 'write-host', 'write-output', 'write-warning',
  'foreach-object'
]);

/** Whether a pipeline stage is PowerShell's own, and so cannot have set the exit code. */
function looksLikeCmdlet(token: Token | undefined): boolean {
  if (!token) return false;
  // A path or an executable extension names a program, whatever the rest of it looks like.
  if (/[\\/]/.test(token.value)) return false;
  if (/\.(exe|cmd|bat|com|ps1)$/i.test(token.value)) return false;
  const name = token.value.toLowerCase();
  return CMDLET_ALIASES.has(name) || KNOWN_CMDLETS.has(name);
}

/** Downstream pipeline stages that cannot decide what the shell exits with. Being a cmdlet is not enough, which is what this replaced. `Out-File -LiteralPath 'Z:\missing\x.txt'` is a known cmdlet, carries no script block, throws DriveNotFoundException and exits the host with status 1 — and no diagnostic the output guard knows appears. Skipping it and reading the exit code off ripgrep upstream would file that as a search that found nothing. `Write-Error` and `ForEach-Object { exit 1 }` do the same thing by other routes. So nothing is skipped on the strength of its name. These are the exact shapes the recorded sessions actually use to trim ripgrep's output, each argument-free or fixed enough to have nothing left to fail at. Anything else — a cmdlet with arguments, an expression, a block — is status-ambiguous, and an ambiguous stage means no exemption for the line. */
const PASSIVE_STAGES = [
  /^(?:select-object|select)\s+-(?:first|last)\s+\d+$/i,
  /^(?:sort-object|sort)$/i,
  /^(?:measure-object|measure)$/i,
  /^out-null$/i
];

export function stageIsPassive(segment: string): boolean {
  return PASSIVE_STAGES.some((shape) => shape.test(segment));
}

/** The literal executable token at the head of one pipeline stage. PowerShell needs the call operator to execute a quoted path, so the deterministic bundled ripgrep form produced below is `& 'C:\\...\\rg.exe' ...`. Treat that literal path as the program, but refuse dynamic call-operator forms such as `& $cmd`: their target is runtime state and the command text cannot prove what actually ran. */
export function stageProgramToken(segment: string): Token | null {
  const tokens = tokenize(segment);
  const first = tokens[0];
  if (!first) return null;
  if (first.value !== '&') return first;
  const target = tokens[1];
  if (!target || !/[\\/]/.test(target.value)) return null;
  return target;
}

/** The program whose exit status the shell will report. PowerShell sets `$LASTEXITCODE` from the last *native* program it ran — the last one in the pipeline, not the first. `cmd /c exit 1 | cmd /c exit 0` leaves 0 behind; reversed, it leaves 1. Cmdlets do not touch it at all, which is why `rg … | Select-Object -First 80` still reports ripgrep's own code even though ripgrep is not the last stage. So: last statement, then the rightmost stage that is a program rather than a cmdlet, and the generator only when every stage after it was PowerShell's own. Reading the generator unconditionally is what would let `rg foo | git diff --exit-code` be filed as an `rg` result — and `rg` is on the list of programs allowed to exit 1 harmlessly, so git failing would have been recorded as a search that found nothing. A stage this cannot classify counts as a program. That direction only ever withholds an exemption, and a real failure recorded as a failure is the outcome to fail towards. */
/** The exact token whose process status would determine this command, when the lightweight parse is strong enough to name one. Kept separate from statusDeterminingProgram because the benign-exit decision needs one extra fact the display name intentionally throws away: whether the caller used a path. A profiled PowerShell can define `function rg { ... }` and even `function rg.exe { ... }`, so a bare spelling is not proof that ripgrep.exe ran. A path-qualified spelling cannot be intercepted by that command-name lookup and is therefore materially stronger evidence. */
export function statusDeterminingToken(command: string): Token | null {
  // The lightweight splitter below deliberately does not implement PowerShell's backtick escape grammar. That is already enough reason for normalizeShellCommand to leave such a line untouched, and it is equally important here: a backtick can escape `;`, `|`, a newline or whitespace, changing which textual fragment actually ran and which process supplied the exit status. Treating an escaped separator as real can make an upstream `cmd /c exit 1` look like a later `rg` no-match and silently launder the failure. With no trustworthy parse there is no trustworthy program name, so withhold the exemption.
  if (hasUnsupportedShellLexemes(command)) return null;
  // A conditional chain decides at run time which of its branches ran, and nothing in the text of it says which one did. `cmd /c exit 1 && rg foo` never reaches ripgrep at all — PowerShell 7 runs the operator, sees the failure and stops — and yet the last statement is still `rg foo`. Reading it would file that exit 1 as a search that found nothing. There is no program this can name honestly, so it names none, and the exemption that depends on the name is withheld. Windows PowerShell 5.1 refuses such a line outright and the output guard catches that; this is the shell where the operators actually work.
  if (splitTopLevel(command, ['&&', '||']).length > 1) return null;
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return null;
  const segments = splitTopLevel(last, ['|']);
  for (let i = segments.length - 1; i > 0; i--) {
    const segment = (segments[i] as string).trim();
    if (stageIsPassive(segment)) continue;
    const first = stageProgramToken(segment);
    // A program here set $LASTEXITCODE and is the answer; a cmdlet here could have decided the status without touching it, and cannot be proven not to have.
    return looksLikeCmdlet(first ?? undefined) ? null : (first ?? null);
  }
  const generator = segments[0];
  if (generator === undefined) return null;
  return stageProgramToken(generator);
}

export function statusDeterminingProgram(command: string): string {
  return programName(statusDeterminingToken(command) ?? undefined);
}

/** Diagnostics that mean the shell itself refused the command line. None of these can coexist with "the search ran and found nothing", so any of them is enough to withhold the benign-exit exemption. Matching one of these on output that was genuinely a search result would only cost an exemption, which is the direction this file is allowed to be wrong in. */
