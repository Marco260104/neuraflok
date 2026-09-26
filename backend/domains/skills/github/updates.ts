import { parseGitHubSkillUrl, type GitHubSkillUpdateCheck } from '../../../../contracts/skills.js';
import { listManagedSkills } from '../storage/catalog.js';
import { githubJson, repositoryEndpoint, SHA, type GitHubTreeEntry } from './api.js';
import { revisionFromTree } from './inspect.js';

export async function checkGitHubSkillUpdates(id: string): Promise<GitHubSkillUpdateCheck[]> {
  const installed = await listManagedSkills();
  const selected = installed.find(skill => skill.id === id);
  if (!selected?.origin) throw new Error('Only GitHub-imported skills can be checked');
  const location = parseGitHubSkillUrl(selected.origin.url);
  const related = installed.filter(skill => {
    if (!skill.origin) return false;
    const candidate = parseGitHubSkillUrl(skill.origin.url);
    return candidate.owner.toLowerCase() === location.owner.toLowerCase() &&
      candidate.repository.toLowerCase() === location.repository.toLowerCase() && candidate.ref === location.ref;
  });
  const signal = AbortSignal.timeout(30_000);
  let entries: GitHubTreeEntry[] | null = null;
  let repositoryError: string | null = null;
  try {
    const payload = await githubJson(`${repositoryEndpoint(location)}/git/trees/${encodeURIComponent(location.ref!)}?recursive=1`, signal, 8 * 1024 * 1024) as
      { sha?: unknown; truncated?: unknown; tree?: unknown };
    if (typeof payload.sha !== 'string' || !SHA.test(payload.sha) || payload.truncated !== false ||
        !Array.isArray(payload.tree) || payload.tree.length > 20_000)
      throw new Error('GitHub repository tree is too large or incomplete to check safely');
    if (!payload.tree.every((entry: unknown) => entry && typeof entry === 'object' &&
        typeof (entry as GitHubTreeEntry).path === 'string' && typeof (entry as GitHubTreeEntry).type === 'string' &&
        typeof (entry as GitHubTreeEntry).mode === 'string' && typeof (entry as GitHubTreeEntry).sha === 'string'))
      throw new Error('GitHub returned invalid repository metadata');
    entries = payload.tree as GitHubTreeEntry[];
  } catch (error) {
    repositoryError = error instanceof Error ? error.message : 'Could not check GitHub';
  }
  const checkedAt = Date.now();
  const current = new Map((await listManagedSkills()).map(skill => [skill.id, skill]));
  return related.flatMap(skill => {
    const live = current.get(skill.id);
    if (!live?.origin || live.origin.url !== skill.origin!.url || live.origin.revision !== skill.origin!.revision) return [];
    let state: GitHubSkillUpdateCheck['state'] = 'error';
    let error = repositoryError ?? undefined;
    if (entries) {
      try { state = revisionFromTree(entries, skill.origin!.directory) === skill.origin!.revision ? 'current' : 'available'; }
      catch (cause) { error = cause instanceof Error ? cause.message : 'Could not check GitHub'; }
    }
    return [{ id: skill.id, originRevision: skill.origin!.revision, state, checkedAt, ...(error ? { error } : {}) }];
  });
}
