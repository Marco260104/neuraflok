import path from 'node:path';
import type { Stats } from 'node:fs';
import { getConfig } from '../../../../infrastructure/settings/config.js';
import { getProject, projectWorkspace } from '../../projects.js';
import { rawPromises as fs } from '../../rawfs.js';
import { isContained, nativePathIdentity, resolvePath, SandboxError } from '../../../../infrastructure/settings/sandbox.js';
import type { ProjectFileKind } from '../../../../../contracts/workspace/project-files.js';

export function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function recheckTarget(target: Omit<ProjectFileTarget, 'kind'>): Promise<void> {
  const current = await resolveProjectFileTarget(target.projectId, target.path);
  if (!sameRealPath(current.real, target.real) || !sameRealPath(current.projectReal, target.projectReal)) {
    throw new Error('The project file changed location. Reload it before continuing.');
  }
}

/** Re-resolve the owning directory immediately before a pathname mutation. Node does not expose a portable openat/CreateFile-relative API, so pathname syscalls cannot make an OS-wide lock out of this check. Keeping the final parent identity check adjacent to the syscall still prevents stale project/link resolutions in the normal application path and catches a concurrent junction/symlink replacement whenever it is visible before mutation. */
export async function recheckMutationParent(target: Omit<ProjectFileTarget, 'kind'>): Promise<void> {
  const relativeParent = parentPath(target.path);
  const current = await projectFileTarget(target.projectId, relativeParent, { allowRoot: true });
  if (current.kind !== 'directory' || !sameRealPath(current.projectReal, target.projectReal) ||
      !sameRealPath(current.real, path.dirname(target.real))) {
    throw new Error('The project folder changed location. Reload it before continuing.');
  }
}

/** Revalidate an already-resolved Files target at the last practical pathname boundary. */
export async function revalidateProjectFileTarget(target: ProjectFileTarget): Promise<void> {
  await recheckTarget(target);
  await recheckMutationParent(target);
}


export interface ProjectFileTarget {
  projectId: string;
  projectName: string;
  projectReal: string;
  projectVirtual: string;
  path: string;
  real: string;
  kind: ProjectFileKind;
}

function normaliseRelative(input: string): string {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Project path is invalid');
  if (input === '') return '';
  if (/^(?:[/\\]|[A-Za-z]:[\\/]|\\\\)/.test(input)) throw new Error('Project paths must be relative');
  const raw = input.split(/[\\/]/);
  if (raw.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Project path contains an invalid segment');
  }
  return raw.join('/');
}

export function leafName(input: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 255) throw new Error('Name is invalid');
  if (input === '.' || input === '..' || /[\\/\0]/.test(input)) throw new Error('Name must be one file or folder name');
  return input;
}

export function childPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

export function parentPath(relative: string): string {
  const at = relative.lastIndexOf('/');
  return at < 0 ? '' : relative.slice(0, at);
}

export function sameRealPath(left: string, right: string): boolean {
  return nativePathIdentity(left) === nativePathIdentity(right);
}

async function context(projectId: string): Promise<{
  projectName: string;
  real: string;
  virtual: string;
}> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  const workspace = await projectWorkspace(projectId);
  return { projectName: project.name, ...workspace };
}

/** The explorer never follows a link as though it were another project folder. `resolvePath` already prevents escapes from the approved root; this extra walk keeps Files scoped to the explicit LocalProject even when a symlink/junction points to another approved sibling. */
async function assertNoLinkTraversal(projectReal: string, relative: string, allowMissingLeaf: boolean): Promise<void> {
  if (!relative) return;
  let current = projectReal;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Files does not follow symbolic links or junctions');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (allowMissingLeaf && index === parts.length - 1 && code === 'ENOENT') return;
      throw error;
    }
  }
}

export async function resolveProjectFileTarget(
  projectId: string,
  relativeInput: string,
  options: { allowMissing?: boolean; allowRoot?: boolean } = {}
): Promise<Omit<ProjectFileTarget, 'kind'>> {
  const relative = normaliseRelative(relativeInput);
  if (!relative && options.allowRoot === false) throw new Error('The project root cannot be changed');
  const project = await context(projectId);
  if (!relative) {
    return {
      projectId,
      projectName: project.projectName,
      projectReal: project.real,
      projectVirtual: project.virtual,
      path: '',
      real: project.real
    };
  }
  await assertNoLinkTraversal(project.real, relative, options.allowMissing === true);
  const resolved = await resolvePath(getConfig().roots, relative, {
    base: project.virtual,
    allowMissing: options.allowMissing === true
  });
  if (!isContained(project.real, resolved.real)) {
    throw new SandboxError('Path leaves the selected project folder');
  }
  return {
    projectId,
    projectName: project.projectName,
    projectReal: project.real,
    projectVirtual: project.virtual,
    path: relative,
    real: resolved.real
  };
}

async function kindOf(real: string): Promise<ProjectFileKind> {
  const stat = await fs.lstat(real);
  return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
}

export async function projectFileTarget(
  projectId: string,
  relativePath: string,
  options: { allowRoot?: boolean; fileOnly?: boolean } = {}
): Promise<ProjectFileTarget> {
  const target = await resolveProjectFileTarget(projectId, relativePath, { allowRoot: options.allowRoot ?? true });
  const kind = await kindOf(target.real);
  if (options.fileOnly && kind !== 'file') throw new Error('Choose a regular file');
  return { ...target, kind };
}
