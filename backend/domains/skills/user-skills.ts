// Exposes only isolated Skill trees from user-owned folders outside approved workspace roots.
import os from 'node:os';
import path from 'node:path';
import { rawPromises as fs } from '../workspace/rawfs.js';
import { isContained, SandboxError, type Resolved } from '../../infrastructure/settings/sandbox.js';

export const USER_SKILLS_ROOT = 'user-skills';
export type UserSkillAreaName = 'claude' | 'neuraflok' | 'neural-jam' | 'agents' | 'admin' | 'legacy-admin';
export interface UserSkillArea { name: UserSkillAreaName; base: string }

function home(): string {
  return path.resolve((process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir());
}

export function userSkillAreas(): UserSkillArea[] {
  const homePath = path.resolve(process.env.NEURAFLOK_HOME?.trim() || path.join(home(), '.neuraflok'));
  const legacyHomePath = path.resolve(path.join(home(), '.neural-jam'));
  const adminPath = process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Neuraflok') : '/etc/neuraflok';
  const legacyAdminPath = process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'NeuralJam') : '/etc/neural-jam';
  return [
    { name: 'claude', base: path.resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home(), '.claude')) },
    { name: 'neuraflok', base: homePath },
    { name: 'neural-jam', base: legacyHomePath },
    { name: 'agents', base: path.join(home(), '.agents') },
    { name: 'admin', base: adminPath },
    { name: 'legacy-admin', base: legacyAdminPath }
  ];
}

// Locates the account metadata used to select Claude's current synced Skills folder.
function claudeAccountFile(claudeBase: string): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() ? path.join(claudeBase, '.claude.json') : path.join(path.dirname(claudeBase), '.claude.json');
}

const same = (a: string, b: string): boolean => isContained(a, b) && isContained(b, a);

// Allows only Skill trees and the package metadata needed to discover them.
function served(segments: readonly string[]): boolean {
  return segments[0] === 'skills' ||
    (segments[0] === 'plugins' && segments[1] === 'cache' && segments.length >= 6 && segments[5] === 'skills');
}

function discoverable(area: UserSkillAreaName, segments: readonly string[]): boolean {
  if (served(segments)) return true;
  const joined = segments.join('/');
  // A cached plugin package folder (`plugins/cache/<m>/<p>/<v>`), checked before its skills/ is read.
  const pluginPackage = segments[0] === 'plugins' && segments[1] === 'cache' && segments.length === 5;
  if (area === 'claude') return pluginPackage || joined === 'settings.json' || joined === 'plugins/installed_plugins.json' || joined === 'plugins/cache';
  if (area === 'neuraflok' || area === 'neural-jam') return segments.length === 0 || joined === 'config.toml';
  if (area === 'admin' || area === 'legacy-admin') return joined === 'config.toml';
  return false;
}

function segmentsOf(relative: string): string[] | null {
  if (relative === '') return [];
  const segments = relative.split(/[\\/]+/);
  return segments.some(segment => !segment || segment === '.' || segment === '..') ? null : segments;
}

// Resolves a path through its nearest existing ancestor when optional files are missing.
async function realOf(file: string, allowMissing: boolean): Promise<string> {
  try { return await fs.realpath(file); }
  catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await realOf(parent, true), path.basename(file));
  }
}

async function realAreas(): Promise<Array<UserSkillArea & { real: string }>> {
  const out: Array<UserSkillArea & { real: string }> = [];
  for (const area of userSkillAreas()) {
    try { out.push({ ...area, real: await fs.realpath(area.base) }); } catch { /* An area that does not exist has nothing to offer. */ }
  }
  return out;
}

type Level = 'served' | 'discoverable';

// Finds the allowed area and relative path for a resolved location.
function placeOf(areas: Array<UserSkillArea & { real: string }>, real: string, level: Level): { area: UserSkillArea & { real: string }; segments: string[] } | null {
  for (const area of areas) {
    if (!isContained(area.real, real)) continue;
    const segments = segmentsOf(path.relative(area.real, real));
    if (segments && (level === 'served' ? served(segments) : discoverable(area.name, segments))) return { area, segments };
  }
  return null;
}

// Resolves a catalog path while rejecting links that leave approved Skill areas.
export async function discoverUserSkillPath(file: string, allowMissing = false): Promise<{ real: string; virtual: string } | null> {
  let lexical: string;
  if (isUserSkillVirtualPath(file)) {
    // Resolves a virtual Skill path back to its owning user directory.
    const [, , areaName, ...rest] = (process.platform === 'win32' ? file.replace(/\\/g, '/') : file).replace(/\/+$/, '').split('/');
    const area = userSkillAreas().find(candidate => candidate.name === areaName);
    if (!area || rest.some(segment => !segment || segment === '.' || segment === '..')) return null;
    lexical = path.join(area.base, ...rest);
  } else lexical = path.resolve(file);
  const areas = await realAreas();
  for (const area of userSkillAreas()) {
    const account = area.name === 'claude' && same(lexical, claudeAccountFile(area.base));
    if (!account && !isContained(area.base, lexical)) continue;
    const segments = account ? [] : segmentsOf(path.relative(area.base, lexical));
    if (!segments || (!account && !discoverable(area.name, segments))) continue;
    const real = await realOf(lexical, allowMissing);
    if (account) {
      const stat = await fs.lstat(real).catch(() => null);
      if (stat && !stat.isFile()) throw new SandboxError('Claude Code account file must be a regular file');
      return { real, virtual: '' };
    }
    const place = placeOf(areas, real, 'discoverable');
    if (!place) throw new SandboxError('A linked Skill path leaves the Skill folders');
    return { real, virtual: `/${USER_SKILLS_ROOT}/${place.area.name}${place.segments.length ? `/${place.segments.join('/')}` : ''}` };
  }
  return null;
}

export function isUserSkillVirtualPath(virtual: string): boolean {
  const normalized = process.platform === 'win32' ? virtual.replace(/\\/g, '/') : virtual;
  return new RegExp(`^/${USER_SKILLS_ROOT}(?:/|$)`, 'i').test(normalized);
}

// Resolves a read-only virtual path to a Skill file or folder.
export async function resolveUserSkillPath(requested: string): Promise<Resolved | null> {
  if (!isUserSkillVirtualPath(requested)) return null;
  const normalized = (process.platform === 'win32' ? requested.replace(/\\/g, '/') : requested).replace(/\/+$/, '');
  const [, , areaName, ...rest] = normalized.split('/');
  const area = userSkillAreas().find(candidate => candidate.name === areaName);
  if (!area || rest.some(segment => !segment || segment === '.' || segment === '..') || !served(rest)) {
    throw new SandboxError(`Not found: ${requested}. /${USER_SKILLS_ROOT} holds only the Skill folders listed in the Skills catalog.`);
  }
  let real: string;
  try { real = await fs.realpath(path.join(area.base, ...rest)); }
  catch { throw new SandboxError(`Not found: ${requested}`); }
  const place = placeOf(await realAreas(), real, 'served');
  if (!place) throw new SandboxError('A linked Skill path leaves the Skill folders');
  const virtual = `/${USER_SKILLS_ROOT}/${place.area.name}/${place.segments.join('/')}`;
  return { real, virtual, root: { name: USER_SKILLS_ROOT, path: place.area.real } };
}
