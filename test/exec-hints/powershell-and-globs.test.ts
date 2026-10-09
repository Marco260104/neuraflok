import { nonZeroExitIsBenign, normalizeShellCommand, statusDeterminingProgram } from "../../backend/domains/workspace/exec-hints.js";
import { describe, expect, it } from 'vitest';

describe('globs PowerShell will not expand for a native program', () => {
  /** One directory, holding a file the glob matches, a file it does not, and a sub-directory that itself contains a match. That sub-directory is the whole point: a `-g '*_test.go'` filter is recursive and would have found `sub/nested_test.go` too, which the command as written never asked for. */
  const cwd = () => ['other.go', 'sub', 'top_test.go', 'zz_test.go'];

  it('expands a bare filename glob into the entries the shell would have passed', () => {
    const result = normalizeShellCommand("rg -n 'TunnelListener' *_test.go", 'powershell', cwd);
    expect(result.cmd).toBe("rg -n 'TunnelListener' 'top_test.go' 'zz_test.go'");
    expect(result.notes.join(' ')).toMatch(/does not expand globs/i);
  });

  it('expands the relative path globs from the latest recorded failures', () => {
    const calls: string[] = [];
    const tree = (directory = '.'): readonly string[] => {
      calls.push(directory);
      if (directory === 'test') {
        return [
          'computer-frame-bounds.test.ts',
          'computer.test.ts',
          'tools-desktop-permissions.test.ts',
          'tools-desktop-runtime.test.ts'
        ];
      }
      if (directory === 'backend/infrastructure/tool-gateway/protocol') return ['kernel.ts', 'server.ts', 'tools-core.ts'];
      return [];
    };

    const tests = normalizeShellCommand(
      "rg -n wait test/tools-desktop*.test.ts test/computer*.test.ts",
      'powershell',
      tree
    );
    expect(tests.cmd).toBe(
      "rg -n wait 'test/tools-desktop-permissions.test.ts' 'test/tools-desktop-runtime.test.ts' " +
        "'test/computer-frame-bounds.test.ts' 'test/computer.test.ts'"
    );

    const mcp = normalizeShellCommand(
      'rg -n -C 12 caller backend/infrastructure/tool-gateway/protocol/*.ts',
      'powershell',
      tree
    );
    expect(mcp.cmd).toBe(
      "rg -n -C 12 caller 'backend/infrastructure/tool-gateway/protocol/kernel.ts' 'backend/infrastructure/tool-gateway/protocol/server.ts' 'backend/infrastructure/tool-gateway/protocol/tools-core.ts'"
    );
    expect(calls).toEqual(['test', 'test', 'backend/infrastructure/tool-gateway/protocol']);
    expect([...tests.notes, ...mcp.notes].join(' ')).toMatch(/relative directory/i);
  });

  it('never widens the search to sub-directories the glob did not name', () => {
    // The regression that retired the previous rewrite. `-g` is a recursive filter, so `rg pattern -g '*_test.go'` also matches `sub\nested_test.go` — extra results returned confidently, with nothing downstream able to tell they were never asked for.
    const result = normalizeShellCommand("rg -n 'x' *_test.go", 'powershell', cwd);
    expect(result.cmd).not.toContain('-g');
    expect(result.cmd).not.toContain('sub');
    expect(result.cmd).toBe("rg -n 'x' 'top_test.go' 'zz_test.go'");
  });

  it('expands a bash brace group into the paths bash would have produced', () => {
    // Straight from the corpus: the model writes one path with alternatives, PowerShell has no brace expansion, and ripgrep is handed a single directory name that does not exist.
    const result = normalizeShellCommand('rg -n "AppGraph" app/src/{main,test}/java', 'powershell', cwd);
    expect(result.cmd).toBe("rg -n \"AppGraph\" 'app/src/main/java' 'app/src/test/java'");
    expect(result.notes.join(' ')).toMatch(/no brace expansion/i);
  });

  it('expands braces without a directory listing, because the expansion is textual', () => {
    // Unlike a glob, a brace group needs nothing from the disk — and is not checked against it either, so a path that is not there still earns ripgrep's own error rather than silence.
    const result = normalizeShellCommand('rg -n x src/{a,b}', 'powershell', null);
    expect(result.cmd).toBe("rg -n x 'src/a' 'src/b'");
  });

  it('never mistakes a script block for a brace group', () => {
    // The danger the narrow pattern exists for: `{ … }` is PowerShell's own syntax, and rewriting one into a list of paths would destroy the command.
    for (const cmd of [
      'rg -n x . | Where-Object { $_ -match "a,b" }',
      'rg -n x . | ForEach-Object { $_.Trim(),$_.Length }',
      "rg -n 'a{2,3}' src"
    ]) {
      expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
      expect(normalizeShellCommand(cmd, 'powershell', cwd).notes).toEqual([]);
    }
  });

  it('leaves a brace group alone when it is quoted or holds no alternative', () => {
    // A quoted group was protected on purpose, and a comma is what separates a path from a regex quantifier or a block — without one there is nothing to expand.
    for (const cmd of ["rg -n x 'src/{a,b}'", 'rg -n x src/{a}', 'rg -n x src/{$env:X,b}']) {
      expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    }
  });

  it('refuses a brace group whose alternatives would still need a glob stage', () => {
    // bash expands braces and *then* expands the wildcards in what came out. Only the first half happens here, and what it produces is quoted so it reaches the program verbatim — so expanding this one would hand ripgrep two quoted wildcards it cannot open, which is a worse failure than the untouched group. Both alternatives are judged, not just the one carrying the wildcard.
    for (const cmd of [
      'rg -n x {*.ts,*.js}',
      'rg -n x src/{main,test}/*.ts',
      'rg -n x {main,test/*}',
      'rg -n x {a,b?}',
      'rg -n x {[ab].ts,c.ts}'
    ]) {
      const result = normalizeShellCommand(cmd, 'powershell', cwd);
      expect(result.cmd).toBe(cmd);
      expect(result.notes).toEqual([]);
    }
  });

  it('does not read a wrapper script as the program whose exit code it trusts', () => {
    // `rg.cmd`, `rg.bat` and `rg.ps1` are local scripts that happen to be named after ripgrep. Nothing about them promises exit 1 means "no matches", so the exemption that rests on that promise cannot be given to them. Only the program itself earns it.
    for (const wrapper of ['.\\rg.ps1 foo', 'rg.cmd foo', 'rg.bat foo', 'C:\\tools\\rg.cmd foo']) {
      expect(nonZeroExitIsBenign(wrapper, 1, '')).toBe(false);
    }
    // The real program still does when the command text proves an executable path.
    expect(nonZeroExitIsBenign('rg foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('C:\\tools\\rg.exe foo', 1, '')).toBe(true);
    expect(statusDeterminingProgram('rg -n foo | rg.cmd bar')).toBe('rg.cmd');
  });

  it('expands braces after the first statement, where a glob would be left alone', () => {
    // The asymmetry is the point: the brace group means the same thing wherever it appears, while the glob one statement later would be answered from the wrong directory.
    const mixed = "$ErrorActionPreference='Stop'; rg -n x app/{main,test}";
    const result = normalizeShellCommand(mixed, 'powershell', cwd);
    expect(result.cmd).toBe("$ErrorActionPreference='Stop'; rg -n x 'app/main' 'app/test'");
    expect(normalizeShellCommand("Set-Location sub; rg -n x *_test.go", 'powershell', cwd).cmd).toBe(
      'Set-Location sub; rg -n x *_test.go'
    );
  });

  it('leaves everything after the first statement alone', () => {
    // Expansion happens here, before anything runs; the shell would have expanded when it reached the statement. Those are the same answer only while nothing ran in between.
    const moved = "Set-Location sub; rg -n 'x' *_test.go";
    expect(normalizeShellCommand(moved, 'powershell', cwd).cmd).toBe(moved);
    // And the files a preceding statement is about to create do not exist yet to be listed.
    const built = "npm run build; rg -n 'x' *_test.go";
    expect(normalizeShellCommand(built, 'powershell', cwd).cmd).toBe(built);
    expect(normalizeShellCommand(built, 'powershell', cwd).notes).toEqual([]);
  });

  it('expands inside the first statement even when it is a pipeline', () => {
    const result = normalizeShellCommand("rg -n 'x' *_test.go | Select-Object -First 5", 'powershell', cwd);
    expect(result.cmd).toBe("rg -n 'x' 'top_test.go' 'zz_test.go' | Select-Object -First 5");
  });

  it('knows the pattern slot is already filled by -e, --file or --files', () => {
    // Each of these used to leave the first bare token counted as the pattern, so the glob after it was never reached at all.
    expect(normalizeShellCommand("rg -e 'foo' *_test.go", 'powershell', cwd).cmd).toBe(
      "rg -e 'foo' 'top_test.go' 'zz_test.go'"
    );
    expect(normalizeShellCommand('rg --regexp=foo *_test.go', 'powershell', cwd).cmd).toBe(
      "rg --regexp=foo 'top_test.go' 'zz_test.go'"
    );
    expect(normalizeShellCommand('rg --files *_test.go', 'powershell', cwd).cmd).toBe(
      "rg --files 'top_test.go' 'zz_test.go'"
    );
  });

  it('passes an unmatched glob through exactly as a shell would', () => {
    // A shell that matches nothing hands the program the pattern. Substituting nothing here would instead turn a scoped search into a search of the entire tree.
    const cmd = "rg -n 'x' *.rs";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'powershell', cwd).notes).toEqual([]);
  });

  it('gives up rather than build a command line nobody can read', () => {
    const many = () => Array.from({ length: 200 }, (_, i) => `file_${i}_test.go`);
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'powershell', many).cmd).toBe(cmd);
  });

  it('does nothing at all without a directory to expand against', () => {
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'powershell').cmd).toBe(cmd);
    const unreadable = () => {
      throw new Error('EPERM');
    };
    expect(normalizeShellCommand(cmd, 'powershell', unreadable).cmd).toBe(cmd);
  });

  it('expands only bounded child-directory globs', () => {
    // A child directory is exact and still beneath the command workdir. A parent traversal or absolute path is not: normalization must not pre-read a broader location merely because the command itself could do so when it eventually runs.
    const cmd = "rg -n 'benchmark' ..\\docs\\*.md";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    const withDrive = 'rg -n "Transport" C:\\Users\\x\\tunnel-client*';
    expect(normalizeShellCommand(withDrive, 'powershell', cwd).cmd).toBe(withDrive);
    const parentGlob = "rg -n 'x' src*\\nested\\*.md";
    expect(normalizeShellCommand(parentGlob, 'powershell', cwd).cmd).toBe(parentGlob);

    const nested = (directory = '.'): readonly string[] =>
      directory === 'sub' ? ['a.md', 'b.md', 'c.ts'] : [];
    expect(normalizeShellCommand("rg -n 'x' sub\\*.md", 'powershell', nested).cmd).toBe(
      "rg -n 'x' 'sub\\a.md' 'sub\\b.md'"
    );
  });

  it('expands a directory bigger than the old bound, which is where the bound bit', () => {
    // Recorded four times in one day: this repository's own `test/` holds 71 `*.test.ts` files, the previous limit of 48 refused them, and refusing does not fail politely — ripgrep receives the literal asterisk and answers `os error 123`, which is the failure this expansion exists to remove rather than a hint the caller can act on.
    const many = Array.from({ length: 71 }, (_, i) => `case-${String(i).padStart(2, '0')}.test.ts`);
    const tree = (directory = '.'): readonly string[] => (directory === 'test' ? many : []);
    const result = normalizeShellCommand('rg -n "turnEnd" test/*.test.ts', 'powershell', tree);

    for (const name of many) expect(result.cmd).toContain(`'test/${name}'`);
    // The wall of filenames was the note's problem, not the command's: every name still runs.
    expect(result.notes.join(' ')).toContain('the 71 entries');
    expect(result.notes.join(' ')).toContain('and 59 more');
    expect(result.notes.join(' ')).not.toContain('case-70.test.ts');
  });

  it('still has a bound, and still fails to ripgrep rather than to a guess', () => {
    // The limit moved to where the real constraint is; it did not stop existing. Past it the command is left exactly as written, which is the one honest outcome — substituting a shortened list would silently search less than the caller asked for.
    const tree = (directory = '.'): readonly string[] =>
      directory === 'test' ? Array.from({ length: 129 }, (_, i) => `case-${i}.test.ts`) : [];
    const cmd = 'rg -n "turnEnd" test/*.test.ts';
    expect(normalizeShellCommand(cmd, 'powershell', tree)).toEqual({ cmd, notes: [] });
  });

  it('never mistakes the search pattern for a filename glob', () => {
    // `.*` and `foo?` are regex here. Expanding either would change what is searched for.
    const cmd = 'rg -n "json\\.Marshal|Write\\(.*" src';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand('rg "colou?r" src', 'powershell', cwd).cmd).toBe('rg "colou?r" src');
  });

  it('leaves a glob that is already a flag value alone', () => {
    const cmd = "rg -n 'x' -g '*.md' src";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    const long = "rg -n 'x' --glob '*.md' src";
    expect(normalizeShellCommand(long, 'powershell', cwd).cmd).toBe(long);
  });

  it('leaves a glob the caller quoted on purpose alone', () => {
    // Quoting it is how a caller asks for the literal to reach ripgrep. Honour that.
    const cmd = "rg -n 'x' '*_test.go'";
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
  });

  it('leaves a shell expansion alone', () => {
    const cmd = 'rg -n "x" "$env:USERPROFILE\\go\\pkg\\*"';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
  });

  it('touches nothing that is not ripgrep', () => {
    const cmd = 'Get-ChildItem *.md | Select-Object Name';
    expect(normalizeShellCommand(cmd, 'powershell', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand('go test ./...', 'powershell', cwd).cmd).toBe('go test ./...');
  });

  it('leaves POSIX shells alone, where the shell already expanded the glob', () => {
    const cmd = "rg -n 'x' *_test.go";
    expect(normalizeShellCommand(cmd, 'bash', cwd).cmd).toBe(cmd);
    expect(normalizeShellCommand(cmd, 'zsh', cwd).notes).toEqual([]);
  });
});

