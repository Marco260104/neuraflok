import path from 'node:path';
import { createHash } from 'node:crypto';
import { rawPromises as fs, rawRealpathNative } from '../../workspace/rawfs.js';
import { effectiveCapabilities, getConfig } from '../../../infrastructure/settings/config.js';
import { approvedManagedSkillLink, sameSkillLink, type ApprovedSkillLink } from '../access/managed-links.js';
import { validSkillId } from '../skill-identifiers.js';
import { metadataFor } from '../skill-summary-metadata.js';
import {
  MAX_SKILL_BYTES,
  MAX_SKILL_CHARS,
  MAX_SKILLS,
  SKILL_ORIGIN_FILENAME,
  validGitHubSkillOrigin,
  type GitHubSkillOrigin,
  type SkillSummary
} from '../../../../contracts/skills.js';

export interface SkillDocument {
  summary: SkillSummary;
  text: string;
}

export type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type SkillRecord = SkillDocument & { identity: FileIdentity; revision: string };

export const MAX_LIBRARY_ENTRIES = 256;
export const SKILL_FILENAME = 'SKILL.md';

let root: string | null = null;
let catalog: SkillSummary[] = [];
let catalogRevisions = new Map<string, string>();
let operations: Promise<unknown> = Promise.resolve();

export function runSkillStoreOperation<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work);
  operations = next.catch(() => undefined);
  return next;
}

export function sameNativePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function identityOf(stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function sameFileObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

export function requiredRoot(): string {
  if (!root) throw new Error('Skills storage is not ready');
  return root;
}

export async function readTextSnapshot(filename: string): Promise<{ bytes: Buffer; text: string; identity: FileIdentity }> {
  const handle = await fs.open(filename, 'r');
  try {
    const beforeStat = await handle.stat();
    if (!beforeStat.isFile()) throw new Error('Choose one skill file, not a folder');
    const before = identityOf(beforeStat);
    if (!Number.isSafeInteger(before.size) || before.size <= 0) throw new Error('A skill must be a non-empty text file');
    if (before.size > MAX_SKILL_BYTES) throw new Error('A skill must be 128,000 bytes or smaller');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('The skill file changed while being read');
      offset += result.bytesRead;
    }
    const after = identityOf(await handle.stat());
    if (!sameIdentity(before, after)) throw new Error('The skill file changed while being read');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('A skill must be a valid UTF-8 text file'); }
    if (text.length > MAX_SKILL_CHARS) throw new Error('A skill must be 96,000 characters or shorter');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) throw new Error('A skill must be a plain text file');
    return { bytes, text, identity: before };
  } finally {
    await handle.close();
  }
}

export async function assertManagedRoot(candidate: string): Promise<FileIdentity> {
  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The managed Skills folder is not a safe directory');
  const real = process.platform === 'win32' ? await rawRealpathNative(candidate) : await fs.realpath(candidate);
  if (!sameNativePath(real, candidate)) throw new Error('The managed Skills folder was redirected');
  return identityOf(stat);
}

export async function recordAt(candidateRoot: string, id: string): Promise<SkillRecord | null> {
  if (!validSkillId(id)) return null;
  const directory = path.join(candidateRoot, id);
  const filename = path.join(directory, SKILL_FILENAME);
  try {
    const directoryStat = await fs.lstat(directory);
    let linked: ApprovedSkillLink | null = null;
    let directoryReal: string;
    if (directoryStat.isSymbolicLink()) {
      const config = getConfig();
      if (!effectiveCapabilities(config).read) return null;
      linked = await approvedManagedSkillLink(candidateRoot, id, config.roots);
      if (!linked) return null;
      directoryReal = linked.real;
    } else {
      if (!directoryStat.isDirectory()) return null;
      directoryReal = process.platform === 'win32' ? await rawRealpathNative(directory) : await fs.realpath(directory);
      if (!sameNativePath(directoryReal, directory)) return null;
    }
    const fileStat = await fs.lstat(filename);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    const fileReal = process.platform === 'win32' ? await rawRealpathNative(filename) : await fs.realpath(filename);
    if (!sameNativePath(fileReal, path.join(directoryReal, SKILL_FILENAME))) return null;
    // Once a linked package has been approved, read the canonical file itself. Opening through the alias here would leave a retarget window between realpath() and open(). The alias is still checked again below so a concurrent retarget invalidates the record.
    const snapshot = await readTextSnapshot(fileReal);
    const currentFile = identityOf(await fs.lstat(filename));
    const currentDirectory = identityOf(await fs.lstat(directory));
    if (!sameIdentity(snapshot.identity, currentFile) ||
        !sameIdentity(identityOf(directoryStat), currentDirectory)) return null;
    const currentReal = process.platform === 'win32' ? await rawRealpathNative(filename) : await fs.realpath(filename);
    if (!sameNativePath(currentReal, path.join(directoryReal, SKILL_FILENAME))) return null;
    if (linked) {
      const config = getConfig();
      if (!effectiveCapabilities(config).read) return null;
      const currentLink = await approvedManagedSkillLink(candidateRoot, id, config.roots);
      if (!currentLink || !sameSkillLink(linked, currentLink)) return null;
    }
    const metadata = metadataFor(snapshot.text, id);
    return {
      summary: { id, ...metadata, path: `/skills/${id}/${SKILL_FILENAME}` },
      text: snapshot.text,
      identity: snapshot.identity,
      revision: createHash('sha256').update(snapshot.bytes).digest('hex')
    };
  } catch {
    return null;
  }
}

