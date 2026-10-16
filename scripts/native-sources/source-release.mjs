import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const RELEASE_FILES = [
  'sources.json',
  'README.md',
  'SOURCE-BUILD.md',
  'COMPONENT-NOTICES.txt',
  'LGPL-3.0.txt',
  'GPL-3.0.txt',
  'MPL-2.0.txt'
];

async function writeReleaseManifest(releaseRoot, outputDirectory, noticeDirectory, inventory) {
  for (const filename of RELEASE_FILES) {
    await fs.copyFile(path.join(noticeDirectory, filename), path.join(outputDirectory, filename));
  }

  const checksumRows = inventory.sources.map(source => `${source.sha256}  archives/${source.file}`);
  await fs.writeFile(path.join(outputDirectory, 'SHA256SUMS.txt'), `${checksumRows.join('\n')}\n`);

  const packagedFiles = [
    ...RELEASE_FILES,
    'SHA256SUMS.txt',
    ...inventory.sources.map(source => `archives/${source.file}`)
  ];
  const fileList = path.join(releaseRoot, 'native-source-files.txt');
  await fs.writeFile(fileList, `${packagedFiles.join('\n')}\n`);
  return fileList;
}

function createTarball(archivePath, outputDirectory, fileList) {
  const executable = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const result = spawnSync(executable, ['-czf', archivePath, '-C', outputDirectory, '-T', fileList], {
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native source archive failed: ${result.status}`);
}

export async function createNativeSourceArchive(root, noticeDirectory, inventory) {
  const releaseRoot = path.join(root, 'release');
  const outputDirectory = path.join(releaseRoot, 'native-sources');
  const archivesDirectory = path.join(outputDirectory, 'archives');
  const archivePath = path.join(releaseRoot, 'NEURAFLOK-Native-Sources.tar.gz');
  await fs.mkdir(archivesDirectory, { recursive: true });
  const fileList = await writeReleaseManifest(releaseRoot, outputDirectory, noticeDirectory, inventory);
  try {
    createTarball(archivePath, outputDirectory, fileList);
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    throw error;
  }
  return archivePath;
}
