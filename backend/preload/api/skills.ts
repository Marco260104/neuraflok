import type { SkillSummary, ManagedSkill, GitHubSkillUpdateCheck, SkillLibrary, SkillsDraftScope } from "../../../contracts/skills.js";
import { call } from "./shared.js";

export function createSkillsApi() {
  return {
    listSkills: () => call<SkillSummary[]>('skills:list'),
    listManagedSkills: () => call<ManagedSkill[]>('skills:managed'),
    listRecommendedSkills: () => call<Array<{ id: string; name: string; description: string; installed: boolean }>>('skills:recommended'),
    installRecommendedSkill: (id: string) => call<ManagedSkill[]>('skills:installRecommended', { id }),
    skillsImport: (kind: 'folder' | 'file') => call<ManagedSkill[] | null>('skills:import', { kind }),
    skillsImportGithub: (url: string) => call<ManagedSkill[]>('skills:githubImport', { url }),
    skillsLinkGithub: (id: string, url: string) => call<ManagedSkill[]>('skills:githubLink', { id, url }),
    skillsCheckGithub: (id: string) => call<GitHubSkillUpdateCheck[]>('skills:githubCheck', { id }),
    skillsUpdateGithub: (id: string) => call<{ status: 'current' | 'updated'; skills: ManagedSkill[]; warning?: string }>('skills:githubUpdate', { id }),
    skillsRemove: (id: string) => call<ManagedSkill[]>('skills:remove', { id }),
    skillLibrary: (scope: SkillsDraftScope) => call<SkillLibrary>('skills:library', scope)
  };
}
