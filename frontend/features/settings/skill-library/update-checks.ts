import type { AppApi } from '../../../../backend/preload/index.js';
import { parseGitHubSkillUrl, type GitHubSkillUpdateCheck, type ManagedSkill } from '../../../../contracts/skills.js';
import { $ } from '../../../shared/dom.js';
import { t } from '../../../shared/i18n.js';

const checkAgeMs = 15 * 60_000;

export function createSkillUpdateChecks(
  api: Pick<AppApi, 'skillsCheckGithub'>,
  getSkills: () => ManagedSkill[],
  paintSource: (skill: ManagedSkill, checks: Map<string, GitHubSkillUpdateCheck>, checking: Set<string>) => void
) {
  const checks = new Map<string, GitHubSkillUpdateCheck>();
  const checking = new Set<string>();
  let checkPass: Promise<void> | null = null;

  const reconcile = (skills: ManagedSkill[]): void => {
    for (const [id, check] of checks) {
      if (skills.find(skill => skill.id === id)?.origin?.revision !== check.originRevision) checks.delete(id);
    }
    for (const id of checking) if (!skills.find(skill => skill.id === id)?.origin) checking.delete(id);
  };

  const checkUpdates = (force: boolean): Promise<void> => {
    if (checkPass) return checkPass;
    const skills = getSkills();
    const due = skills.filter(skill => skill.origin && (force || !checks.has(skill.id) ||
      Date.now() - checks.get(skill.id)!.checkedAt >= (checks.get(skill.id)!.state === 'error' ? 60_000 : checkAgeMs)));
    if (!due.length) return Promise.resolve();
    const groups = new Map<string, ManagedSkill[]>();
    for (const skill of due) {
      const location = parseGitHubSkillUrl(skill.origin!.url);
      const key = `${location.owner.toLowerCase()}/${location.repository.toLowerCase()}@${location.ref}`;
      groups.set(key, [...(groups.get(key) ?? []), skill]);
      checking.add(skill.id);
    }
    const batches = [...groups.values()];
    $<HTMLButtonElement>('skillsRefresh').disabled = true;
    for (const skill of due) paintSource(skill, checks, checking);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        let result: GitHubSkillUpdateCheck[] = [];
        let error: string | null = null;
        try {
          const reply = await api.skillsCheckGithub(batch[0]!.id);
          if (reply.ok) result = reply.data;
          else error = reply.error;
        } catch {
          error = t('Could not reach GitHub. Try again.');
        }
        const checkedAt = Date.now();
        for (const skill of batch) {
          checking.delete(skill.id);
          const current = getSkills().find(item => item.id === skill.id);
          if (current?.origin?.revision !== skill.origin!.revision) continue;
          const check = result.find(item => item.id === skill.id && item.originRevision === skill.origin!.revision);
          checks.set(skill.id, check ?? {
            id: skill.id,
            originRevision: skill.origin!.revision,
            state: 'error',
            checkedAt,
            error: error ?? 'GitHub check did not return this skill'
          });
        }
        for (const skill of batch) paintSource(skill, checks, checking);
      }
    };
    checkPass = Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker)).then(() => undefined).finally(() => {
      checkPass = null;
      $<HTMLButtonElement>('skillsRefresh').disabled = false;
    });
    return checkPass;
  };

  return {
    checks,
    checking,
    reconcile,
    checkUpdates,
    waitForPass: (): Promise<void> => checkPass ?? Promise.resolve()
  };
}
