import type { ProjectGitDiff } from '../../../../contracts/workspace/project-git.js';
import { readRepositoryFile, readWorkingProjectFile } from './files.js';
import { readRepositoryContext } from './repository.js';
import { readProjectGitSnapshot } from './snapshot.js';

export async function readProjectGitDiff(
  projectId: string,
  relativePath: string,
  baseRef?: string,
  expectedRevision?: string
): Promise<ProjectGitDiff> {
  const snapshot = await readProjectGitSnapshot(projectId, baseRef);
  if (snapshot.state !== 'ready') throw new Error(snapshot.message || 'This folder is not a Git repository');
  if (expectedRevision && snapshot.revision !== expectedRevision) throw new Error('The Git comparison changed; refresh Review');
  const change = snapshot.changes.find(entry => entry.path === relativePath);
  if (!change) throw new Error('This file is no longer changed');
  const context = await readRepositoryContext(projectId);
  if (!context) throw new Error('This folder is not a Git repository');
  const base = change.status === 'A' || change.status === 'U'
    ? { text: '', tooLarge: false }
    : await readRepositoryFile(context, change.previousPath ?? change.path, snapshot.comparison?.baseOid);
  const current = change.status === 'D'
    ? { text: '', tooLarge: false }
    : snapshot.comparison
      ? await readRepositoryFile(context, change.path, snapshot.comparison.headOid)
      : await readWorkingProjectFile(projectId, change.path);
  const tooLarge = base.tooLarge || current.tooLarge;
  const binary = change.binary || (!tooLarge && (base.text === null || current.text === null));
  return {
    projectId,
    status: change.status,
    path: change.path,
    previousPath: change.previousPath,
    additions: change.additions,
    deletions: change.deletions,
    binary,
    tooLarge,
    baseText: binary || tooLarge ? null : base.text,
    currentText: binary || tooLarge ? null : current.text,
    note: tooLarge ? 'This diff is too large to display.' : binary ? 'Binary diff · preview unavailable' : undefined
  };
}
