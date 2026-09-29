import type { GitHubSkillUpdateCheck, ManagedSkill } from '../../../../contracts/skills.js';

export type RecommendedSkillCard = { id: string; name: string; description: string };

export type SkillLibraryViewActions = {
  confirmUpdate: (skill: ManagedSkill) => void;
  confirmRemove: (skill: ManagedSkill) => void;
  openGithubDialog: (skill: ManagedSkill | null) => void;
  installRecommended: (id: string) => Promise<boolean>;
};

export type SkillCheckState = {
  checks: Map<string, GitHubSkillUpdateCheck>;
  checking: Set<string>;
};

export type SkillApiReply = { ok: true; data: ManagedSkill[] | null } | { ok: false; error: string };
