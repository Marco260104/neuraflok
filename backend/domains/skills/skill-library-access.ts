import path from 'node:path';
import { rawPromises as fs } from '../workspace/rawfs.js';
import { effectiveCapabilities, getConfig } from '../../infrastructure/settings/config.js';
import { isContained, resolvePath } from '../../infrastructure/settings/sandbox.js';
import { readSkillTextSnapshot, skillsDirectory } from './storage/catalog.js';
import { approvedManagedSkillLink, sameSkillLink } from './access/managed-links.js';
import { parseSkillInterface } from './skill-metadata.js';
import type { SkillMetadata } from '../../../contracts/skills.js';
import { discoverUserSkillPath } from './user-skills.js';

export const identity = (file: string): string => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
export const samePath = (a: string, b: string): boolean => identity(a) === identity(b);
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function approved(file: string, allowMissing = false): Promise<{ real: string; virtual: string }> {
  if (!effectiveCapabilities(getConfig()).read) throw new Error('Read files permission is required for discovered Skills');
  try { return await resolvePath(getConfig().roots, file, { allowMissing }); }
  catch (error) {
    const own = await discoverUserSkillPath(file, allowMissing);
    if (own) return own;
    throw error;
  }
}

export async function readApproved(file: string): Promise<{ real: string; virtual: string; text: string }> {
  const target = await approved(file);
  const snapshot = await readSkillTextSnapshot(target.real);
  const current = await approved(file);
  const stat = await fs.lstat(current.real);
  if (!samePath(current.real, target.real) || stat.isSymbolicLink() ||
      !(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => snapshot.identity[key] === stat[key])) {
    throw new Error('Skill path changed during reading');
  }
  return { ...target, text: snapshot.text };
}

export async function approvedDirectory(file: string): Promise<{ real: string; virtual: string } | null> {
  const candidate = await approved(file, true);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(candidate.real); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const current = await approved(file);
  if (!samePath(current.real, candidate.real) || !(await fs.lstat(current.real)).isDirectory()) {
    throw new Error('Directory changed while it was being inspected');
  }
  return current;
}

export async function readOptionalApproved(file: string): Promise<string | null> {
  const candidate = await approved(file, true);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(candidate.real); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular file');
  return (await readApproved(file)).text;
}

export async function interfaceFor(directory: string, managed: boolean, errors: string[], managedId?: string): Promise<SkillMetadata> {
  let packageDirectory = directory;
  let linked: Awaited<ReturnType<typeof approvedManagedSkillLink>> = null;
  const revalidateLinked = async (): Promise<void> => {
    if (!linked) return;
    const root = skillsDirectory();
    const config = getConfig();
    const current = root && managedId && effectiveCapabilities(config).read
      ? await approvedManagedSkillLink(root, managedId, config.roots)
      : null;
    if (!current || !sameSkillLink(linked, current)) {
      throw new Error('Linked Skill changed while interface metadata was being read');
    }
  };
  try {
    if (managed) {
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink()) {
        const root = skillsDirectory();
        if (!root || !managedId) throw new Error('Linked Skill package lost its managed identity');
        const config = getConfig();
        if (!effectiveCapabilities(config).read) throw new Error('Read files permission is required for linked Skills');
        linked = await approvedManagedSkillLink(root, managedId, config.roots);
        if (!linked) throw new Error('Linked Skill target is outside the currently approved folders');
        packageDirectory = linked.real;
      }
    }
    const file = path.join(packageDirectory, 'agents', 'openai.yaml');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Skill interface metadata must be a regular file');
    const metadataReal = await fs.realpath(file);
    const directoryReal = await fs.realpath(packageDirectory);
    if (!isContained(directoryReal, metadataReal)) throw new Error('Skill interface metadata leaves its package');
    const text = managed ? (await readSkillTextSnapshot(metadataReal)).text : (await readApproved(file)).text;
    if (managed && !samePath(await fs.realpath(file), metadataReal)) {
      throw new Error('Skill interface metadata changed location while being read');
    }
    await revalidateLinked();
    return parseSkillInterface(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { await revalidateLinked(); }
      catch (revalidationError) {
        if (errors.length < 64) errors.push(`openai.yaml: ${errorText(revalidationError)}`);
        return { allowImplicitInvocation: false };
      }
      return { allowImplicitInvocation: true };
    }
    if (errors.length < 64) errors.push(`openai.yaml: ${errorText(error)}`);
    return { allowImplicitInvocation: false };
  }
}
