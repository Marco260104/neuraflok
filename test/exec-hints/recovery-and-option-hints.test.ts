
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { RG_BOOLEAN_FLAGS, RG_OPTION_TABLE_VERSION, RG_VALUE_FLAGS, bindBundledRipgrep, execRecoveryHints, nonZeroExitIsBenign, normalizeShellCommand, withExecNotes } from "../../backend/domains/workspace/exec-hints.js";
import { locateRipgrep } from "../../backend/infrastructure/binaries/ripgrep.js";
import { describe, expect, it } from 'vitest';

describe('saying what to do next', () => {
  it('steers away from PowerShell loops after this chat strips $ as math', () => {
    const garbled = 'Get-ChildItem lib/*.js, index.js | ForEach-Object { "{0} {1}" -f (Get-Content .         ∣        −       −     ) .      , . FullName∣Measure−Object−Line).Lines,.FullName }';
    const hints = execRecoveryHints(garbled, '', 'powershell');
    expect(hints.join(' ')).toMatch(/renders \$ as math/i);
    expect(hints.join(' ')).toMatch(/Use `read`/);
    expect(hints.join(' ')).toMatch(/Do not retry a PowerShell loop/i);
    expect(
      execRecoveryHints(
        'Get-ChildItem lib/*.js | ForEach-Object { (Get-Content . FullName | Measure-Object -Line).Lines }',
        '',
        'powershell'
      ).join(' ')
    ).toMatch(/Use `read`/);
    expect(execRecoveryHints('rg --files', '', 'powershell')).toEqual([]);
    expect(execRecoveryHints('Get-Content app.js | Select-String -Pattern x', '', 'powershell')).toEqual([]);
    expect(execRecoveryHints(garbled, '', 'bash')).toEqual([]);
  });

  it('steers off POSIX pipelines when PowerShell does not have the program', () => {
    const output =
      "wc : El término 'wc' no se reconoce como nombre de un cmdlet, función, archivo de script o programa ejecutable.\n" +
      'FullyQualifiedErrorId : CommandNotFoundException';
    const hints = execRecoveryHints('wc -l lib/*.js index.js', output, 'powershell');
    expect(hints.join(' ')).toMatch(/no head, wc, cat, or ls/i);
    expect(hints.join(' ')).toMatch(/Use `read`/);
    expect(execRecoveryHints('rg --files', output, 'powershell')).toEqual([]);
  });

  it('names the cause when git ran outside a repository', () => {
    const hints = execRecoveryHints('git status --short', 'fatal: not a git repository (or any of the parent directories): .git');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/not a git repository/i);
    expect(hints[0]).toMatch(/rev-parse --show-toplevel/);
  });

  it('recognises the --no-index fall-through as git diff outside a repository', () => {
    // Outside a repository `git diff <path>` prints a warning and its whole option list, or silently compares two named files; neither says "not a repository" in a way that was read.
    const usage = 'warning: Not a git repository. Use --no-index to compare two paths outside a working tree\nusage: git diff --no-index [<options>] <path> <path>\n\nDiff output format options\n    -p, --patch\n';
    const hints = execRecoveryHints('git diff -- src/main.js', usage, 'powershell');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/not a git repository/i);
    expect(hints[0]).toMatch(/--no-index/);
    expect(hints[0]).toMatch(/rev-parse --show-toplevel/);
    expect(execRecoveryHints('git diff -- src/main.js', 'diff --git a/src/main.js b/src/main.js\n', 'powershell')).toEqual([]);
  });

  it('explains a backslash-quote that split the argument instead of ending the line', () => {
    // The quotes balanced, so PowerShell ran the cmdlet with the remainder as positional arguments; the refusal names a fragment of the pattern, not the backslash.
    const output =
      'Select-String : A positional parameter cannot be found that accepts argument \'click\\\'.\n' +
      'FullyQualifiedErrorId : PositionalParameterNotFound,Microsoft.PowerShell.Commands.SelectStringCommand';
    const hints = execRecoveryHints('Get-Content app.js | Select-String -Pattern "addEventListener(\\"click\\")"', output, 'powershell');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/backslash-quote/);
    expect(hints[0]).toMatch(/single quotes/);
    expect(execRecoveryHints('Select-String -Pattern "plain" extra', output, 'powershell')).toEqual([]);
  });

  it('explains an unexpanded glob rather than leaving the code to be guessed at', () => {
    const hints = execRecoveryHints('rg -n x C:\\a\\b*', 'rg: C:\\a\\b*: IO error … (os error 123)');
    expect(hints.join(' ')).toMatch(/PowerShell does not expand/);
  });

  it('never gives a POSIX shell a PowerShell-only glob recovery command', () => {
    const output = 'rg: src/*.ts: IO error for operation on src/*.ts: No such file or directory (os error 2)';
    const hints = execRecoveryHints("rg -n x 'src/*.ts'", output, 'bash').join(' ');
    expect(hints).not.toMatch(/PowerShell|Get-ChildItem|\$env:/);
  });

  it('uses shell-native path and toolchain recovery syntax on POSIX', () => {
    const missingPath = execRecoveryHints(
      'rg -n x src/missing.ts',
      'rg: src/missing.ts: IO error for operation on src/missing.ts: No such file or directory (os error 2)',
      'zsh'
    ).join(' ');
    expect(missingPath).toContain("ls -ld -- '<path>'");
    expect(missingPath).not.toMatch(/Get-ChildItem|PowerShell/);

    const java = execRecoveryHints('gradle test', 'ERROR: JAVA_HOME is not set', 'bash').join(' ');
    expect(java).toContain('export JAVA_HOME=/path/to/jdk');
    expect(java).toContain('$JAVA_HOME/bin:$PATH');
    expect(java).not.toMatch(/\$env:|C:\\/);

    const go = execRecoveryHints('go test ./...', 'go: cannot find GOROOT directory', 'sh').join(' ');
    expect(go).toContain('bin/go');
    expect(go).toContain('export GOROOT=/path/to/go');
    expect(go).not.toContain('go.exe');
  });

  it('uses cmd-native toolchain recovery syntax when cmd was explicitly requested', () => {
    const java = execRecoveryHints('gradlew test', 'ERROR: JAVA_HOME is not set', 'cmd').join(' ');
    expect(java).toContain('set "JAVA_HOME=C:\\path\\to\\jdk"');
    expect(java).not.toContain('$env:');

    const go = execRecoveryHints('go test ./...', 'go: cannot find GOROOT directory', 'cmd').join(' ');
    expect(go).toContain('set "GOROOT=C:\\path\\to\\go"');
    expect(go).toContain('bin\\go.exe');
  });

  it('hands over the guard form when PowerShell 5.1 refused && or ||', () => {
    const refusal = "The token '&&' is not a valid statement separator in this version.";
    const hints = execRecoveryHints('npm test && npm publish', refusal);
    expect(hints).toHaveLength(1);
    // The point of the hint is the conditional, so it has to carry the guard and say why `;` is not the answer — a model told only "use ;" would publish after a failing test run.
    expect(hints[0]).toMatch(/if \(\$\?\) \{ B \}/);
    expect(hints[0]).toMatch(/if \(-not \$\?\) \{ B \}/);
    expect(hints[0]).toMatch(/not the same as `;`/);
    expect(execRecoveryHints('a || b', "The token '||' is not a valid statement separator in this version.")).toHaveLength(1);
  });

  it('turns common PowerShell parser diagnostics into a correction at the failure site', () => {
    const cases = [
      {
        command: 'rg -n "unterminated src',
        output: 'ParserError: The string is missing the terminator: ".\nFullyQualifiedErrorId : TerminatorExpectedAtEndOfString',
        expected: /balance the quoted argument/i
      },
      {
        command: 'Get-Item -LiteralPath',
        output: 'ParserError: Missing an argument for parameter LiteralPath.\nFullyQualifiedErrorId : MissingArgument',
        expected: /supply the missing value/i
      },
      {
        command: 'python - <<EOF',
        output: 'ParserError: Missing file specification after redirection operator.\nFullyQualifiedErrorId : MissingFileSpecification',
        expected: /does not support Bash heredocs/i
      }
    ];

    for (const item of cases) {
      const hints = execRecoveryHints(item.command, item.output);
      expect(hints.join(' '), item.output).toMatch(/PowerShell parsed none of the command/i);
      expect(hints.join(' '), item.output).toMatch(item.expected);
      expect(hints.join(' '), item.output).toMatch(/rerun/i);
    }
  });

  /** The same unterminated string, as a German Windows install reports it. PowerShell localises the wrapper around this diagnostic, and the batch runner's ScriptBlock.Create path is the one that carries it. Matching the English sentence made the hint English-only: on a localised Windows the model saw a foreign-language exception and no statement that nothing had parsed, which is the one thing it needed to act on. The method name and the parser's caret underline are the parts nothing translates. */
  it('recognises the batch parser diagnostic on a localized Windows', () => {
    const output = [
      'Ausnahme beim Aufrufen von "Create" mit 1 Argument(en):  "In Zeile:1 Zeichen:14',
      "+ Write-Output 'unterminated",
      '+              ~~~~~~~~~~~~~',
      `Die Zeichenfolge hat kein Abschlusszeichen: '."`
    ].join('\n');

    expect(execRecoveryHints("Write-Output 'unterminated", output).join(' '))
      .toMatch(/PowerShell parsed none of the command/i);
  });

  it('stays silent on a shell where the operators work', () => {
    // PowerShell 7 runs `&&` without complaint, so there is no refusal text and no hint. The hint keys off the shell's own error, never off the command containing the operator.
    expect(execRecoveryHints('npm test && npm publish', 'ok')).toHaveLength(0);
  });

  it('stays silent on a healthy result', () => {
    expect(execRecoveryHints('rg -n foo src', 'Process exited with code 0\nOutput:\nsrc/a.ts:1:foo')).toEqual([]);
  });

  it('appends notes without disturbing the parity-formatted body', () => {
    const body = 'Wall time: 0.1 seconds\nProcess exited with code 1\nOutput:\nx';
    expect(withExecNotes(body, [])).toBe(body);
    const noted = withExecNotes(body, ['do the thing']);
    expect(noted.startsWith(body)).toBe(true);
    expect(noted).toContain('Note: do the thing');
  });
});

