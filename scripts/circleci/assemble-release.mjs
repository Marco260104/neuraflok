import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseTargets } from '../release-targets.mjs';
import { verifyReleaseAssets } from '../verify-release-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function option(name, fallback) {
  const exact = process.argv.find(value => value.startsWith(`--${name}=`));
  return exact ? exact.slice(name.length + 3) : fallback;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function assembleRelease({ scope = 'all', includeNativeSources = scope === 'all', tag = process.env.CIRCLE_TAG } = {}) {
  if (!tag) throw new Error('CIRCLE_TAG or an explicit tag is required to assemble release assets.');
  const selected = releaseTargets(scope);
  const installerFiles = [];
  const releaseDir = path.join(root, 'release');
  const artifactRoot = path.join(root, 'ci-artifacts');
  await mkdir(releaseDir, { recursive: true });

  for (const target of selected.include) {
    const artifactDir = `${target.platform}-${target.arch}`;
    for (const relative of target.files.split('\n')) {
      const name = path.basename(relative);
      const source = path.join(artifactRoot, artifactDir, name);
      const destination = path.join(releaseDir, name);
      if (!existsSync(source)) throw new Error(`CircleCI workspace is missing ${name}.`);
      await rm(destination, { force: true });
      await copyFile(source, destination);
      installerFiles.push(name);
    }
  }

  const extensionZip = path.join(releaseDir, 'NEURAFLOK-Provider-Extension.zip');
  await rm(extensionZip, { force: true });
  execFileSync(process.execPath, ['scripts/packaging/extension-fingerprint.mjs'], { cwd: root, stdio: 'inherit' });
  execFileSync('zip', ['-qr', extensionZip, '.', '-x', '*.map', '**/*.map'], {
    cwd: path.join(root, 'browser-extension'),
    stdio: 'inherit'
  });

  const files = [...installerFiles, 'NEURAFLOK-Provider-Extension.zip'];
  if (includeNativeSources) {
    execFileSync(process.execPath, ['scripts/package-native-sources.mjs'], { cwd: root, stdio: 'inherit' });
    files.push('NEURAFLOK-Native-Sources.tar.gz');
  }

  const checksums = [];
  for (const name of files) {
    const file = path.join(releaseDir, name);
    if (!existsSync(file)) throw new Error(`Release assembly did not produce ${name}.`);
    checksums.push(`${await sha256(file)}  ${name}`);
  }
  await writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);

  if (scope === 'all' && includeNativeSources) {
    const problems = await verifyReleaseAssets({ dir: releaseDir, tag });
    if (problems.length) throw new Error(problems.join('\n'));
  }
  process.stdout.write(`${tag}: assembled ${files.length} assets for the ${scope} release.\n`);
  return { files: [...files, 'SHA256SUMS.txt'], releaseDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = option('scope', 'all');
  const includeNativeSources = option('include-native', scope === 'all' ? 'true' : 'false') === 'true';
  const tag = option('tag', process.env.CIRCLE_TAG);
  assembleRelease({ scope, includeNativeSources, tag }).catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
