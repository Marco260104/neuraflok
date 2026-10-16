import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { rawPromises as fs } from '../../rawfs.js';
import { MAX_PREVIEW_BYTES } from './limits.js';
import { previewProjectFile } from './preview.js';
import { textSnapshot } from './text-snapshot.js';
import { childPath, leafName, parentPath, projectFileTarget, recheckMutationParent, revalidateProjectFileTarget, resolveProjectFileTarget, sameRealPath } from './target.js';
import { isContained, nativePathIdentity, SandboxError } from '../../../../infrastructure/settings/sandbox.js';
import type { ProjectFileMutationResult, ProjectFileSaveResult } from '../../../../../contracts/workspace/project-files.js';

const activeSaves = new Set<string>();

export async function createProjectEntry(
  projectId: string,
  relativeDirectory: string,
  nameInput: string,
  kind: 'file' | 'directory'
): Promise<ProjectFileMutationResult> {
  const directory = await projectFileTarget(projectId, relativeDirectory, { allowRoot: true });
  if (directory.kind !== 'directory') throw new Error('Choose a project folder');
  const name = leafName(nameInput);
  const relative = childPath(directory.path, name);
  const target = await resolveProjectFileTarget(projectId, relative, { allowMissing: true, allowRoot: false });
  try {
    await fs.lstat(target.real);
    throw new Error('A file or folder with that name already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await recheckMutationParent(target);
  const currentTarget = await resolveProjectFileTarget(projectId, relative, { allowMissing: true, allowRoot: false });
  if (!sameRealPath(currentTarget.projectReal, target.projectReal) || !sameRealPath(currentTarget.real, target.real)) {
    throw new Error('The project folder changed location. Reload it before continuing.');
  }
  if (kind === 'directory') await fs.mkdir(target.real);
  else {
    const handle = await fs.open(target.real, 'wx');
    await handle.close();
  }
  return { projectId, path: relative, kind };
}

export async function renameProjectEntry(
  projectId: string,
  relativePath: string,
  nameInput: string
): Promise<ProjectFileMutationResult> {
  const source = await projectFileTarget(projectId, relativePath, { allowRoot: false });
  if (source.kind !== 'file' && source.kind !== 'directory') throw new Error('Only regular files and folders can be renamed');
  const name = leafName(nameInput);
  const relative = childPath(parentPath(source.path), name);
  if (relative === source.path) return { projectId, path: source.path, kind: source.kind };
  const destination = await resolveProjectFileTarget(projectId, relative, { allowMissing: true, allowRoot: false });
  const lexicalDestination = path.join(path.dirname(source.real), name);
  if (!isContained(source.projectReal, lexicalDestination)) throw new SandboxError('Path leaves the selected project folder');
  if (!sameRealPath(source.real, lexicalDestination)) {
    try {
      await fs.lstat(lexicalDestination);
      throw new Error('A file or folder with that name already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await revalidateProjectFileTarget(source);
  await recheckMutationParent(destination);
  const currentDestination = await resolveProjectFileTarget(projectId, relative, { allowMissing: true, allowRoot: false });
  if (!sameRealPath(currentDestination.projectReal, destination.projectReal) ||
      !sameRealPath(currentDestination.real, destination.real)) {
    throw new Error('The project folder changed location. Reload it before continuing.');
  }
  // The sandbox resolution above validates the new spelling even when a Windows case-only rename resolves back to the existing file identity. Use the sibling spelling for rename so the requested case is not lost to realpath canonicalisation.
  await fs.rename(source.real, lexicalDestination);
  return { projectId, path: relative, kind: source.kind };
}

/** Stage a complete replacement before the final identity/content check and atomic rename. */
export async function saveProjectTextFile(
  projectId: string,
  relativePath: string,
  text: string,
  expectedModifiedAt: string,
  expectedBytes: number,
  expectedRevision: string
): Promise<ProjectFileSaveResult> {
  const encodedBytes = Buffer.byteLength(text, 'utf8');
  if (encodedBytes > MAX_PREVIEW_BYTES) {
    throw new Error(`Edited files must be ${MAX_PREVIEW_BYTES} bytes or smaller`);
  }
  const target = await projectFileTarget(projectId, relativePath, { allowRoot: false, fileOnly: true });
  const key = nativePathIdentity(target.real);
  if (activeSaves.has(key) || activeSaves.size >= 32) throw new Error('A file save is already in progress. Try again when it finishes.');
  activeSaves.add(key);
  const temporary = path.join(path.dirname(target.real), `.neuraflok-save-${randomUUID()}.tmp`);
  let staged: Stats | null = null;
  try {
    const original = await textSnapshot(target);
    if (original.revision !== expectedRevision || original.data.length !== expectedBytes || original.stat.mtime.toISOString() !== expectedModifiedAt) {
      throw new Error('File changed on disk. Reload it before saving your edits.');
    }
    await recheckMutationParent(target);
    const handle = await fs.open(temporary, 'wx', original.stat.mode & 0o777);
    try {
      staged = await handle.stat();
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
    } finally { await handle.close(); }
    const latest = await textSnapshot(target);
    if (latest.revision !== original.revision) throw new Error('File changed on disk. Reload it before saving your edits.');
    await recheckMutationParent(target);
    // There is no truncation of the original. Write/flush/rename failures retain its bytes.
    await fs.rename(temporary, target.real);
    staged = null;
    return { preview: await previewProjectFile(projectId, relativePath) };
  } finally {
    activeSaves.delete(key);
    if (staged) {
      const owned = staged;
      await fs.lstat(temporary).then(async current => {
        if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(temporary);
      }).catch(() => undefined);
    }
  }
}
