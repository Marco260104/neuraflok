import { SKILL_ORIGIN_FILENAME, type GitHubSkillLocation } from '../../../../contracts/skills.js';
import { skillPackageRevision } from '../storage/packages.js';
import { githubJson, MAX_DIRECTORIES, MAX_FILES, MAX_PACKAGE_BYTES, repositoryEndpoint, safeName, SHA, type GitHubFile, type GitHubSnapshot, type GitHubTreeEntry } from './api.js';

export async function inspectGitHubSkill(requested: GitHubSkillLocation, signal: AbortSignal): Promise<GitHubSnapshot> {
  const base = repositoryEndpoint(requested);
  let ref = requested.ref;
  if (!ref) {
    const repository = await githubJson(base, signal) as { default_branch?: unknown };
    if (typeof repository.default_branch !== 'string' || !safeName(repository.default_branch))
      throw new Error('GitHub repository has no usable default branch');
    ref = repository.default_branch;
  }
  const location = { ...requested, ref };
  const commitInfo = await githubJson(`${base}/commits/${encodeURIComponent(ref)}`, signal) as { sha?: unknown };
  if (typeof commitInfo.sha !== 'string' || !SHA.test(commitInfo.sha)) throw new Error('GitHub commit could not be verified');
  const commit = commitInfo.sha;
  const queue = [{ directory: location.directory, relative: '', depth: 0 }];
  const files: GitHubFile[] = [];
  let directoryCount = 0, bytes = 0;
  while (queue.length) {
    const current = queue.shift()!;
    if (++directoryCount > MAX_DIRECTORIES || current.depth > 10) throw new Error('GitHub skill has too many nested folders');
    const encoded = current.directory.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const listing = await githubJson(`${base}/contents${encoded ? `/${encoded}` : ''}?ref=${encodeURIComponent(commit)}`, signal);
    if (!Array.isArray(listing)) throw new Error('GitHub link must point to a skill folder');
    for (const value of listing) {
      const entry = value as { name?: unknown; path?: unknown; type?: unknown; sha?: unknown; size?: unknown };
      if (!safeName(entry.name) || typeof entry.path !== 'string' || entry.path !== [current.directory, entry.name].filter(Boolean).join('/'))
        throw new Error('GitHub skill contains an unsafe path');
      const relative = [current.relative, entry.name].filter(Boolean).join('/');
      if (entry.type === 'dir') { queue.push({ directory: entry.path, relative, depth: current.depth + 1 }); continue; }
      if (entry.type !== 'file' || typeof entry.sha !== 'string' || !SHA.test(entry.sha) ||
          !Number.isSafeInteger(entry.size) || (entry.size as number) < 0)
        throw new Error('GitHub skill contains an unsupported file or link');
      if (files.length >= MAX_FILES) throw new Error('GitHub skill has too many files');
      bytes += entry.size as number;
      if (bytes > MAX_PACKAGE_BYTES) throw new Error('GitHub skill exceeds 32 MiB');
      files.push({ relative, sha: entry.sha, size: entry.size as number });
    }
  }
  if (!files.some(file => file.relative === 'SKILL.md')) throw new Error('GitHub skill folder needs SKILL.md');
  if (files.some(file => file.relative === SKILL_ORIGIN_FILENAME)) throw new Error('GitHub skill uses a reserved NEURAFLOK metadata filename');
  const revision = skillPackageRevision(files);
  return { location, commit, revision, files };
}

export function revisionFromTree(entries: GitHubTreeEntry[], directory: string): string {
  const prefix = directory ? `${directory}/` : '';
  if (directory && !entries.some(entry => entry.path === directory && entry.type === 'tree'))
    throw new Error('GitHub skill folder was not found');
  const files: GitHubFile[] = [];
  let directories = 1, bytes = 0;
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || entry.path === directory) continue;
    const relative = entry.path.slice(prefix.length);
    const segments = relative.split('/');
    if (!segments.every(safeName)) throw new Error('GitHub skill contains an unsafe path');
    if (entry.type === 'tree' && entry.mode === '040000') {
      if (++directories > MAX_DIRECTORIES || segments.length > 10) throw new Error('GitHub skill has too many nested folders');
      continue;
    }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) ||
        !SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0)
      throw new Error('GitHub skill contains an unsupported file or link');
    if (files.length >= MAX_FILES) throw new Error('GitHub skill has too many files');
    bytes += entry.size as number;
    if (bytes > MAX_PACKAGE_BYTES) throw new Error('GitHub skill exceeds 32 MiB');
    files.push({ relative, sha: entry.sha, size: entry.size as number });
  }
  if (!files.some(file => file.relative === 'SKILL.md')) throw new Error('GitHub skill folder needs SKILL.md');
  if (files.some(file => file.relative === SKILL_ORIGIN_FILENAME)) throw new Error('GitHub skill uses a reserved NEURAFLOK metadata filename');
  return skillPackageRevision(files);
}
