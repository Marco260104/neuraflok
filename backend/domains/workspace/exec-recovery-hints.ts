import type { ShellType } from './execution/shell.js';

// Suggest recovery steps only for clearly identified command failures.
export function execRecoveryHints(
  command: string,
  outputText: string,
  shellType: ShellType = 'powershell'
): string[] {
  const hints: string[] = [];
  const powershell = shellType === 'powershell';
  const cmd = shellType === 'cmd';

  if (shellType === 'zsh' && /^\s*(?:[^\s:]*\/)?-?zsh:(?:\d+:)?\s*no matches found:/im.test(outputText)) {
    hints.push(
      'zsh rejected an unmatched filename glob before launching that command. For ripgrep, use ' +
      '`rg -g \'<glob>\' <existing-directory>` so rg handles the filter. Earlier statements may already have run.'
    );
  }

  if (
    powershell &&
    (/[∣−]/.test(command) ||
      (!command.includes('$') &&
        /ForEach-Object/.test(command) &&
        /Get-Content|Measure-Object/.test(command)))
  ) {
    hints.push(
      'This chat renders $ as math, which destroys PowerShell variables. Do not retry a PowerShell loop. ' +
        'Use `read` on the project files you need.'
    );
  }

  if (
    powershell &&
    /(^|\n)\s*rg\s*:/i.test(outputText) &&
    /CommandNotFoundException|no se reconoce|is not recognized/i.test(outputText)
  ) {
    hints.push(
      'PowerShell did not find rg. Do not retry the same command. List the project with `read` on the project folder, then read the files you need.'
    );
  }

  if (
    powershell &&
    /\b(head|wc|cat|ls)\b/.test(command) &&
    /CommandNotFoundException|no se reconoce|is not recognized/i.test(outputText)
  ) {
    hints.push(
      'PowerShell has no head, wc, cat, or ls. Do not retry that pipeline. ' +
        'Use `read` on the project files you need.'
    );
  }

  if (/fatal: not a git repository/i.test(outputText)) {
    hints.push(
      'That folder is not a git repository, so no git command that needs one will work there. ' +
        'Check with `git rev-parse --show-toplevel`, or set workdir to the folder that actually contains .git. ' +
        'The server instructions list which approved roots are repositories.'
    );
  } else if (/warning: Not a git repository\. Use --no-index|^usage: git diff --no-index/im.test(outputText)) {
    // Outside a repository, git diff can fall into no-index mode.
    hints.push(
      'That folder is not a git repository. `git diff` there falls into `git diff --no-index`, which compares the ' +
        'named files with each other or prints its option list, so nothing above is a diff against any commit. ' +
        'Check with `git rev-parse --show-toplevel`, or set workdir to the folder that actually contains .git.'
    );
  }

  if (
    powershell &&
    /[?*]/.test(command) &&
    (/os error 123/i.test(outputText) || /IO error for operation on .*[*?]/i.test(outputText))
  ) {
    hints.push(
      'PowerShell does not expand `*` or `?` for native programs, so the pattern reached the program literally. ' +
        'For ripgrep pass the filename pattern as `-g \'<glob>\'`; otherwise expand it first, e.g. ' +
        '`Get-ChildItem -Path \'<glob>\' | ForEach-Object FullName`.'
    );
  }

  // A missing path can leave valid matches beside a nonzero exit.
  if (
    /^\s*(?:rg|ripgrep|grep|egrep|fgrep|findstr):.*(?:os error 2\b|No such file or directory|cannot find the (?:file|path) specified)/im.test(
      outputText
    )
  ) {
    const checkPath = powershell
      ? '`Get-ChildItem -LiteralPath \'<path>\'`'
      : cmd
        ? '`dir "<path>"`'
        : '`ls -ld -- \'<path>\'`';
    hints.push(
      'The search exited non-zero because a path it was given does not exist — the error line ' +
        'above names it. Retain the matches already returned, but the requested search is incomplete. ' +
        `Confirm the spelling with ${checkPath} before re-running, and re-run only the ` +
        'missing path rather than the whole search.'
    );
  }

  if (
    powershell &&
    command.includes('\\"') &&
    /PositionalParameterNotFound|A positional parameter cannot be found that accepts argument/i.test(outputText) &&
    !/The string (?:is missing the terminator|starting:)/i.test(outputText)
  ) {
    // PowerShell ran the line after the backslash ended the quoted argument.
    hints.push(
      'PowerShell ended the double-quoted argument at the backslash-quote inside it — a backslash escapes nothing in ' +
        'PowerShell — and handed the rest of the text to the cmdlet as extra positional arguments, which it refused. ' +
        'For an rg regex, use single quotes and \\x22 for the literal double quote; double any apostrophe. ' +
        'Use a script file for complex native arguments: embedded-quote handling differs between PowerShell versions.'
    );
  }

  if (powershell && command.includes('\\"') && /The string (?:is missing the terminator|starting:)/i.test(outputText)) {
    hints.push(
      'PowerShell refused that line at a quote and ran none of it, including any earlier ' +
        'statement on the same line. A backslash is not an escape character in PowerShell, so ' +
        'a backslash-quote inside a double-quoted argument ends the argument there. For an rg regex, ' +
        'use single quotes and \\x22 for the literal double quote; double any apostrophe. ' +
        'Use a script file for complex native arguments: embedded-quote handling differs between PowerShell versions.'
    );
  }

  // Keep conditional operators as advice because a rewrite could run gated commands.
  const invalidOperator = /The token '(&&|\|\|)' is not a valid statement separator/i.exec(outputText)?.[1];
  if (powershell && invalidOperator && command.includes(invalidOperator)) {
    hints.push(
      'Windows PowerShell 5.1 has no `&&` or `||`, so it refused the whole line and ran nothing. ' +
        'These are not the same as `;`, which would run the second command even when the first failed: ' +
        'write `A; if ($?) { B }` for `A && B`, and `A; if (-not $?) { B }` for `A || B`. ' +
        'Chain longer runs by nesting inside the block rather than repeating the guard.'
    );
  }

  const bashQuoteFailure = command.includes('\\"') && /The string (?:is missing the terminator|starting:)/i.test(outputText);
  const parserFailure =
    /\bParserError\b/i.test(outputText) ||
    // The batch runner wraps PowerShell parser errors in ScriptBlock.Create exceptions.
    /Exception calling "Create" with "1" argument\(s\): "At line:\d+ char:\d+/i.test(outputText) ||
    // Localized parser errors retain the method name and caret underline.
    (/"Create"/.test(outputText) && /(?:^|\n)\s*\+\s*~{2,}/.test(outputText)) ||
    /FullyQualifiedErrorId\s*:\s*(?:TerminatorExpectedAtEndOfString|MissingArgument|MissingExpressionAfterToken|MissingFileSpecification|RedirectionNotSupported|UnexpectedToken|EmptyPipeElement)/i.test(
      outputText
    );
  if (powershell && parserFailure && !invalidOperator && !bashQuoteFailure) {
    const correction = /TerminatorExpectedAtEndOfString|missing the terminator/i.test(outputText)
      ? 'Balance the quoted argument; for literal regexes and paths, prefer one single-quoted PowerShell argument.'
      : /MissingArgument|missing an argument/i.test(outputText)
        ? 'Supply the missing value after the named parameter or comma, quoting it as one argument when it contains shell punctuation.'
        : /MissingFileSpecification|RedirectionNotSupported|redirection operator/i.test(outputText)
          ? 'PowerShell does not support Bash heredocs such as `<<EOF`; use a PowerShell here-string piped to the program, or write the content with Set-Content.'
          : 'Use the reported line and character to correct the unexpected or incomplete token; split unrelated checks into `exec_command.cmds`.';
    hints.push(
      `PowerShell parsed none of the command, so no statement ran. ${correction} Correct the syntax and rerun the command.`
    );
  }

  if (/JAVA_HOME is not set/i.test(outputText)) {
    const example = powershell
      ? "`$env:JAVA_HOME='C:\\path\\to\\jdk'; $env:Path=\"$env:JAVA_HOME\\bin;$env:Path\"`"
      : cmd
        ? '`set "JAVA_HOME=C:\\path\\to\\jdk" && set "PATH=%JAVA_HOME%\\bin;%PATH%"`'
        : '`export JAVA_HOME=/path/to/jdk; export PATH="$JAVA_HOME/bin:$PATH"`';
    hints.push(`No Java could be found automatically. Point JAVA_HOME at a JDK for this command, e.g. ${example}.`);
  }

  if (/cannot find GOROOT/i.test(outputText)) {
    const executable = powershell || cmd ? 'bin\\go.exe' : 'bin/go';
    const example = powershell
      ? "`$env:GOROOT='C:\\path\\to\\go'; $env:Path=\"$env:GOROOT\\bin;$env:Path\"`"
      : cmd
        ? '`set "GOROOT=C:\\path\\to\\go" && set "PATH=%GOROOT%\\bin;%PATH%"`'
        : '`export GOROOT=/path/to/go; export PATH="$GOROOT/bin:$PATH"`';
    hints.push(
      `The go binary was found but GOROOT was not set and could not be inferred. Set GOROOT to the ` +
        `toolchain directory that contains ${executable} before invoking it, e.g. ${example}.`
    );
  }

  return hints;
}

// Append advice after the original execution result.
export function withExecNotes(responseText: string, notes: readonly string[]): string {
  if (notes.length === 0) return responseText;
  return `${responseText}\n\n${notes.map((note) => `Note: ${note}`).join('\n')}`;
}
