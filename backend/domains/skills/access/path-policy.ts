import { isContained } from '../../../infrastructure/settings/sandbox.js';
import { skillsDirectory } from '../storage/catalog.js';

export function isSkillPath(real: string): boolean {
  const directory = skillsDirectory();
  return !!directory && isContained(directory, real);
}

export function isSkillVirtualPath(virtual: string): boolean {
  const normalized = process.platform === 'win32' ? virtual.replace(/\\/g, '/') : virtual;
  return /^\/skills(?:\/|$)/i.test(normalized);
}
