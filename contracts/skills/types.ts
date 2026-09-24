export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface GitHubSkillOrigin {
  kind: 'github';
  url: string;
  ref: string;
  directory: string;
  commit: string;
  revision: string;
  skillSha256: string;
}

export interface ManagedSkill extends SkillSummary {
  origin: GitHubSkillOrigin | null;
}

export interface GitHubSkillUpdateCheck {
  id: string;
  originRevision: string;
  state: 'current' | 'available' | 'error';
  checkedAt: number;
  error?: string;
}

export interface GitHubSkillLocation {
  owner: string;
  repository: string;
  ref: string | null;
  directory: string;
}

export type SkillScope = 'managed' | 'repo' | 'user' | 'system' | 'admin';
export type SkillSource = 'managed' | 'repo-agents' | 'project-neuraflok' | 'project-claude' | 'user-agents' | 'neuraflok-home' | 'claude-home' | 'claude-plugin' | 'bundled' | 'admin';

export interface ClaudePluginSkillProvenance {
  pluginId: string;
  pluginName: string;
  marketplaceName: string;
  version: string;
  skillPath: string;
}

export interface SkillMetadata {
  displayName?: string;
  shortDescription?: string;
  defaultPrompt?: string;
  allowImplicitInvocation: boolean;
  dependencies?: Array<{ type: string; value: string; description?: string }>;
}

export interface LibrarySkill extends SkillSummary, SkillMetadata {
  scope: SkillScope;
  source: SkillSource;
  managed: boolean;
  claudePlugin?: ClaudePluginSkillProvenance;
}

export interface SkillLibrary {
  skills: LibrarySkill[];
  errors: string[];
  roots: Array<{ path: string; scope: SkillScope; source: SkillSource }>;
  includeInstructions: boolean;
  maxContextTokens?: number;
}

export interface SkillsDraftScope {
  sessionId?: string | null;
  projectId?: string | null;
}

export const MAX_SKILLS = 64;
export const SKILL_ORIGIN_FILENAME = '.neuraflok-github.json';
export const MAX_SKILL_BYTES = 128_000;
export const MAX_SKILL_CHARS = 96_000;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_DESCRIPTION_CHARS = 240;
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