describe('the exec_command pipeline, in the order tools-core actually runs it', () => {
  // The two rewrites are not independent, and the bug this guards was invisible to every test that exercised them one at a time. `bindBundledRipgrep` turns the leading `rg` into `& '<path>\\rg.exe'`, and `normalizeShellCommand` recognises ripgrep by exactly that leading token -- so binding first switched off glob and brace expansion for every ordinary rg call while every single-function test stayed green. Normalize, then bind.
  const RG = 'C:\\Program Files\\app\\rg.exe';
  const pipeline = (cmd: string, entries: readonly string[]) => {
    const normalized = normalizeShellCommand(cmd, 'powershell', () => entries);
    return bindBundledRipgrep(normalized.cmd, 'powershell', RG);
  };

  it('expands the glob and still pins the executable', () => {
    const out = pipeline('rg -n TODO *.ts', ['a.ts', 'b.ts', 'note.md']);
    expect(out).toContain("'a.ts'");
    expect(out).toContain("'b.ts'");
    expect(out).not.toContain('*.ts');
    expect(out.startsWith('& ')).toBe(true);
    expect(out).toContain('rg.exe');
  });

  it('expands a brace group and still pins the executable', () => {
    const out = pipeline('rg TODO ./{backend,contracts}', []);
    expect(out).toContain("'./backend'");
    expect(out).toContain("'./contracts'");
    expect(out).not.toContain('{main,shared}');
    expect(out.startsWith('& ')).toBe(true);
  });

  it('leaves the bound command provable enough to earn the benign-exit exemption', () => {
    // The exemption is what makes "no matches" stop counting as an error, and it requires a path-qualified program. Classifying the pre-bind text instead would silently lose it.
    const out = pipeline('rg -n TODO *.ts', ['a.ts']);
    expect(nonZeroExitIsBenign(out, 1, '')).toBe(true);
    expect(nonZeroExitIsBenign('rg -n TODO a.ts', 1, '')).toBe(false);
  });
});

