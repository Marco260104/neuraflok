import type { LibrarySkill, SkillLibrary, SkillsDraftScope } from '../../../../contracts/skills.js';

export type SkillReply<T> = { ok: true; data: T } | { ok: false; error: string };

export type SkillComposerOptions = {
  input: HTMLTextAreaElement;
  host: HTMLElement;
  selectedHost: HTMLElement;
  openButton: HTMLElement;
  addButton: HTMLElement;
  owner: () => string;
  scope: () => SkillsDraftScope;
  draft: () => string | undefined;
  saveDraft: (authored: string) => void;
  list: (scope: SkillsDraftScope) => Promise<SkillReply<SkillLibrary>>;
  command?: (name: string) => void;
  commandAvailable?: (name: string) => boolean;
  deferCommand?: (name: string) => boolean;
};

export type ComposerCommand = { command: string; name: string; description: string; glyph: string };
export type SkillChoice = LibrarySkill | ComposerCommand;
