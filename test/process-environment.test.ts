import { describe, expect, it } from 'vitest';
import { buildChildEnvironment } from '../backend/domains/workspace/execution/process-environment.js';

describe('child process environment assembly', () => {
  it('folds Windows names into one key, retains the healthy path, and prioritizes bundled tools', () => {
    const env = buildChildEnvironment({
      source: { Path: 'C:\\Windows\\System32;D:\\Tools', PATH: 'C:\\broken' },
      platform: 'win32',
      ripgrepPath: 'D:\\NEURAFLOK\\resources\\rg\\rg.exe'
    });

    expect(Object.keys(env).filter(name => name.toLowerCase() === 'path')).toEqual(['Path']);
    expect(env.Path).toBe('D:\\NEURAFLOK\\resources\\rg;C:\\Windows\\System32;D:\\Tools;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  });

  it('removes inherited credentials before applying explicit caller values', () => {
    const env = buildChildEnvironment({
      source: { OPENAI_API_KEY: 'parent-secret', safe: 'kept' },
      platform: 'linux',
      ripgrepPath: null,
      overrides: { OPENAI_API_KEY: 'explicit-value' }
    });

    expect(env.OPENAI_API_KEY).toBe('explicit-value');
    expect(env.safe).toBe('kept');
  });

  it('keeps POSIX environment names case-sensitive and leaves its path untouched by Windows defaults', () => {
    const env = buildChildEnvironment({
      source: { PATH: '/usr/bin', Path: '/custom/bin', openai_api_key: 'posix-value' },
      platform: 'linux',
      ripgrepPath: null
    });

    expect(env).toMatchObject({ PATH: '/usr/bin', Path: '/custom/bin', openai_api_key: 'posix-value' });
  });

  it('provides the minimal Windows search path when the parent has none', () => {
    const env = buildChildEnvironment({ source: {}, platform: 'win32', ripgrepPath: null });

    expect(env.PATH).toBe('C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  });

  it('rejects reserved internal names and invalid values before launching a child', () => {
    const options = { source: {}, platform: 'linux' as const, ripgrepPath: null };

    expect(() => buildChildEnvironment({ ...options, overrides: { neuraflok_command: 'blocked' } })).toThrow(/reserved/i);
    expect(() => buildChildEnvironment({ ...options, overrides: { 'BAD NAME': 'value' } })).toThrow(/Invalid environment variable name/);
    expect(() => buildChildEnvironment({ ...options, overrides: { SAFE: 'bad\0value' } })).toThrow(/null byte/);
  });
});
