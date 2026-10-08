import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveRipgrep, ripgrepExecutableName, type RipgrepRuntimePaths } from '../backend/infrastructure/binaries/ripgrep.js';

const runtime = (overrides: Partial<RipgrepRuntimePaths> = {}): RipgrepRuntimePaths => ({
  platform: 'linux',
  resourcesDirectory: '/app/electron/resources',
  moduleDirectory: '/app/out/main',
  inheritedDirectories: ['/tools'],
  ...overrides
});

describe('ripgrep runtime resolution', () => {
  it('selects the platform executable name', () => {
    expect(ripgrepExecutableName('win32')).toBe('rg.exe');
    expect(ripgrepExecutableName('darwin')).toBe('rg');
    expect(ripgrepExecutableName('linux')).toBe('rg');
  });

  it('prefers the packaged runtime over development and inherited copies', () => {
    const locations = runtime();
    const packaged = path.join(locations.resourcesDirectory!, 'rg', 'rg');
    const development = path.resolve(locations.moduleDirectory, '..', '..', 'resources', 'rg', 'rg');
    const inherited = path.join(locations.inheritedDirectories[0]!, 'rg');
    const available = new Set([packaged, development, inherited]);

    expect(resolveRipgrep(locations, candidate => available.has(candidate))).toBe(packaged);
  });

  it('uses the development copy before searching inherited directories', () => {
    const locations = runtime({ resourcesDirectory: null });
    const development = path.resolve(locations.moduleDirectory, '..', '..', 'resources', 'rg', 'rg');
    const inherited = path.join(locations.inheritedDirectories[0]!, 'rg');
    const check = vi.fn((candidate: string) => candidate === development || candidate === inherited);

    expect(resolveRipgrep(locations, check)).toBe(development);
    expect(check.mock.calls.map(([candidate]) => candidate)).toEqual([development]);
  });

  it('uses a quoted inherited path as the final fallback', () => {
    const locations = runtime({ resourcesDirectory: null, inheritedDirectories: ['  "/custom tools"  '] });
    const inherited = path.join('/custom tools', 'rg');

    expect(resolveRipgrep(locations, candidate => candidate === inherited)).toBe(inherited);
  });

  it('returns no executable when every candidate fails validation', () => {
    expect(resolveRipgrep(runtime(), () => false)).toBeNull();
  });
});
