import type { ClaudePluginSkillProvenance, SkillScope, SkillSource } from '../../../contracts/skills.js';

export interface SkillLibraryScope {
  projectPath?: string | null;
  managedFromCatalog?: boolean;
}

export type ClaudePluginCandidate = Omit<ClaudePluginSkillProvenance, 'skillPath'>;
export type SkillCandidate = { file: string; scope: SkillScope; source: SkillSource; claudePlugin?: ClaudePluginCandidate; skipTop?: string };
