import type { Root } from '../../../../contracts/types.js';
import path from 'node:path';
import { approvedManagedSkillLink, sameSkillLink } from './managed-links.js';
import { rawPromises as fs } from '../../workspace/rawfs.js';
import { isAbsoluteVirtualPath, isContained, isNativeWindowsPath, resolvePath, SandboxError, type ResolveOptions, type Resolved } from '../../../infrastructure/settings/sandbox.js';
import { skillsDirectory } from '../storage/catalog.js';
import { SKILL_ID_PATTERN } from '../../../../contracts/skills.js';
import { isSkillVirtualPath } from './path-policy.js';

function aliasPath(requested: string, base: string | null | undefined, managed: string): string | null {
  const normalize = (value: string): string => process.platform === 'win32' ? value.replace(/\\/g, '/') : value;
  if (path.isAbsolute(requested)) {
    const withoutRoot = process.platform === 'win32'
      ? requested.replace(/^[A-Za-z]:[\\/]+/, '').replace(/^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*/, '')
      : requested.replace(/^\/+/, '');
    if (!withoutRoot.split(/[/\\]+/).some(segment => segment === '.' || segment === '..')) {
      const nativePath = path.resolve(requested);
      if (isContained(managed, nativePath)) {
        const relative = path.relative(managed, nativePath);
        return relative === '' ? '/skills' : `/skills/${relative.split(path.sep).join('/')}`;
      }
    }
  }
  const normalized = normalize(requested);
  if (isAbsoluteVirtualPath(requested)) return normalized;
  if (isNativeWindowsPath(requested)) return null;
  if (base && isSkillVirtualPath(base)) {
    const basePath = normalize(base).replace(/\/+$/, '');
    const relativePath = normalize(requested).replace(/^\/+/, '');
    return `${basePath}/${relativePath}`;
  }
  return null;
}

function skillAlias(requested: string, base: string | null | undefined, managed: string): { id: string; tail: string } | null {
  const candidate = aliasPath(requested, base, managed);
  const match = candidate ? /^\/skills\/([^/]+)(\/.*)?$/i.exec(candidate) : null;
  if (!match) return null;
  const id = process.platform === 'win32' ? match[1]!.toLowerCase() : match[1]!;
  return SKILL_ID_PATTERN.test(id) ? { id, tail: match[2] ?? '' } : null;
}

export async function resolveLinkedSkillAlias(
  roots: readonly Root[],
  requested: string,
  options: ResolveOptions = {}
): Promise<Resolved | null> {
  const managed = skillsDirectory();
  const alias = managed ? skillAlias(requested, options.base, managed) : null;
  const skillRoot = roots.find(root => root.name.toLowerCase() === 'skills');
  if (!alias || !managed || !skillRoot) return null;

  const checkedRoot = await resolvePath([skillRoot], '/skills');
  const linkPath = path.join(checkedRoot.real, alias.id);
  let linkStat;
  try { linkStat = await fs.lstat(linkPath); }
  catch { return null; }
  if (!linkStat.isSymbolicLink()) return null;
  const before = await approvedManagedSkillLink(checkedRoot.real, alias.id, roots);
  if (!before) throw new SandboxError('Linked Skill target is outside the currently approved folders');

  const linkedRoot: Root = { name: 'linked-skill', path: before.real };
  const resolved = await resolvePath([linkedRoot], `/linked-skill${alias.tail}`, options);
  const after = await approvedManagedSkillLink(checkedRoot.real, alias.id, roots);
  if (!after || !sameSkillLink(before, after)) throw new SandboxError('Linked Skill changed while its path was being resolved');
  const relative = path.relative(before.real, resolved.real);
  const virtual = relative === ''
    ? `/skills/${alias.id}`
    : `/skills/${alias.id}/${relative.split(path.sep).join('/')}`;
  return { real: resolved.real, virtual, root: skillRoot };
}