export async function directoryNames(candidateRoot: string): Promise<string[]> {
  const names: string[] = [];
  const directory = await fs.opendir(candidateRoot);
  try {
    for await (const entry of directory) {
      names.push(entry.name);
      if (names.length > MAX_LIBRARY_ENTRIES) throw new Error('The Skills library has too many entries');
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return names;
}

export async function scan(candidateRoot: string): Promise<SkillRecord[]> {
  const rootBefore = await assertManagedRoot(candidateRoot);
  const records: SkillRecord[] = [];
  for (const name of await directoryNames(candidateRoot)) {
    if (!validSkillId(name)) continue;
    const record = await recordAt(candidateRoot, name);
    if (!record) continue;
    records.push(record);
    if (records.length > MAX_SKILLS) throw new Error('The Skills library supports at most 64 skills');
  }
  const rootAfter = await assertManagedRoot(candidateRoot);
  if (!sameIdentity(rootBefore, rootAfter)) throw new Error('The managed Skills folder changed while being read');
  records.sort((left, right) => left.summary.id.localeCompare(right.summary.id));
  return records;
}

export async function originAt(candidateRoot: string, id: string): Promise<GitHubSkillOrigin | null> {
  const filename = path.join(candidateRoot, id, SKILL_ORIGIN_FILENAME);
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const real = process.platform === 'win32' ? await rawRealpathNative(filename) : await fs.realpath(filename);
    if (!sameNativePath(real, filename)) return null;
    const snapshot = await readTextSnapshot(filename);
    const value: unknown = JSON.parse(snapshot.text);
    return validGitHubSkillOrigin(value) ? value : null;
  } catch { return null; }
}

/** A crash between the two directory renames restores the old package before catalog scan. */
export async function recoverSkillBackups(candidateRoot: string): Promise<void> {
  for (const name of await directoryNames(candidateRoot)) {
    const match = /^\.backup-(.+)-([0-9a-f]{8}-[0-9a-f-]{27})$/.exec(name);
    if (!match || !validSkillId(match[1]!)) continue;
    const destination = path.join(candidateRoot, match[1]!);
    try { await fs.lstat(destination); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const backup = path.join(candidateRoot, name);
    const stat = await fs.lstat(backup);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameNativePath(await fs.realpath(backup), backup)) continue;
    if (!(await originAt(candidateRoot, name))) continue;
    await fs.rename(backup, destination);
  }
}

export function publish(records: SkillRecord[]): void {
  catalog = records.map(record => ({ ...record.summary }));
  catalogRevisions = new Map(records.map(record => [record.summary.id, record.revision]));
}


export function currentSkillRoot(): string | null {
  return root;
}

export function setSkillRoot(value: string | null): void {
  root = value;
}

export function resetSkillCatalog(): void {
  catalog = [];
  catalogRevisions = new Map();
}

export function publishedSkillSummaries(): SkillSummary[] {
  return catalog.map(summary => ({ ...summary }));
}

export function publishedSkillSnapshot(): Array<SkillSummary & { revision: string }> {
  return catalog.flatMap(summary => {
    const revision = catalogRevisions.get(summary.id);
    return revision ? [{ ...summary, revision }] : [];
  });
}

export async function removeOwnedFile(filename: string, identity: FileIdentity | null): Promise<void> {
  if (!identity) return;
  try {
    const current = identityOf(await fs.lstat(filename));
    if (sameIdentity(identity, current)) await fs.unlink(filename);
  } catch { /* Never remove a path whose exact owned identity cannot be proved. */ }
}

