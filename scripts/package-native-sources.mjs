import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNativeSourceInventory } from './native-sources/source-inventory.mjs';
import { prepareVerifiedArchives } from './native-sources/source-archive-cache.mjs';
import { createNativeSourceArchive } from './native-sources/source-release.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');

export async function buildNativeSourceRelease(root = repositoryRoot, options = {}) {
  const { inventory, noticeDirectory } = await loadNativeSourceInventory(root);
  if (options.checkOnly) return { sourceCount: inventory.sources.length, checkOnly: true };

  const archivesDirectory = path.join(root, 'release', 'native-sources', 'archives');
  const onVerified = options.onVerified ?? ((completed, total) => {
    if (completed % 50 === 0) console.log(`Verified ${completed}/${total} source files.`);
  });
  await prepareVerifiedArchives(inventory.sources, archivesDirectory, {
    fetchSource: options.fetchSource,
    concurrency: options.concurrency,
    onVerified
  });

  const archivePath = await createNativeSourceArchive(root, noticeDirectory, inventory);
  return { sourceCount: inventory.sources.length, archivePath, checkOnly: false };
}

async function runCli() {
  const result = await buildNativeSourceRelease(repositoryRoot, { checkOnly: process.argv.includes('--check') });
  if (result.checkOnly) {
    console.log(`Validated ${result.sourceCount} pinned native source inventory entries.`);
    return;
  }
  console.log(`Built ${path.basename(result.archivePath)} with ${result.sourceCount} verified source files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await runCli();
}
