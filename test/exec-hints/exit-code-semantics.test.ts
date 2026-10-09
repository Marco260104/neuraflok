import { BOUND_RG, WINDOWS_POWERSHELL } from './context.js';
import { bindBundledRipgrep, nonZeroExitIsBenign, normalizePowerShellOperators, normalizeShellCommand, statusDeterminingProgram } from "../../backend/domains/workspace/exec-hints.js";
import { describe, expect, it } from 'vitest';

describe('which program decided the exit code', () => {
  it('reads through a pipeline of cmdlets to the program that generated the output', () => {
    // Cmdlets never touch $LASTEXITCODE, so ripgrep's own code is still the one reported.
    expect(statusDeterminingProgram('rg -n "foo" src | Select-Object -First 30')).toBe('rg');
    expect(statusDeterminingProgram('rg -n "foo" src | sort | measure')).toBe('rg');
  });

  it('reads to the last native program in a pipeline, not the first', () => {
    // Verified in PowerShell: `cmd /c exit 1 | cmd /c exit 0` leaves $LASTEXITCODE at 0, and reversing the two leaves it at 1. The last native stage wins.
    expect(statusDeterminingProgram('rg -n foo src | git diff --exit-code')).toBe('git');
    expect(statusDeterminingProgram('cmd /c exit 1 | cmd /c exit 0')).toBe('cmd');
    expect(statusDeterminingProgram('rg -n foo src | C:\\tools\\rg.exe -n bar')).toBe('rg');
  });

  it('treats a stage it cannot classify as a program rather than as a cmdlet', () => {
    // The direction that withholds an exemption. Guessing "cmdlet" here would file whatever that stage did under ripgrep's name.
    expect(statusDeterminingProgram('rg -n foo src | mystery_tool --strict')).toBe('mystery_tool');
  });

  it('takes the last statement of a chain', () => {
    expect(statusDeterminingProgram("$root='C:\\x'; Get-ChildItem $root; rg -n 'foo' $root")).toBe('rg');
  });

  it('ignores separators inside quotes and groups', () => {
    expect(statusDeterminingProgram(`rg -n 'a;b|c' src`)).toBe('rg');
    expect(statusDeterminingProgram('(Get-ChildItem; Get-Item) ; rg -n x')).toBe('rg');
  });

  it('strips a directory and an extension from the program name', () => {
    expect(statusDeterminingProgram('C:\\tools\\rg.exe -n foo src')).toBe('rg');
  });
});

describe('PowerShell 5.1 conditional chains', () => {
  const rewrite = (cmd: string) => normalizePowerShellOperators(cmd, 'powershell', WINDOWS_POWERSHELL);

  it('preserves && and || semantics with $? guards', () => {
    expect(rewrite('a.exe && b.exe || c.exe').cmd).toBe(
      'a.exe; if ($?) { b.exe }; if (-not $?) { c.exe }'
    );
  });

  it.each([
    'a.exe > out.txt && b.exe',
    'a.exe; b.exe && c.exe',
    'a.exe && b.exe && c.exe && d.exe && e.exe',
    'a.exe # comment && b.exe'
  ])('leaves unsafe or ambiguous input unchanged: %s', (cmd) => {
    expect(rewrite(cmd)).toEqual({ cmd, notes: [] });
  });

  it('does nothing for PowerShell 7 or POSIX shells', () => {
    const cmd = 'a.exe && b.exe';
    expect(normalizePowerShellOperators(cmd, 'powershell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual({
      cmd,
      notes: []
    });
    expect(normalizePowerShellOperators(cmd, 'bash', '/bin/bash')).toEqual({ cmd, notes: [] });
  });
});