describe('the ripgrep option table against the ripgrep this app ships', () => {
  it('is derived from the version the packaging actually pins', () => {
    // Read rather than imported: the pin lives in a .mjs the typecheck does not cover, and the only thing needed here is the string a person edits when they bump ripgrep.
    const pinned = /version:\s*'([^']+)'/.exec(
      readFileSync('scripts/packaging-versions.mjs', 'utf8').split('export const RIPGREP')[1] ?? ''
    );
    expect(pinned?.[1]).toBe(RG_OPTION_TABLE_VERSION);
  });

  it('lists every option the binary documents, with the right arity', () => {
    const executable = locateRipgrep();
    // Only the packaging steps fetch ripgrep, so a plain `npm ci && npm test` has no binary to ask. The pin check above is the half that catches the change a person makes.
    if (executable === null || !existsSync(executable)) return;

    const help = execFileSync(executable, ['--help'], { encoding: 'utf8' });
    const documented = new Map<string, boolean>();
    for (const line of help.split(/\r?\n/)) {
      // Option headers sit at exactly four spaces; their prose is indented further.
      if (!/^ {4}-/.test(line)) continue;
      for (const part of line.trim().split(/,\s+/)) {
        // `-A NUM`, `--after-context=NUM` take a value; `-i`, `--ignore-case` do not.
        const match = /^(--?[A-Za-z0-9][A-Za-z0-9.-]*)(?:[=\s](\S+))?$/.exec(part);
        if (!match?.[1]) continue;
        documented.set(match[1], match[2] !== undefined);
      }
    }
    expect(documented.size).toBeGreaterThan(100);

    const wrong: string[] = [];
    for (const [flag, takesValue] of documented) {
      const table = RG_VALUE_FLAGS.has(flag) ? true : RG_BOOLEAN_FLAGS.has(flag) ? false : null;
      if (table === null) wrong.push(`${flag} is missing from the table`);
      else if (table !== takesValue) {
        wrong.push(`${flag} is listed as ${table ? 'taking a value' : 'boolean'} and is not`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

