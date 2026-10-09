import { BOUND_RG, WORKER_2_IMPORT_SWEEP, WORKER_2_SYMBOL_SWEEP } from './context.js';

import { benignExitNote, bindBundledRipgrep, execRecoveryHints, repairPowerShellQuoting, withExecNotes } from "../../backend/domains/workspace/exec-hints.js";
import { describe, expect, it } from 'vitest';

describe('repairing a bash-style escaped quote', () => {
  it('re-quotes a regex without embedded native quotes', () => {
    const repaired = repairPowerShellQuoting(WORKER_2_SYMBOL_SWEEP, 'powershell');
    expect(repaired.cmd).toContain(
      "rg -n 'connection:|connectBtn|connect-button|connecting|disconnect|applySettings|" +
        "saveSettings|onState|state === ''starting|state === \\x22starting' backend/application/ipc/register.ts"
    );
    // The statements that had nothing to do with the broken quote are untouched.
    expect(repaired.cmd).toContain("echo '--- connection diff ---'; git diff -- backend/infrastructure/connectivity/connection.ts");
    expect(repaired.notes).toHaveLength(1);
  });

  it('repairs every broken argument on the line and leaves the rest of it alone', () => {
    const repaired = repairPowerShellQuoting(WORKER_2_IMPORT_SWEEP, 'powershell');
    expect(repaired.cmd).toBe(
      "rg -n 'from ''../backend/infrastructure/connectivity/connection|from \\x22../backend/infrastructure/connectivity/connection|" +
        "connection\\.js''|connection\\.js\\x22' test . | Select-Object -First 200"
    );
  });

  it('repairs the five balanced ripgrep patterns from the latest recorded failures', () => {
    const recorded = [
      String.raw`Write-Host '--- limits ---'; rg -n "plain" .; rg -n "process-manager|from './exec'|from \"./exec\"|fallback" backend/domains/workspace`,
      String.raw`rg -n "type.?=.?['\"]wait|['\"]wait['\"]|Start-Sleep|Sleep" backend/infrastructure/device-control/native/helper.ts test`,
      String.raw`rg -n first .; Write-Host '--- imports ---'; rg -n "from ['\"][^'\"]*(process-manager|patch-files|/patch)\.js['\"]" .`,
      String.raw`rg -n "one" .; rg -n "two" .; rg -n "from './patch/.js'|from \"./patch/.js\"" ./backend`,
      String.raw`rg -n "from ['\"][^'\"]*fsops\.js['\"]" ./backend --glob '!out/**'`
    ];

    for (const command of recorded) {
      const repaired = repairPowerShellQuoting(command, 'powershell');
      expect(repaired.cmd, command).not.toBe(command);
      expect(repaired.notes, command).toHaveLength(1);
      expect(repaired.cmd, command).not.toMatch(/(?:^|\s)"[^"\r\n]*\\"/);
    }

    expect(repairPowerShellQuoting(recorded[4] as string, 'powershell').cmd).toBe(
      String.raw`rg -n 'from [''\x22][^''\x22]*fsops\.js[''\x22]' ./backend --glob '!out/**'`
    );
  });

  it('never introduces a backtick, so the rest of this file still trusts its own parse', () => {
    // A backtick would be a correct PowerShell escape and a silent regression here: hasUnsupportedShellLexemes treats one as unparseable, which would switch off ripgrep binding and the benign-exit exemption for exactly the commands this repair touched.
    for (const command of [WORKER_2_SYMBOL_SWEEP, WORKER_2_IMPORT_SWEEP]) {
      const repaired = repairPowerShellQuoting(command, 'powershell');
      expect(repaired.cmd).not.toContain('`');
      expect(bindBundledRipgrep(repaired.cmd, 'powershell', 'C:\\tools\\rg.exe')).toContain(BOUND_RG);
    }
  });

  it('leaves a command PowerShell can already parse exactly as written', () => {
    // The same backslash-quote, already in the single quotes that make it work. Repairing this would be rewriting a command that was going to succeed.
    const fine = "rg -n 'state === \\\"starting' src";
    expect(repairPowerShellQuoting(fine, 'powershell')).toEqual({ cmd: fine, notes: [] });
    expect(repairPowerShellQuoting('rg -n "plain" src', 'powershell').notes).toHaveLength(0);
    // A balanced backslash before a closing quote is valid PowerShell outside the one ripgrep-pattern slot this repair understands. Do not reinterpret arbitrary shell data.
    const path = String.raw`Write-Output "C:\"; Write-Output done`;
    expect(repairPowerShellQuoting(path, 'powershell')).toEqual({ cmd: path, notes: [] });
    const operand = String.raw`rg -n plain "path\"with\"quotes"`;
    expect(repairPowerShellQuoting(operand, 'powershell')).toEqual({ cmd: operand, notes: [] });
  });

  it('refuses a body whose meaning would change in single quotes', () => {
    // $ is an interpolation single quotes would kill; a backtick is an escape this reading does not model; a doubled backslash is one backslash to bash and two here. Each of these lines is left for the shell to refuse and the hint to explain.
    const interpolated = 'rg -n "$pattern|x === \\"y" src';
    const backticked = 'rg -n "a`tb|x === \\"y" src';
    const doubled = 'rg -n "a\\\\b|x === \\"y" src';
    for (const command of [interpolated, backticked, doubled]) {
      expect(repairPowerShellQuoting(command, 'powershell').cmd).toBe(command);
    }
  });

  it('does not touch a line that is broken for some other reason', () => {
    // A genuinely mismatched quote, from the same corpus: the closing quote landed before the `:` instead of after `maximum`. There is no backslash-quote to move and no way to know what was meant, so it keeps failing loudly.
    const mismatched = 'rg -n "schema|maximum": tunnel-go/server.go | Select-Object -First 30';
    expect(repairPowerShellQuoting(mismatched, 'powershell').cmd).toBe(mismatched);
  });

  it('stays out of a shell that already understands the escape', () => {
    // bash reads the caller's line correctly as written; rewriting it there could only break it.
    expect(repairPowerShellQuoting(WORKER_2_SYMBOL_SWEEP, 'bash').notes).toHaveLength(0);
    expect(repairPowerShellQuoting(WORKER_2_SYMBOL_SWEEP, 'bash').cmd).toBe(WORKER_2_SYMBOL_SWEEP);
  });

  it('uses ripgrep hex escapes for quotes that Windows PowerShell cannot pass literally', () => {
    const call = String.raw`rg -n "state === \"starting" sample.txt`;
    const repaired = repairPowerShellQuoting(call, 'powershell');
    expect(repaired.cmd).toBe(String.raw`rg -n 'state === \x22starting' sample.txt`);
    expect(repaired.notes).toHaveLength(1);
    expect(repaired.notes[0]).toContain('literal double quotes use \\x22');
  });
});

