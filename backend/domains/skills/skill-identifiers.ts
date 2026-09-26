import path from 'node:path';
import { SKILL_ID_PATTERN } from '../../../contracts/skills.js';

const RESERVED_IDS = new Set(['prompt']);
const WINDOWS_RESERVED_ID = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/i;

export function validSkillId(id: string): boolean {
  return SKILL_ID_PATTERN.test(id) && !RESERVED_IDS.has(id) && !WINDOWS_RESERVED_ID.test(id);
}

export function assertSkillId(id: string): void {
  if (!SKILL_ID_PATTERN.test(id)) throw new Error('Invalid skill id');
  if (RESERVED_IDS.has(id) || WINDOWS_RESERVED_ID.test(id)) throw new Error(`Skill id "${id}" is reserved`);
}

export function slugSkillId(value: string): string {
  const slug = value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64)
    .replace(/[._-]+$/g, '');
  assertSkillId(slug);
  return slug;
}

export function importId(sourcePath: string): string {
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension !== '.md') throw new Error('Choose one Markdown (.md) skill file');
  const filename = path.basename(sourcePath);
  const sourceName = filename.toLowerCase() === 'skill.md'
    ? path.basename(path.dirname(sourcePath))
    : filename.slice(0, -extension.length);
  return slugSkillId(sourceName);
}
