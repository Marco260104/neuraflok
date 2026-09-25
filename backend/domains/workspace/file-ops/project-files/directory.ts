import { listDirectoryLevel } from '../reads/directory-reads.js';
import { MAX_DIRECTORY_ENTRIES } from './limits.js';
import { childPath, projectFileTarget } from './target.js';
import type { ProjectDirectoryListing } from '../../../../../contracts/workspace/project-files.js';

/** Repository internals and Finder metadata, hidden in the Files tree as editors do. Core tools still see them. */
const HIDDEN_ENTRIES = new Set(['.git', '.DS_Store']);

export async function listProjectDirectory(projectId: string, relativeDirectory = ''): Promise<ProjectDirectoryListing> {
  const target = await projectFileTarget(projectId, relativeDirectory, { allowRoot: true });
  if (target.kind !== 'directory') throw new Error('Choose a project folder');
  const listed = await listDirectoryLevel(target.real, target.path, MAX_DIRECTORY_ENTRIES, false);
  return {
    projectId,
    projectName: target.projectName,
    directory: target.path,
    entries: listed.entries.filter(entry => !HIDDEN_ENTRIES.has(entry.name)).map(entry => ({
      name: entry.name,
      path: childPath(target.path, entry.name),
      kind: entry.type,
      bytes: entry.bytes
    })),
    truncated: listed.truncated
  };
}