describe('a non-zero exit that is a result rather than a failure', () => {
  it('treats ripgrep exit 1 with no output as "no matches"', () => {
    const output = 'Wall time: 0.0056 seconds\nProcess exited with code 1\nOutput:\n';
    expect(nonZeroExitIsBenign(`${BOUND_RG} -n "CallToolRequest" src`, 1, output)).toBe(true);
  });

  it('treats ripgrep exit 1 after Select-Object truncated the pipe as success', () => {
    // The pipe closing early is why the code is non-zero; the matches did arrive.
    const output = 'Process exited with code 1\nOutput:\nclient.go:36: defaultMaxInFlightRequests = 20\n';
    expect(nonZeroExitIsBenign(`${BOUND_RG} -n "Max" $root | Select-Object -First 160`, 1, output)).toBe(true);
  });

  it('keeps a partially answered search classified as failed when a requested path is unreadable', () => {
    const output = [
      'Process exited with code 2',
      'Output:',
      'rg: src/missing.ts: The system cannot find the file specified. (os error 2)',
      'src/main.ts:9:export const found = true;'
    ].join('\n');
    const command = `${BOUND_RG} -n found src/missing.ts src/main.ts`;
    expect(nonZeroExitIsBenign(command, 2, output)).toBe(false);
    expect(nonZeroExitIsBenign(command, 2, output.replace(
      'The system cannot find the file specified. (os error 2)', 'Access is denied. (os error 5)'
    ))).toBe(false);
  });

  it('keeps diagnostic-only, multi-statement, and bare ripgrep exit 2 as failures', () => {
    const diagnostic = 'Output:\nrg: src/missing.ts: The system cannot find the file specified. (os error 2)';
    const partial = `${diagnostic}\nsrc/main.ts:9:found`;
    expect(nonZeroExitIsBenign(`${BOUND_RG} found src/missing.ts`, 2, diagnostic)).toBe(false);
    expect(nonZeroExitIsBenign(`Write-Output found; ${BOUND_RG} found src/missing.ts`, 2, partial)).toBe(false);
    expect(nonZeroExitIsBenign('rg found src/missing.ts src/main.ts', 2, partial)).toBe(false);
  });

  it('still calls it an error when ripgrep printed an error of its own', () => {
    // The exact live failure: an unexpanded glob. Exit 1, but the call really did fail, and exempting it would hide the very thing the glob rewrite exists to prevent.
    const output =
      'Process exited with code 1\nOutput:\nrg: C:\\Users\\x\\tunnel-client*: IO error for operation on ' +
      'C:\\Users\\x\\tunnel-client*: The filename, directory name, or volume label syntax is incorrect. (os error 123)\n';
    expect(nonZeroExitIsBenign('rg -n "Transport" C:\\Users\\x\\tunnel-client*', 1, output)).toBe(false);
  });

  it('never exempts a program that does not spend exit 1 on "no matches"', () => {
    const output = 'Process exited with code 1\nOutput:\n--- FAIL: TestThing\nFAIL\n';
    expect(nonZeroExitIsBenign('go test ./...', 1, output)).toBe(false);
    expect(nonZeroExitIsBenign('.\\gradlew.bat :app:test', 1, output)).toBe(false);
  });

  it('never answers a bracket class with the file that is literally named that', () => {
    // The matcher escapes `[` and `]`, so this pattern would have matched the one file whose name really does contain the brackets — while the shell being stood in for means a character class and would have matched a1.ts and a2.ts. Expanding it is not a smaller answer, it is a different one, reported as success.
    const list = (): readonly string[] => ['a1.ts', 'a2.ts', 'a[12]-literal.ts'];
    const cmd = 'rg needle a[12]*.ts';
    expect(normalizeShellCommand(cmd, 'powershell', list).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'powershell', list).notes).toEqual([]);
  });

  it('does not rewrite around PowerShell backtick escapes it does not parse', () => {
    // In PowerShell the backtick escapes this space, so `foo` + `bar*.ts` is one argument. A whitespace-only tokenizer sees two tokens and would otherwise expand `bar*.ts`, silently changing one path into two arguments. Backticks therefore make the whole command ineligible for normalization rather than inviting a partial guess.
    const list = (): readonly string[] => ['bar-one.ts', 'bar-two.ts'];
    const escapedSpace = 'rg needle foo` bar*.ts';
    expect(normalizeShellCommand(escapedSpace, 'powershell', list)).toEqual({
      cmd: escapedSpace,
      notes: []
    });

    // A backtick can also continue a physical line. Treating that newline as a statement separator would be the same class of parse corruption.
    const continued = 'rg needle `\n*.ts';
    expect(normalizeShellCommand(continued, 'powershell', list)).toEqual({ cmd: continued, notes: [] });
  });

  it('never grants a benign exit through a PowerShell backtick escape it cannot parse', () => {
    // Real Windows PowerShell: the backtick escapes the semicolon, so the apparent `rg` tail is not a second statement at all. cmd exits 1, but a separator-only parser used to pick rg as the status program and turn the genuine cmd failure into "no matches".
    for (const cmd of [
      'cmd /c exit 1 `; rg foo',
      'cmd /c exit 1 `| rg foo',
      'cmd /c exit 1 `\nrg foo'
    ]) {
      expect(statusDeterminingProgram(cmd)).toBe('');
      expect(nonZeroExitIsBenign(cmd, 1, '')).toBe(false);
    }
  });

  it('never infers execution through comments or PowerShell here-strings it does not parse', () => {
    const bundled = 'C:\\tools\\rg.exe';
    // Everything after # is comment text. A separator-only parser used to see the semicolon, pick the apparent rg tail and could launder cmd's real exit 1 as a search miss.
    const commented = 'cmd /c exit 1 # ; rg foo';
    expect(statusDeterminingProgram(commented)).toBe('');
    expect(nonZeroExitIsBenign(commented, 1, '')).toBe(false);
    expect(bindBundledRipgrep(commented, 'powershell', bundled)).toBe(commented);

    // Here-string contents are data, not statements. Newlines and semicolons inside them must never be rebuilt as shell structure or have a literal line beginning with rg rebound.
    const hereString = '$x = @"\nrg foo *.ts; still text\n"@\nWrite-Output $x';
    expect(statusDeterminingProgram(hereString)).toBe('');
    expect(bindBundledRipgrep(hereString, 'powershell', bundled)).toBe(hereString);
    expect(normalizeShellCommand(hereString, 'powershell', () => ['one.ts'])).toEqual({
      cmd: hereString,
      notes: []
    });

    // A hash inside ordinary quoted data is understood by the quote tracker and does not disable safe parsing unnecessarily.
    expect(statusDeterminingProgram("Write-Output '#'; C:\\tools\\rg.exe foo")).toBe('rg');
  });

  it('does not trust a bare search command when command lookup could have shadowed it', () => {
    // PowerShell command lookup prefers functions/aliases over applications. Both spellings below are legal function names; cmd.exe can likewise pick a current-directory rg.cmd; POSIX shells have functions/aliases too. The text alone therefore proves nothing.
    expect(nonZeroExitIsBenign('rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('rg.exe foo', 1, '')).toBe(false);

    // A path-qualified executable cannot be replaced by command-name lookup. The call-operator form is what bindBundledRipgrep produces for a quoted Windows path.
    expect(nonZeroExitIsBenign('.\\rg.exe foo', 1, '')).toBe(true);
    expect(nonZeroExitIsBenign(`${BOUND_RG} foo`, 1, '')).toBe(true);
  });

  it('binds bare PowerShell and POSIX ripgrep to the bundled executable without touching explicit/dynamic forms', () => {
    const bundled = 'C:\\Program Files\\NEURAFLOK\\resources\\rg\\rg.exe';
    expect(bindBundledRipgrep('rg -n foo src', 'powershell', bundled)).toBe(
      "& 'C:\\Program Files\\NEURAFLOK\\resources\\rg\\rg.exe' -n foo src"
    );
    expect(bindBundledRipgrep('rg foo | Select-Object -First 5', 'powershell', bundled)).toBe(
      "& 'C:\\Program Files\\NEURAFLOK\\resources\\rg\\rg.exe' foo | Select-Object -First 5"
    );
    expect(bindBundledRipgrep('Write-Output x; ripgrep foo', 'powershell', bundled)).toBe(
      "Write-Output x; & 'C:\\Program Files\\NEURAFLOK\\resources\\rg\\rg.exe' foo"
    );

    // Explicit paths and dynamic/escaped commands preserve the exact shell semantics the caller wrote. The binding exists only for the bare name whose intended runtime the app already owns by shipping it and prepending it to PATH.
    expect(bindBundledRipgrep('.\\tools\\rg.exe foo', 'powershell', bundled)).toBe('.\\tools\\rg.exe foo');
    expect(bindBundledRipgrep('& $search foo', 'powershell', bundled)).toBe('& $search foo');
    expect(bindBundledRipgrep('rg foo`; Write-Output x', 'powershell', bundled)).toBe('rg foo`; Write-Output x');

    const posix = '/Applications/NEURAFLOK/resources/rg/rg';
    const boundPosix = "'/Applications/NEURAFLOK/resources/rg/rg' foo";
    expect(bindBundledRipgrep('rg foo', 'bash', posix)).toBe(boundPosix);
    expect(bindBundledRipgrep('ripgrep foo', 'zsh', posix)).toBe(boundPosix);
    expect(bindBundledRipgrep('rg foo', 'sh', posix)).toBe(boundPosix);
    expect(nonZeroExitIsBenign(boundPosix, 1, '')).toBe(true);
    expect(bindBundledRipgrep('rg foo', 'bash', "/tmp/it's/rg")).toBe("'/tmp/it'\\''s/rg' foo");
    expect(bindBundledRipgrep('/usr/bin/rg foo', 'bash', posix)).toBe('/usr/bin/rg foo');
    expect(bindBundledRipgrep('rg foo', 'cmd', bundled)).toBe('rg foo');
  });

  it('hides a leading dot from a pattern without one, and only then', () => {
    // The POSIX rule the caller was writing to: `*.ts` skips dotfiles, `.h*.ts` asks for them.
    const list = (): readonly string[] => ['.hidden.ts', 'plain.ts'];
    expect(normalizeShellCommand('rg -n x *.ts', 'powershell', list).cmd).toBe("rg -n x 'plain.ts'");
    expect(normalizeShellCommand('rg -n x .h*.ts', 'powershell', list).cmd).toBe("rg -n x '.hidden.ts'");
  });

  it('never rewrites a command whose option arity it cannot know', () => {
    // The corruption this guard exists for: `--engine` consumes `pcre2`, which makes `foo.*` the *pattern*. Reading `--engine` as a switch instead made `pcre2` the pattern and `foo.*` a path — and expanding that path asked ripgrep a different question than the one that was typed, then reported success. Rewriting nothing is the only safe answer.
    const list = (): readonly string[] => ['foo.js', 'other.ts'];
    expect(normalizeShellCommand('rg --engine pcre2 foo.* src', 'powershell', list).cmd).toBe(
      'rg --engine pcre2 foo.* src'
    );
    // Every flag known, so the same line normalizes as before.
    expect(normalizeShellCommand('rg --engine=pcre2 x *.js', 'powershell', list).cmd).toBe(
      "rg --engine=pcre2 x 'foo.js'"
    );
    // An option ripgrep does not have at all remains ambiguous and therefore untouched.
    expect(normalizeShellCommand('rg --not-a-real-flag x *.js', 'powershell', list).cmd).toBe(
      'rg --not-a-real-flag x *.js'
    );
    // `--` is different: its arity is exact and it makes everything after it positional, so the pattern/path slots are safer to identify than they were before the delimiter.
    expect(normalizeShellCommand('rg -- x *.js', 'powershell', list).cmd).toBe("rg -- x 'foo.js'");
    expect(normalizeShellCommand('rg x -- *.js', 'powershell', list).cmd).toBe("rg x -- 'foo.js'");
  });

  it('only reads through pipeline stages that cannot decide the exit status', () => {
    // Being a cmdlet is not enough. `Out-File` to a missing drive throws, exits the host with 1, and prints nothing the output guard recognises; `Write-Error` and a script block that calls `exit` do the same by other routes. Reading ripgrep's code through any of them files a real failure as a search that found nothing.
    expect(statusDeterminingProgram("rg x src | Out-File -LiteralPath 'Z:\\missing\\x.txt'")).toBe('');
    expect(statusDeterminingProgram('rg x src | Set-Content -LiteralPath Z:\\missing\\x.txt')).toBe('');
    expect(statusDeterminingProgram('rg x src | ForEach-Object { exit 1 }')).toBe('');
    expect(statusDeterminingProgram('rg x src | Write-Error boom')).toBe('');
    expect(nonZeroExitIsBenign('rg x src | ForEach-Object { exit 1 }', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign("rg x src | Out-File -LiteralPath 'Z:\\missing\\x.txt'", 1, '')).toBe(false);
    // The shapes the recorded sessions actually use to trim output still read through.
    expect(statusDeterminingProgram('rg x src | Select-Object -First 5')).toBe('rg');
    expect(statusDeterminingProgram('rg x src | Out-Null')).toBe('rg');
    expect(statusDeterminingProgram('rg x src | sort | measure')).toBe('rg');
  });

  it('never exempts a conditional chain, because nothing says which branch ran', () => {
    // PowerShell 7 runs `&&` for real: this one exits 1 from cmd and never reaches ripgrep, yet `rg foo` is still the last statement in the text. The 5.1 parser-error guard does not help here, because on 7 there is no parser error to see — the chain simply ran.
    expect(statusDeterminingProgram('cmd /c exit 1 && rg foo')).toBe('');
    expect(nonZeroExitIsBenign('cmd /c exit 1 && rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('go build ./... || rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('rg foo && go build ./...', 1, '')).toBe(false);
    // A `;` chain is unconditional: every statement ran, so the last one is the answer.
    expect(statusDeterminingProgram('cmd /c exit 1; rg foo')).toBe('rg');
    expect(nonZeroExitIsBenign(`cmd /c exit 1; ${BOUND_RG} foo`, 1, '')).toBe(true);
  });

  it('never exempts a command the shell refused to parse', () => {
    // Verified in Windows PowerShell 5.1 on this machine: `&&` is rejected outright, nothing runs, and the exit code is 1. This guard reads the shell's own diagnostic, so it holds even for a chain whose text would otherwise have ended in a search that found nothing.
    const parserError = [
      'At line:1 char:17',
      '+ Write-Output hi && rg foo',
      '+                 ~~',
      "The token '&&' is not a valid statement separator in this version.",
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException'
    ].join('\n');
    expect(nonZeroExitIsBenign('Write-Output hi && rg foo', 1, parserError)).toBe(false);
    expect(nonZeroExitIsBenign('rg foo || Write-Output no', 1, parserError)).toBe(false);
  });

  it.each([
    'zsh:1: no matches found: missing/*.ts',
    'zsh: no matches found: missing/*.ts',
    '/bin/bash: line 1: /bin/rg: No such file or directory',
    'sh: 1: cannot create /missing/file: Directory nonexistent',
    '-zsh: permission denied: /bin/rg',
    'dash: 1: /bin/rg: not found'
  ])('never exempts POSIX shell refusal: %s', (diagnostic) => {
    expect(nonZeroExitIsBenign('/bin/rg needle missing/*.ts', 1, diagnostic)).toBe(false);
    expect(nonZeroExitIsBenign('/bin/rg needle sample.txt', 1, '')).toBe(true);
  });

  it('never exempts a search the shell could not even find', () => {
    const notFound = [
      "rg : The term 'rg' is not recognized as the name of a cmdlet, function, script file, " +
        'or operable program.',
      '    + CategoryInfo          : ObjectNotFound: (rg:String) [], CommandNotFoundException'
    ].join('\n');
    expect(nonZeroExitIsBenign('rg -n foo src', 1, notFound)).toBe(false);
  });

  it('never exempts a real failure in a hyphenated program later in the pipeline', () => {
    // `docker-compose` has the shape of a cmdlet and is a native program. Reading it as one of PowerShell's own would skip it, hand the exit code back to ripgrep, and launder its failure into "no matches".
    const output = ['Process exited with code 1', 'Output:', 'error: no configuration file provided'].join(
      '\n'
    );
    expect(statusDeterminingProgram('rg -n foo src | docker-compose up')).toBe('docker-compose');
    expect(nonZeroExitIsBenign('rg -n foo src | docker-compose up', 1, output)).toBe(false);
    expect(statusDeterminingProgram('rg -n foo src | tunnel-client --strict')).toBe('tunnel-client');
  });

  it('never exempts a program whose name is built from an approved PowerShell verb', () => {
    // The near-miss fix for the line above was to require an approved verb before the hyphen, which these three defeat: they are executables spelled exactly like cmdlets. Only an exact cmdlet name can be trusted, so an unrecognised Verb-Noun has to count as native.
    const output = 'Process exited with code 1\nOutput:\n2 suites failed\n';
    expect(statusDeterminingProgram('rg x src | test-runner')).toBe('test-runner');
    expect(nonZeroExitIsBenign('rg x src | test-runner', 1, output)).toBe(false);
    expect(statusDeterminingProgram('rg x src | build-tool --ci')).toBe('build-tool');
    expect(statusDeterminingProgram('rg x src | get-version')).toBe('get-version');
  });

  it('still reads through the cmdlets it does know', () => {
    // The exemption has to survive, or the benign-exit rule stops firing on the real corpus: these are the stage heads that actually follow a search in recorded sessions.
    expect(statusDeterminingProgram('rg x src | Select-Object -First 5')).toBe('rg');
    expect(nonZeroExitIsBenign(`${BOUND_RG} x src | Sort-Object | Measure-Object`, 1, '')).toBe(true);
  });

  it('never exempts an exit code other than 1', () => {
    const clean = 'Process exited with code 2\nOutput:\n';
    // ripgrep reserves 2 for real errors, which is what makes exempting 1 safe at all.
    expect(nonZeroExitIsBenign('rg -n foo src', 2, clean)).toBe(false);
    expect(nonZeroExitIsBenign('rg -n foo src', 0, clean)).toBe(false);
    expect(nonZeroExitIsBenign('rg -n foo src', null, clean)).toBe(false);
  });

  it('does not exempt a search whose exit code came from a later program', () => {
    const output = 'Process exited with code 1\nOutput:\nfatal: not a git repository\n';
    expect(nonZeroExitIsBenign('rg -n foo src; git status', 1, output)).toBe(false);
  });

  it('does not exempt a native program downstream of the search in one pipeline', () => {
    // `git diff --exit-code` exits 1 to mean "there are differences", and it is the last native stage, so that 1 is the one PowerShell reports. Reading the pipeline's generator instead would have filed a real result under ripgrep's exemption.
    const output = 'Process exited with code 1\nOutput:\ndiff --git a/x b/x\n';
    expect(nonZeroExitIsBenign('rg -l foo | git diff --exit-code', 1, output)).toBe(false);
  });
});

