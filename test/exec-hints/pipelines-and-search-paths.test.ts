import { BOUND_RG } from './context.js';

import { execFileSync } from 'node:child_process';
import { benignExitNote, execRecoveryHints, nonZeroExitIsBenign } from "../../backend/domains/workspace/exec-hints.js";
import { describe, expect, it } from 'vitest';

describe('a pipeline stopped early by Select-Object -First', () => {
  // Verbatim from a worker's session: the diff printed 383 lines and the call was still filed as an error, so the model ran it again.
  const WORKER_1_DIFF_CUT =
    "Select-String -Path docs/bug-audit-2026-08-24.md -Pattern 'DONE|SSE' -Context 2,3; " +
    'git diff -- test/agents.test.ts test/goal.test.ts backend/domains/automation/agents.ts backend/domains/automation/goal.ts | ' +
    'Select-Object -First 220';
  const DIFF_OUTPUT = ['diff --git a/backend/domains/automation/goal.ts b/backend/domains/automation/goal.ts', '@@ -1,4 +1,4 @@', '-const a = 1;'].join('\n');

  it('is benign when the generator is a git command that only reports', () => {
    expect(nonZeroExitIsBenign(WORKER_1_DIFF_CUT, 1, DIFF_OUTPUT)).toBe(true);
  });

  it('says the cut caused it and names the flag that keeps the status meaningful', () => {
    const note = benignExitNote(WORKER_1_DIFF_CUT);
    expect(note).toContain('Select-Object -First');
    expect(note).toContain('`git`');
    expect(note).toContain('-Wait');
    // The no-match wording belongs to the search shape and would be a lie about git.
    expect(note).not.toContain('no matches');
  });

  it('explains the status the cut actually left behind', () => {
    const note = benignExitNote(WORKER_1_DIFF_CUT, 'powershell', -1, DIFF_OUTPUT);
    expect(note).toContain('Exit code -1');
    expect(note).not.toContain('Exit code 1 ');
  });

  it('recognises the cut whichever status Windows left behind', () => {
    const output = 'Process exited with code -1\nOutput:\nsrc/main.ts:12:  const max = 20\n';
    const cut = `${BOUND_RG} -n "max" src | Select-Object -First 40`;
    for (const exitCode of [1, -1, 4_294_967_295]) {
      expect(nonZeroExitIsBenign(cut, exitCode, output)).toBe(true);
    }
    expect(nonZeroExitIsBenign(cut, 3, output)).toBe(false);
  });

  it('does not read a cut pipeline over a search that printed a diagnostic', () => {
    const output =
      'Process exited with code 1\nOutput:\nsrc/main.ts:12:  const max = 20\n' +
      'rg: src/typo.ts: No such file or directory (os error 2)\n';
    const cut = `${BOUND_RG} -n "max" src src/typo.ts | Select-Object -First 40`;
    expect(nonZeroExitIsBenign(cut, 1, output)).toBe(false);
  });

  it('calls an empty search result no matches even when a cut could also explain it', () => {
    const empty = 'Wall time: 0.0100 seconds\nProcess exited with code 1\nOutput:\n';
    const note = benignExitNote(`${BOUND_RG} -n foo src | Select-Object -First 200`, 'powershell', 1, empty);
    expect(note).toContain('no matches');
    expect(note).not.toContain('-Wait');
  });

  // Every negative below is the direction this must fail towards: a real failure recorded as a failure. The first is the one that would do the most damage.
  it('is not benign when the cut program is a test run that genuinely failed', () => {
    const output = ['RUN v4.1.10', 'x does not publish a handoff 15ms', 'AssertionError: expected'].join('\n');
    expect(nonZeroExitIsBenign('npm test -- --run test/goal.test.ts | Select-Object -First 120', 1, output)).toBe(false);
    expect(nonZeroExitIsBenign('npx vitest run test/goal.test.ts | Select-Object -First 40', 1, output)).toBe(false);
    expect(nonZeroExitIsBenign('node scripts/check.js | Select-Object -First 40', 1, output)).toBe(false);
  });

  it('is not benign when a flag has spent the exit code on an answer', () => {
    for (const flag of ['--exit-code', '--quiet', '--check']) {
      expect(nonZeroExitIsBenign(`git diff ${flag} -- src | Select-Object -First 220`, 1, DIFF_OUTPUT)).toBe(false);
    }
  });

  it('is not benign for a git subcommand that can fail after printing', () => {
    expect(nonZeroExitIsBenign('git apply --stat patch.diff | Select-Object -First 20', 1, DIFF_OUTPUT)).toBe(false);
    expect(nonZeroExitIsBenign('git push origin main | Select-Object -First 20', 1, DIFF_OUTPUT)).toBe(false);
  });

  it('is not benign without the stage that actually stops the pipeline', () => {
    expect(nonZeroExitIsBenign('git diff -- src', 1, DIFF_OUTPUT)).toBe(false);
    // -Last has to drain the pipeline to know what the last N are, so it never cuts anything.
    expect(nonZeroExitIsBenign('git diff -- src | Select-Object -Last 220', 1, DIFF_OUTPUT)).toBe(false);
    expect(nonZeroExitIsBenign('git diff -- src | Sort-Object', 1, DIFF_OUTPUT)).toBe(false);
  });

  it('is not benign when a stage between the two could have set the status itself', () => {
    expect(
      nonZeroExitIsBenign('git diff -- src | Where-Object { $_ -match "x" } | Select-Object -First 5', 1, DIFF_OUTPUT)
    ).toBe(false);
  });

  it('is not benign when nothing was printed, or when git printed a failure of its own', () => {
    expect(nonZeroExitIsBenign('git diff -- src | Select-Object -First 220', 1, '')).toBe(false);
    expect(
      nonZeroExitIsBenign('git diff -- src | Select-Object -First 220', 1, 'fatal: not a git repository')
    ).toBe(false);
  });

  it('withholds the exemption from a form whose subcommand it cannot prove', () => {
    // `git -C dir diff` reads the same to a person. Proving which token is the subcommand means knowing which of git's own options take a value, and being wrong is how `--exit-code` would slip through.
    expect(nonZeroExitIsBenign('git -C sub diff -- src | Select-Object -First 220', 1, DIFF_OUTPUT)).toBe(false);
  });

  it('leaves an exit code other than 1 alone', () => {
    expect(nonZeroExitIsBenign('git diff -- src | Select-Object -First 220', 2, DIFF_OUTPUT)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('is what the shell really does with a cut pipeline', () => {
    const run = (command: string): number => {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe']
        });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    };

    // One native process writes past the selection limit so the pipeline is cut while it is still running.
    const generator = 'cmd /c "for /l %i in (1,1,20000) do @echo line%i"';
    expect(run(`${generator} | Select-Object -First 5 | Out-Null`)).not.toBe(0);
    // -Wait drains the pipeline instead of stopping its producer.
    expect(run(`${generator} | Select-Object -First 5 -Wait | Out-Null`)).toBe(0);
  }, 120_000);
});

describe('git grep, which spends exit 1 on "found nothing" like every other search', () => {
  // Verbatim shape from the corpus: three git commands in one batch, the last of them a `git grep` that matched nothing, and the whole call stored as an error. `git` is not a name a search table can hold — exit 1 from `git diff` means the opposite — so the subcommand is what has to be read, in the one position it can be read from safely.
  const NO_MATCH = 'git grep -n -i "edge-triggered" -- AGENTS.md';

  it('is a result, not a failure', () => {
    expect(nonZeroExitIsBenign(NO_MATCH, 1, '')).toBe(true);
    expect(nonZeroExitIsBenign('git grep -n foo | Select-Object -First 40', 1, '')).toBe(true);
  });

  it('needs no path-qualified spelling, because -NoProfile leaves nothing to impersonate it', () => {
    // A bare `rg` is refused for exactly this reason: a profile function can answer to the name. exec.ts launches every command through `powershell -NoProfile`, and no profile function can then be answering to `git`.
    expect(nonZeroExitIsBenign('rg -n foo src', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('git grep -n foo', 1, '')).toBe(true);
  });

  it('names the subcommand in the note, so the exemption cannot be read as covering git', () => {
    const note = benignExitNote(NO_MATCH, 'powershell', 1, '');
    expect(note).toContain('`git grep`');
    expect(note).toContain('no matches');
  });

  // The negatives are the ones that matter: each is a real failure this must keep recording.
  it('is not benign for a git subcommand whose exit 1 means something else', () => {
    for (const cmd of ['git diff --check -- AGENTS.md', 'git apply patch.diff', 'git push origin main']) {
      expect(nonZeroExitIsBenign(cmd, 1, '')).toBe(false);
    }
  });

  it('is not benign when a flag has already spent the exit code on an answer', () => {
    for (const flag of ['--quiet', '--exit-code']) {
      expect(nonZeroExitIsBenign(`git grep ${flag} foo -- src`, 1, '')).toBe(false);
    }
  });

  it('does not let a later git stage hide behind the generator it decided over', () => {
    // The whole reason the deciding stage has to *be* the generator. Reading the subcommand off the front while git's predicate ran at the back would file that failure as a search that found nothing — the exact laundering this file exists to prevent.
    expect(nonZeroExitIsBenign('git grep -n foo | git diff --exit-code', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('git grep -n foo | Where-Object { $_ -match "x" }', 1, '')).toBe(false);
  });

  it('withholds the exemption from a form whose subcommand it cannot prove', () => {
    expect(nonZeroExitIsBenign('git -C sub grep -n foo', 1, '')).toBe(false);
    expect(nonZeroExitIsBenign('cmd /c exit 1 && git grep -n foo', 1, '')).toBe(false);
  });

  it('is not benign when git printed a failure of its own, or exited some other way', () => {
    expect(nonZeroExitIsBenign(NO_MATCH, 1, 'fatal: not a git repository')).toBe(false);
    expect(nonZeroExitIsBenign(NO_MATCH, 128, '')).toBe(false);
    expect(nonZeroExitIsBenign(NO_MATCH, 2, '')).toBe(false);
  });
});

describe('hinting at a search path that does not exist', () => {
  const PARTIAL = [
    'rg: backend/domains/workspace/execution/workspace.ts: The system cannot find the file specified. (os error 2)',
    'backend/domains/workspace/workspace.ts:67: export function workspaceKey(): string | null {'
  ].join('\n');

  it('preserves useful matches without claiming the requested search was complete', () => {
    const hints = execRecoveryHints('rg -n "workspaceKey" backend/domains/workspace/execution/workspace.ts backend/domains/workspace/workspace.ts', PARTIAL);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('does not exist');
    expect(hints[0]).toContain('incomplete');
    expect(hints[0]).not.toContain('complete answer');
  });

  it('does not take over the unexpanded-glob case, which is a different error', () => {
    const glob = 'rg: test/*agent*: The filename, directory name, or volume label syntax is incorrect. (os error 123)';
    const hints = execRecoveryHints('rg -n "message.id" test/*agent*', glob);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('does not expand');
  });

  it('does not fire on a match whose text happens to mention the error', () => {
    const line = 'backend/domains/workspace/exec-hints.ts:44: // grep: os error 2 is a missing path';
    expect(execRecoveryHints('rg -n "os error" src', line)).toHaveLength(0);
  });
});

