import { describe, expect, it } from 'vitest';
// @ts-expect-error The planner is a plain Node script without type declarations.
import { planFailFirst, runnerForFailFirst } from '../scripts/pr-fail-first.mjs';

const plan = planFailFirst as (nameStatus: string) => { tests: string[]; restore: string[]; remove: string[] };
const runner = runnerForFailFirst as (nameStatus: string) => string;

describe('fail-first proof plan', () => {
  it('identifies tests that require a Windows runner for local maintainer validation', () => {
    expect(runner('M\ttest/windows-capture.test.ts')).toBe('windows-2025');
    expect(runner('M\ttest/ordinary.test.ts')).toBe('ubuntu-24.04');
  });

  it.each(['windows-capture', 'computer', 'computer-own-windows', 'computer-windows-input'])(
    'runs changed %s native tests on Windows instead of treating skipped Linux tests as proof', name => {
      expect(runner(`M\ttest/${name}.test.ts`)).toBe('windows-2025');
    }
  );

  it('keeps ordinary tests on Linux and ignores removed or support-only Windows files', () => {
    expect(runner('M\ttest/projects.test.ts\nD\ttest/windows-capture.test.ts\nM\ttest/fixtures/windows-desktop/capture.cs')).toBe('ubuntu-24.04');
    expect(runner('M\tbackend/infrastructure/device-control/native/windows-capture.ts\nM\tAGENTS.md')).toBe('ubuntu-24.04');
  });

  it('uses the destination of a renamed test when selecting the native runner', () => {
    expect(runner('R100\ttest/old.test.ts\ttest/windows-capture.test.ts')).toBe('windows-2025');
    expect(runner('R100\ttest/windows-capture.test.ts\ttest/ordinary.test.ts')).toBe('ubuntu-24.04');
  });

  it('runs changed tests against base code: restores changed code and removes added code', () => {
    expect(plan([
      'M\tbackend/domains/browser/bridge.ts',
      'A\tbackend/new-owner.ts',
      'M\ttest/bridge.test.ts',
      'A\ttest/new-owner.test.ts',
      'M\tAGENTS.md',
      'M\tfrontend/locales/de.json'
    ].join('\n'))).toEqual({
      tests: ['test/bridge.test.ts', 'test/new-owner.test.ts'],
      restore: ['backend/domains/browser/bridge.ts', 'frontend/locales/de.json'],
      remove: ['backend/new-owner.ts']
    });
  });

  it('keeps test support code and deleted files out, and follows renames', () => {
    expect(plan([
      'M\tscripts/verify-chat-switch.cjs',
      'M\tscripts/fixtures/composer-ui.js',
      'D\tbackend/old.ts',
      'R087\tbackend/a.ts\tbackend/b.ts',
      'M\ttest/helpers.ts'
    ].join('\n'))).toEqual({ tests: [], restore: ['backend/a.ts'], remove: ['backend/b.ts'] });
  });
});
