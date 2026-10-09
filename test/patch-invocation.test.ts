import { describe, expect, it } from 'vitest';

import {
  maybeParseApplyPatch,
  maybeParseApplyPatchForExec
} from '../backend/domains/workspace/execution/apply-patch/invocation.js';

const patch = ['*** Begin Patch', '*** Add File: foo', '+hi', '*** End Patch'].join('\n');
const heredoc = (prefix = '', suffix = '') => `${prefix}apply_patch <<'PATCH'\n${patch}\nPATCH${suffix}`;

describe('Patch command interception', () => {
  const posixCwd = '/workspace';
  const windowsCwd = 'C:\\workspace';

  it('recognizes direct apply_patch and applypatch invocations', () => {
    for (const command of ['apply_patch', 'applypatch']) {
      const result = maybeParseApplyPatch([command, patch], posixCwd);
      expect(result.kind).toBe('body');
      if (result.kind === 'body') expect(result.args.hunks).toHaveLength(1);
    }
  });

  it('recognizes supported shell wrappers', () => {
    for (const argv of [
      ['bash', '-lc', heredoc()],
      ['bash', '-c', heredoc()],
      ['powershell.exe', '-Command', heredoc()],
      ['powershell.exe', '-NoProfile', '-Command', heredoc()],
      ['pwsh.exe', '-Command', heredoc()],
      ['cmd.exe', '/c', heredoc()]
    ]) {
      const result = maybeParseApplyPatch(argv, windowsCwd);
      expect(result.kind, argv.join(' ')).toBe('body');
    }
  });

  it('extracts the optional cd workdir including quoted spaces', () => {
    for (const [prefix, expected] of [
      ['cd foo && ', 'foo'],
      ["cd 'foo bar' && ", 'foo bar'],
      ['cd "foo bar" && ', 'foo bar']
    ] as const) {
      const result = maybeParseApplyPatch(['bash', '-lc', heredoc(prefix)], posixCwd);
      expect(result.kind).toBe('body');
      if (result.kind === 'body') expect(result.args.workdir).toBe(expected);
    }
  });

  it('rejects ambiguous multi-command scripts', () => {
    for (const script of [
      heredoc('cd foo; '),
      heredoc('cd bar || '),
      heredoc('cd bar | '),
      heredoc('echo foo && '),
      heredoc('cd foo && cd bar && '),
      heredoc('cd foo bar && '),
      heredoc('echo foo; cd bar && '),
      heredoc('cd bar && ', ' && echo done'),
      `apply_patch foo <<'PATCH'\n${patch}\nPATCH`
    ]) {
      expect(maybeParseApplyPatch(['bash', '-lc', script], posixCwd).kind, script).toBe('not_apply_patch');
    }
  });

  it('accepts unquoted delimiters and Windows line endings', () => {
    const script = `apply_patch <<PATCH\r\n${patch.replace(/\n/g, '\r\n')}\r\nPATCH`;
    expect(maybeParseApplyPatch(['bash', '-lc', script], posixCwd).kind).toBe('body');
  });

  it('accepts shell spacing, numeric delimiters, and quoted labels with spaces', () => {
    for (const [header, delimiter] of [
      ['apply_patch << PATCH', 'PATCH'],
      ['apply_patch<<PATCH_2', 'PATCH_2'],
      ['apply_patch << 7', '7'],
      ['apply_patch << "patch body"', 'patch body']
    ] as const) {
      const result = maybeParseApplyPatch(['bash', '-lc', `${header}\n${patch}\n${delimiter}`], posixCwd);
      expect(result.kind).toBe('body');
    }
  });

  it('reports raw patch bodies as an implicit invocation correctness error', () => {
    const direct = maybeParseApplyPatchForExec([patch], posixCwd);
    expect(direct.kind).toBe('correctness_error');
    if (direct.kind === 'correctness_error') {
      expect(direct.error.message).toBe(
        'patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
      );
    }

    const shell = maybeParseApplyPatchForExec(['bash', '-lc', patch], posixCwd);
    expect(shell.kind).toBe('correctness_error');
  });
});
