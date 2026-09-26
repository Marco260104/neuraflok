import { createHash } from 'node:crypto';
import { githubSkillUrl, parseGitHubSkillUrl, type GitHubSkillOrigin, type ManagedSkill } from '../../../../contracts/skills.js';
import { listManagedSkills } from '../storage/catalog.js';
import { importSkillPackage, linkSkillPackage, updateSkillPackage } from '../storage/packages.js';
import { inspectGitHubSkill } from './inspect.js';
import { downloadBlob, stageSkill } from './staging.js';
import { repositoryEndpoint } from './api.js';

export async function importGitHubSkill(url: string): Promise<ManagedSkill[]> {
  const signal = AbortSignal.timeout(120_000);
  const snapshot = await inspectGitHubSkill(parseGitHubSkillUrl(url), signal);
  const stage = await stageSkill(snapshot, signal);
  try { await importSkillPackage(stage.folder, stage.origin); }
  finally { await stage.cleanup(); }
  return listManagedSkills();
}

export async function linkGitHubSkill(id: string, url: string): Promise<ManagedSkill[]> {
  const installed = (await listManagedSkills()).find(skill => skill.id === id);
  if (!installed || installed.origin) throw new Error('Only local skills can be linked to GitHub');
  const signal = AbortSignal.timeout(120_000);
  const snapshot = await inspectGitHubSkill(parseGitHubSkillUrl(url), signal);
  const skillFile = snapshot.files.find(file => file.relative === 'SKILL.md')!;
  const remoteSkill = await downloadBlob(repositoryEndpoint(snapshot.location), skillFile, signal);
  const origin: GitHubSkillOrigin = {
    kind: 'github', url: githubSkillUrl(snapshot.location),
    ref: snapshot.location.ref, directory: snapshot.location.directory, commit: snapshot.commit,
    revision: snapshot.revision, skillSha256: createHash('sha256').update(remoteSkill).digest('hex')
  };
  await linkSkillPackage(id, origin);
  return listManagedSkills();
}

export async function updateGitHubSkill(
  id: string,
  moveToTrash: (directory: string) => Promise<void>
): Promise<{ status: 'current' | 'updated'; skills: ManagedSkill[]; warning?: string }> {
  const installed = (await listManagedSkills()).find(skill => skill.id === id);
  if (!installed?.origin) throw new Error('Only GitHub-imported skills can be updated');
  const signal = AbortSignal.timeout(120_000);
  const snapshot = await inspectGitHubSkill(parseGitHubSkillUrl(installed.origin.url), signal);
  if (snapshot.revision === installed.origin.revision) return { status: 'current', skills: await listManagedSkills() };
  const stage = await stageSkill(snapshot, signal);
  try {
    const result = await updateSkillPackage(id, installed.origin, stage.folder, stage.origin, moveToTrash);
    return { status: result.updated ? 'updated' : 'current', skills: await listManagedSkills(), warning: result.warning };
  } finally { await stage.cleanup(); }
}
