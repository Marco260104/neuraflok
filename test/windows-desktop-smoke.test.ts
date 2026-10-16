import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
// @ts-expect-error The smoke utilities are plain Node ESM without declarations.
import { compileElectronProbe } from '../scripts/windows-desktop-smoke/artifacts.mjs';
// @ts-expect-error The smoke runner is a plain Node ESM entry point without declarations.
import { runWindowsDesktopSmoke } from '../scripts/windows-desktop-smoke/run.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('builds the Electron smoke probe with isolated fixture paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'neuraflok-probe-test-'));
  try {
    const probePath = await compileElectronProbe({
      repository,
      directory,
      fixture: { target: 101, popup: 202, invokeX: 310, invokeY: 220 }
    });
    const output = await readFile(probePath, 'utf8');
    expect(output).toContain('Smoke Invoke');
    expect(output).toContain(JSON.stringify(path.join(directory, 'electron-capture.png')));
    expect(output).toContain(JSON.stringify(path.join(directory, 'electron-result.json')));
    expect(output).toContain('MULTILINE_REQUIRES_PASTE');
    expect(output).toContain('tree.split("\\n")');
    expect(output).toContain('text: "a\\nb\\r\\nc"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses to launch the live desktop fixture outside Windows', async () => {
  await expect(runWindowsDesktopSmoke({ platform: 'linux' })).rejects.toThrow('unlocked Windows desktop');
});
