import type { ProjectGitBranch, ProjectGitChange, ProjectGitStatus } from '../../../../contracts/workspace/project-git.js';
import { MAX_GIT_BRANCHES, MAX_GIT_CHANGES } from './limits.js';
import { pathWithinProject, decodeUtf8, type RepositoryContext } from './repository.js';
import { runGit } from './process.js';

function nullSeparatedValues(buffer: Buffer): string[] {
  const values = decodeUtf8(buffer).split('\0');
  return values.at(-1) === '' ? values.slice(0, -1) : values;
}

function classifyWorktreeChange(xy: string): ProjectGitStatus {
  if (xy === '??') return 'U';
  if (xy.includes('R') || xy.includes('C')) return 'R';
  if (xy.includes('D')) return 'D';
  if (xy.includes('A')) return 'A';
  return 'M';
}

export function parseWorktreeChanges(buffer: Buffer, prefix: string): ProjectGitChange[] {
  const values = nullSeparatedValues(buffer);
  const changes: ProjectGitChange[] = [];
  for (let cursor = 0; cursor < values.length;) {
    const record = values[cursor++]!;
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const file = pathWithinProject(record.slice(3), prefix);
    if (!file || xy === '!!') continue;
    const status = classifyWorktreeChange(xy);
    let previousPath: string | undefined;
    if (status === 'R') {
      const prior = values[cursor++];
      previousPath = prior ? pathWithinProject(prior, prefix) ?? undefined : undefined;
    }
    changes.push({ status, path: file, previousPath, additions: null, deletions: null, binary: false });
    if (changes.length === MAX_GIT_CHANGES) break;
  }
  return changes;
}

export function parseCommittedChanges(buffer: Buffer, prefix: string): ProjectGitChange[] {
  const values = nullSeparatedValues(buffer);
  const changes: ProjectGitChange[] = [];
  for (let cursor = 0; cursor < values.length && changes.length < MAX_GIT_CHANGES;) {
    const code = values[cursor++]!;
    if (!/^[ACDMRTUXB][0-9]*$/.test(code)) throw new Error('Git returned an invalid change status');
    const renamed = code[0] === 'R' || code[0] === 'C';
    const previous = values[cursor++];
    const current = renamed ? values[cursor++] : previous;
    if (!previous || !current) throw new Error('Git returned an incomplete change');
    const before = pathWithinProject(previous, prefix);
    const after = pathWithinProject(current, prefix);
    if (!before && !after) continue;
    const status: ProjectGitStatus = renamed
      ? before && after ? 'R' : before ? 'D' : 'A'
      : code[0] === 'A' ? 'A' : code[0] === 'D' ? 'D' : 'M';
    changes.push({
      status,
      path: status === 'D' ? before! : after!,
      previousPath: status === 'R' ? before! : undefined,
      additions: null,
      deletions: null,
      binary: false
    });
  }
  return changes;
}

export interface GitLineStats {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export function parseLineStatistics(buffer: Buffer, prefix: string): Map<string, GitLineStats> {
  const values = nullSeparatedValues(buffer);
  const stats = new Map<string, GitLineStats>();
  for (let cursor = 0; cursor < values.length;) {
    const fields = values[cursor++]!.split('\t');
    if (fields.length < 3) continue;
    const binary = fields[0] === '-' || fields[1] === '-';
    const counts = {
      additions: binary ? null : Number(fields[0]),
      deletions: binary ? null : Number(fields[1]),
      binary
    };
    if (fields[2]) {
      const file = pathWithinProject(fields.slice(2).join('\t'), prefix);
      if (file) stats.set(file, counts);
      continue;
    }
    cursor++;
    const currentPath = values[cursor++];
    const file = currentPath ? pathWithinProject(currentPath, prefix) : null;
    if (file) stats.set(file, counts);
  }
  return stats;
}

export interface BranchIdentity {
  currentBranch: string;
  headOid: string | null;
  branches: ProjectGitBranch[];
  branchesTruncated: boolean;
}

export async function readBranchIdentity(context: RepositoryContext): Promise<BranchIdentity> {
  const [symbolic, head, listed] = await Promise.all([
    runGit(context.projectReal, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 512),
    runGit(context.projectReal, ['rev-parse', '--verify', '--quiet', 'HEAD'], 128),
    runGit(context.projectReal, ['for-each-ref', `--count=${MAX_GIT_BRANCHES + 1}`,
      '--format=%(refname)%00%(refname:short)%00%(symref)', 'refs/heads', 'refs/remotes'])
  ]);
  if (listed.code !== 0) throw new Error(listed.stderr || 'Git branches could not be inspected');
  const headOid = head.code === 0 ? decodeUtf8(head.stdout).trim() : null;
  if (headOid && !/^[0-9a-f]{40,64}$/.test(headOid)) throw new Error('Git returned an invalid HEAD');
  const branches: ProjectGitBranch[] = [];
  let branchesTruncated = false;
  for (const rawLine of decodeUtf8(listed.stdout).split('\n')) {
    if (!rawLine) continue;
    const [ref, label, symbolicTarget] = rawLine.replace(/\r$/, '').split('\0');
    if (symbolicTarget || !ref || !label || !/^refs\/(heads|remotes)\//.test(ref)) continue;
    if (branches.length === MAX_GIT_BRANCHES) {
      branchesTruncated = true;
      break;
    }
    branches.push({ ref, label });
  }
  return {
    currentBranch: symbolic.code === 0 ? decodeUtf8(symbolic.stdout).trim() : headOid ? headOid.slice(0, 8) : 'HEAD',
    headOid,
    branches,
    branchesTruncated
  };
}

export async function repositoryHasHead(context: RepositoryContext): Promise<boolean> {
  return (await runGit(context.projectReal, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0;
}
