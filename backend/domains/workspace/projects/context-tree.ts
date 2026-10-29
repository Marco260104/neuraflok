import { listProjectDirectory } from '../file-ops/project-files/directory.js';

const MAX_TREE_CHARS = 12_000;
const MAX_TREE_ENTRIES = 300;
const MAX_TREE_DIRECTORIES = 64;
const MAX_TREE_DEPTH = 5;
const OMIT_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
  'node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'coverage', 'generated'
]);
const OMIT_FILES = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;

interface PendingDirectory { path: string; depth: number; }

/** Build a names-only, bounded project outline. It never reads file contents or follows links. */
export async function buildProjectContextTree(projectId: string): Promise<string> {
  const lines = ['.'];
  const pending: PendingDirectory[] = [{ path: '', depth: 0 }];
  let entriesSeen = 0;
  let directoriesSeen = 0;
  let truncated = false;

  while (pending.length) {
    const current = pending.shift()!;
    const listing = await listProjectDirectory(projectId, current.path);
    truncated ||= listing.truncated;
    for (const entry of listing.entries) {
      if (entry.kind === 'other' || OMIT_FILES.test(entry.name)) continue;
      if (entry.kind === 'directory' && OMIT_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (entriesSeen >= MAX_TREE_ENTRIES || lines.join('\n').length + entry.path.length + 8 > MAX_TREE_CHARS) {
        truncated = true;
        break;
      }

      entriesSeen++;
      const indent = '  '.repeat(current.depth + 1);
      lines.push(`${indent}${entry.name}${entry.kind === 'directory' ? '/' : ''}`);
      if (entry.kind !== 'directory') continue;
      if (current.depth >= MAX_TREE_DEPTH || directoriesSeen >= MAX_TREE_DIRECTORIES) {
        truncated = true;
        continue;
      }
      directoriesSeen++;
      pending.push({ path: entry.path, depth: current.depth + 1 });
    }
    if (truncated && (entriesSeen >= MAX_TREE_ENTRIES || lines.join('\n').length >= MAX_TREE_CHARS)) break;
  }

  if (truncated) lines.push('  … project tree shortened; use the project tools to inspect omitted paths.');
  return `PROJECT FILE TREE (names only; bounded):\n${lines.join('\n')}`;
}
