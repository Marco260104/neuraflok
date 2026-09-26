import type { Root } from '../../../../contracts/types.js';
import { isSkillPath } from './path-policy.js';
import { skillsDirectory } from '../storage/catalog.js';

export function withManagedSkills<T extends { roots: Root[] }>(context: T): T {
  const directory = skillsDirectory();
  const roots = context.roots.filter(root => root.name.toLowerCase() !== 'skills');
  return { ...context, roots: directory ? [...roots, { name: 'skills', path: directory }] : roots };
}

export function firstTaskRoot(roots: readonly Root[]): Root | undefined {
  return roots.find(root => root.name.toLowerCase() !== 'skills' && !isSkillPath(root.path));
}
