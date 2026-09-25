import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { RECOMMENDED_SKILLS } from '../../../contracts/recommended-skills.js';
import type { ManagedSkill } from '../../../contracts/skills.js';
import { importSkillPackage } from './storage/packages.js';
import { listManagedSkills } from './storage/catalog.js';

export interface RecommendedSkillEntry { id: string; name: string; description: string; installed: boolean }

export async function listRecommendedSkills(): Promise<RecommendedSkillEntry[]> {
  const installed = new Set((await listManagedSkills()).map(skill => skill.id));
  return RECOMMENDED_SKILLS.map(({ id, name, description }) => ({ id, name, description, installed: installed.has(id) }));
}

// Installs through the validated package flow in an isolated temporary folder.
export async function installRecommendedSkill(id: string): Promise<ManagedSkill[]> {
  const skill = RECOMMENDED_SKILLS.find(entry => entry.id === id);
  if (!skill) throw new Error('Unknown recommended skill');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neuraflok-recommended-skill-'));
  try {
    const folder = path.join(temporary, skill.id);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'SKILL.md'), skill.markdown, { flag: 'wx', mode: 0o600 });
    await importSkillPackage(folder);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return listManagedSkills();
}
