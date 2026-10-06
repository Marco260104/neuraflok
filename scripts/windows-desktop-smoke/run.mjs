import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDesktopFixture, compileElectronProbe, writeNativeHelperScript } from './artifacts.mjs';
import { verifyComposedCapture, verifyMinimizedCaptureFailure, verifyNativeWindowCapture } from './capture-checks.mjs';
import { verifyClipboardPaste, verifyTextInput } from './input-checks.mjs';
import { createProcessSupervisor } from './processes.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function createElectronRunner({ supervisor, executable, probe, directory }) {
  const resultPath = path.join(directory, 'electron-result.json');

  return async operation => {
    try {
      await supervisor.runFile(executable, [probe, operation]);
    } catch (error) {
      const details = await readFile(resultPath, 'utf8').catch(() => '');
      if (details) throw new Error(`Electron probe failed: ${details}`);
      throw error;
    }
    return JSON.parse(await readFile(resultPath, 'utf8'));
  };
}

export async function runWindowsDesktopSmoke({ args = process.argv.slice(2), platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('This smoke requires an unlocked Windows desktop.');

  const directory = await mkdtemp(path.join(tmpdir(), 'neuraflok-desktop-smoke-'));
  const supervisor = createProcessSupervisor();
  const softwareFixture = args.includes('--software-fixture');

  try {
    const [fixtureExecutable, helperScript] = await Promise.all([
      compileDesktopFixture({ repository, directory, runFile: supervisor.runFile }),
      writeNativeHelperScript({ repository, directory })
    ]);
    const fixtureArgs = softwareFixture ? ['--software'] : [];
    const fixture = supervisor.launchJsonProcess(fixtureExecutable, fixtureArgs);
    const windows = await fixture.read();
    assert.ok(windows.target > 0, `Fixture was not ready: ${JSON.stringify(windows)}`);

    const foregroundFixture = supervisor.launchJsonProcess(fixtureExecutable, fixtureArgs);
    const foregroundWindows = await foregroundFixture.read();
    assert.ok(foregroundWindows.target > 0, 'Foreground fixture was not ready');

    const electronProbe = await compileElectronProbe({ repository, directory, fixture: windows });
    const electronExecutable = createRequire(import.meta.url)('electron');
    const runElectron = await createElectronRunner({
      supervisor,
      executable: electronExecutable,
      probe: electronProbe,
      directory
    });

    const composed = await verifyComposedCapture({
      runElectron,
      fixture,
      foregroundFixture,
      windows,
      directory,
      repository
    });
    const nativeCapture = await verifyNativeWindowCapture({
      supervisor,
      helperScript,
      fixture,
      windows,
      directory
    });
    const minimized = await verifyMinimizedCaptureFailure({
      request: nativeCapture.request,
      fixture,
      target: windows.target,
      imagePath: nativeCapture.imagePath
    });
    const input = await verifyTextInput({ request: nativeCapture.request, fixture, target: windows.target });
    const paste = await verifyClipboardPaste({ runElectron, fixture });

    const summary = {
      fixtureRendering: softwareFixture ? 'wpf-software' : 'wpf-default-hardware-eligible',
      capturePassed: true,
      nativeInputPassed: true,
      windowsApi: {
        ...composed.result.windowsApi,
        semanticAndCoordinateInvocationVerified: composed.invocationReport.invocations === 2
      },
      captureMs: nativeCapture.captureMs,
      image: nativeCapture.image,
      region: nativeCapture.region,
      windowGeometry: nativeCapture.windowGeometry,
      foregroundPreserved: true,
      composedFrame: composed.result.screenshot.frameId,
      relatedFrame: composed.popupImage.screenshot.frameId,
      unrelatedWindowExcluded: true,
      minimizedError: minimized.error_code,
      multilineError: input.multilineError,
      paste
    };

    await fixture.request('quit');
    return summary;
  } finally {
    await supervisor.stopAll();
    await rm(directory, { recursive: true, force: true });
  }
}
