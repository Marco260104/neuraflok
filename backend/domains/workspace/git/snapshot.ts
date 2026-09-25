import { createHash } from 'node:crypto';
import type { ProjectGitChange, ProjectGitSnapshot } from '../../../../contracts/workspace/project-git.js';
import { MAX_GIT_CHANGES, MAX_GIT_TEXT_BYTES, GIT_STAT_BATCH_SIZE } from './limits.js';
import { readProjectBytes } from './files.js';
import { decodeUtf8, readRepositoryContext } from './repository.js';
import { readBranchIdentity, parseCommittedChanges, parseLineStatistics, parseWorktreeChanges, repositoryHasHead } from './records.js';
import { runGit } from './process.js';

function failedSnapshot(projectId: string, message: string): ProjectGitSnapshot {
  return { projectId, state: 'unavailable', changes: [], truncated: false, revision: '', message };
}

async function statsForNewFile(projectId: string, relative: string) {
  try {
    const result = await readProjectBytes(projectId, relative, MAX_GIT_TEXT_BYTES);
    const binary = result.bytes.includes(0);
    if (binary) return { additions: null, deletions: null, binary: true };
    if (result.tooLarge) return { additions: null, deletions: null, binary: false };
    const text = decodeUtf8(result.bytes);
    const lines = text.length === 0 ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
    return { additions: lines, deletions: 0, binary: false };
  } catch {
    return { additions: null, deletions: null, binary: true };
  }
}

function revisionOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function readProjectGitSnapshot(projectId: string, baseRef?: string): Promise<ProjectGitSnapshot> {
  let context;
  try {
    context = await readRepositoryContext(projectId);
  } catch (error) {
    return failedSnapshot(projectId, error instanceof Error ? error.message : String(error));
  }
  if (!context) return { projectId, state: 'not-repository', changes: [], truncated: false, revision: '' };
  try {
    const identity = await readBranchIdentity(context);
    if (baseRef) return await compareBranches(projectId, context, identity, baseRef);
    const hasHead = await repositoryHasHead(context);
    const status = await runGit(context.projectReal, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--find-renames=50%', '--', '.'
    ]);
    if (status.code !== 0) throw new Error(status.stderr || 'Git status failed');
    const changes = parseWorktreeChanges(status.stdout, context.prefix);
    const statsResult = await runGit(context.projectReal, [
      'diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--find-renames=50%',
      ...(hasHead ? ['HEAD'] : ['--cached']), '--', '.'
    ]);
    if (statsResult.code !== 0) throw new Error(statsResult.stderr || 'Git diff statistics failed');
    const stats = parseLineStatistics(statsResult.stdout, context.prefix);
    const unmeasured: ProjectGitChange[] = [];
    for (const change of changes) {
      const measured = stats.get(change.path);
      if (change.status === 'U' || (change.status === 'A' && !measured)) unmeasured.push(change);
      else if (measured) Object.assign(change, measured);
    }
    for (let start = 0; start < unmeasured.length; start += GIT_STAT_BATCH_SIZE) {
      await Promise.all(unmeasured.slice(start, start + GIT_STAT_BATCH_SIZE).map(async change => {
        Object.assign(change, await statsForNewFile(projectId, change.path));
      }));
    }
    return {
      projectId,
      state: 'ready',
      changes,
      truncated: changes.length >= MAX_GIT_CHANGES,
      revision: revisionOf(changes),
      currentBranch: identity.currentBranch,
      branches: identity.branches,
      branchesTruncated: identity.branchesTruncated
    };
  } catch (error) {
    return failedSnapshot(projectId, error instanceof Error ? error.message : String(error));
  }
}

async function compareBranches(projectId: string, context: NonNullable<Awaited<ReturnType<typeof readRepositoryContext>>>, identity: Awaited<ReturnType<typeof readBranchIdentity>>, baseRef: string): Promise<ProjectGitSnapshot> {
  const branch = identity.branches.find(entry => entry.ref === baseRef);
  if (!branch) throw new Error('The selected comparison branch is no longer available');
  if (!identity.headOid) throw new Error('This branch has no commits to compare');
  const baseResult = await runGit(context.projectReal, ['rev-parse', '--verify', '--quiet', baseRef], 128);
  const baseOid = baseResult.code === 0 ? decodeUtf8(baseResult.stdout).trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(baseOid)) throw new Error('The selected comparison branch changed');
  const ancestorResult = await runGit(context.projectReal, ['merge-base', baseOid, identity.headOid], 128);
  const ancestorOid = ancestorResult.code === 0 ? decodeUtf8(ancestorResult.stdout).trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(ancestorOid)) throw new Error('These branches have no common ancestor');
  const args = ['--no-ext-diff', '--no-textconv', '--find-renames=50%', ancestorOid, identity.headOid, '--', '.'];
  const [names, counts] = await Promise.all([
    runGit(context.projectReal, ['diff', '--name-status', '-z', ...args]),
    runGit(context.projectReal, ['diff', '--numstat', '-z', ...args])
  ]);
  if (names.code !== 0 || counts.code !== 0) throw new Error(names.stderr || counts.stderr || 'Git comparison failed');
  const changes = parseCommittedChanges(names.stdout, context.prefix);
  const stats = parseLineStatistics(counts.stdout, context.prefix);
  for (const change of changes) {
    const measured = stats.get(change.path);
    if (measured) Object.assign(change, measured);
  }
  const comparison = { ref: branch.ref, label: branch.label, baseOid: ancestorOid, headOid: identity.headOid };
  return {
    projectId,
    state: 'ready',
    changes,
    truncated: changes.length >= MAX_GIT_CHANGES,
    revision: revisionOf([comparison, changes]),
    currentBranch: identity.currentBranch,
    branches: identity.branches,
    branchesTruncated: identity.branchesTruncated,
    comparison
  };
}