describe('saying that a benign exit was benign', () => {
  it('names the program and both shapes, so the caller does not re-run the search', () => {
    const note = benignExitNote(`${BOUND_RG} -n foo src | Select-Object -First 200`);
    expect(note).toContain('`rg`');
    expect(note).toContain('no matches');
    expect(note).toContain('Select-Object -First');
    expect(withExecNotes('Process exited with code 1\nOutput:\n', [note])).toContain('Note: Exit code 1');
  });

  it('uses POSIX vocabulary for a POSIX no-match result', () => {
    const note = benignExitNote('rg -n foo src', 'bash');
    expect(note).toContain('no matches');
    expect(note).not.toMatch(/Select-Object|PowerShell/);
  });
});

describe('hinting at a refused line', () => {
  it('explains the escape character that caused the parser error', () => {
    const refusal = [
      'The string is missing the terminator: ".',
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
      '    + FullyQualifiedErrorId : TerminatorExpectedAtEndOfString'
    ].join('\n');
    const hints = execRecoveryHints(WORKER_2_SYMBOL_SWEEP, refusal);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('not an escape character in PowerShell');
    expect(hints[0]).toContain('single quotes');
    // The other half of the damage, which the bare parser error never mentions.
    expect(hints[0]).toContain('including any earlier statement on the same line');
  });

  it('does not fire on output that merely mentions a terminator', () => {
    expect(execRecoveryHints('rg -n foo src', 'src/x.ts:4: // the string is missing here')).toHaveLength(0);
  });

  it('does not blame backslash quoting when the command did not contain it, but still explains the parser failure', () => {
    const refusal = [
      'The string is missing the terminator: ".',
      '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException'
    ].join('\n');
    const hints = execRecoveryHints("Write-Output 'unfinished", refusal);
    expect(hints).toHaveLength(1);
    expect(hints[0]).not.toContain('backslash');
    expect(hints[0]).toMatch(/balance the quoted argument/i);
    expect(hints[0]).toMatch(/parsed none/i);
  });
});

