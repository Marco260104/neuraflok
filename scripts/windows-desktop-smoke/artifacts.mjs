import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { buildElectronProbeSource } from './electron-probe-source.mjs';

export async function compileDesktopFixture({ repository, directory, runFile }) {
  const framework = path.join(process.env.windir ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const executable = path.join(directory, 'fixture.exe');
  const source = path.join(repository, 'test', 'fixtures', 'windows-desktop', 'capture.cs');
  const wpfReferences = ['WindowsBase.dll', 'PresentationCore.dll', 'PresentationFramework.dll']
    .map(file => `/r:${path.join(framework, 'WPF', file)}`);

  await runFile(path.join(framework, 'csc.exe'), [
    '/nologo',
    '/r:System.Xaml.dll',
    '/r:System.Web.Extensions.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    ...wpfReferences,
    `/out:${executable}`,
    source
  ]);

  return executable;
}

export async function writeNativeHelperScript({ repository, directory }) {
  const result = await build({
    entryPoints: [path.join(repository, 'backend/infrastructure/device-control/native/helper.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  });
  const bundledModule = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const script = path.join(directory, 'helper.ps1');
  await writeFile(script, bundledModule.HELPER_SCRIPT);
  return script;
}

export async function compileElectronProbe({ repository, directory, fixture }) {
  const probePath = path.join(directory, 'electron-probe.cjs');
  const source = buildElectronProbeSource({ repository, directory, fixture });

  await build({
    stdin: { resolveDir: repository, loader: 'ts', contents: source },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: probePath
  });

  return probePath;
}
