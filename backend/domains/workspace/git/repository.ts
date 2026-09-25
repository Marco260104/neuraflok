import path from 'node:path';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { isContained } from '../../../infrastructure/settings/sandbox.js';
import { projectFileTarget } from '../file-ops/project-files/target.js';
import { runGit } from './process.js';

export interface RepositoryContext {
  projectId: string;
  projectReal: string;
  root: string;
  gitDir: string;
  commonDir: string;
  prefix: string;
}

export function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function safeProjectPath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.length > 4096 || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return normalized;
}

export function pathWithinProject(value: string, prefix: string): string | null {
  const normalized = safeProjectPath(value);
  if (!normalized) return null;
  if (!prefix) return normalized;
  return normalized.startsWith(`${prefix}/`) ? normalized.slice(prefix.length + 1) : null;
}

export function repositoryFilePath(context: RepositoryContext, relative: string): string {
  return context.prefix ? `${context.prefix}/${relative}` : relative;
}

export async function readRepositoryContext(projectId: string): Promise<RepositoryContext | null> {
  const project = await projectFileTarget(projectId, '', { allowRoot: true });
  const result = await runGit(project.real, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (result.code !== 0) {
    if (/not a git repository/i.test(result.stderr)) return null;
    throw new Error(result.stderr || 'Git repository could not be inspected');
  }
  const lines = decodeUtf8(result.stdout).replaceAll('\r', '').trimEnd().split('\n');
  if (lines.length < 3) throw new Error('Git returned an incomplete repository identity');
  const root = path.resolve(lines[0]!);
  const gitDir = path.resolve(project.real, lines[1]!);
  const commonDir = path.resolve(project.real, lines[2]!);
  const approvedRoots = getConfig().roots.map(entry => path.resolve(entry.path));
  const metadataPaths = [root, gitDir, commonDir];
  if (!metadataPaths.every(candidate => approvedRoots.some(approved => isContained(approved, candidate)))) {
    throw new Error('The Git repository metadata is outside the approved folders');
  }
  const relative = path.relative(root, project.real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The selected project is outside its Git worktree');
  }
  return {
    projectId,
    projectReal: project.real,
    root,
    gitDir,
    commonDir,
    prefix: relative ? relative.split(path.sep).join('/') : ''
  };
}
