import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { rawPromises as fs, rawRealpathNative } from '../../workspace/rawfs.js';
import {
  MAX_SKILLS,
  SKILL_ORIGIN_FILENAME,
  validGitHubSkillOrigin,
  type GitHubSkillOrigin,
  type SkillSummary
} from '../../../../contracts/skills.js';
import { assertSkillId, slugSkillId } from '../skill-identifiers.js';
import {
  assertManagedRoot,
  directoryNames,
  identityOf,
  originAt,
  publish,
  readTextSnapshot,
  recordAt,
  removeOwnedFile,
  requiredRoot,
  runSkillStoreOperation,
  sameFileObject,
  sameIdentity,
  sameNativePath,
  scan,
  SKILL_FILENAME,
  type FileIdentity
} from './core.js';

const SKILL_ORIGIN_FILENAMES = new Set<string>([SKILL_ORIGIN_FILENAME]);

async function packageDocument(sourcePath: string): Promise<{ id: string; bytes: Buffer; revision: string }> {
  if (!path.isAbsolute(sourcePath)) throw new Error('Choose an absolute skill package folder');
  const sourceDirectory = await fs.lstat(sourcePath);
  if (!sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink()) throw new Error('Choose a real skill package folder');
  const id = slugSkillId(path.basename(sourcePath));
  const sourceFile = path.join(sourcePath, SKILL_FILENAME);
  const sourceStat = await fs.lstat(sourceFile);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('A skill package needs a regular SKILL.md');
  const document = await readTextSnapshot(sourceFile);
  const { parseSkillFrontmatter } = await import('../skill-metadata.js');
  parseSkillFrontmatter(document.text);
  return { id, bytes: document.bytes, revision: createHash('sha256').update(document.bytes).digest('hex') };
}

function originBytes(origin: GitHubSkillOrigin | undefined, revision: string): Buffer | undefined {
  if (!origin) return undefined;
  if (!validGitHubSkillOrigin(origin) || origin.skillSha256 !== revision) throw new Error('GitHub skill origin does not match SKILL.md');
  return Buffer.from(JSON.stringify(origin), 'utf8');
}

export function skillPackageRevision(files: Array<{ relative: string; sha: string; size: number }>): string {
  const ordered = [...files].sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)
    .map(file => ({ relative: file.relative, sha: file.sha, size: file.size }));
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** Link an existing local package without replacing its files or claiming missing resources are current. */
export function linkSkillPackage(id: string, source: GitHubSkillOrigin): Promise<void> {
  return runSkillStoreOperation(async () => {
    assertSkillId(id);
    if (!validGitHubSkillOrigin(source)) throw new Error('Invalid GitHub skill source');
    const name = source.directory.split('/').filter(Boolean).at(-1) ?? new URL(source.url).pathname.split('/')[2]!;
    if (slugSkillId(name) !== id) throw new Error('The GitHub folder name does not match this skill');
    const candidateRoot = requiredRoot();
    await assertManagedRoot(candidateRoot);
    const record = await recordAt(candidateRoot, id);
    if (!record) throw new Error('The local skill was removed or changed');
    if (await originAt(candidateRoot, id)) throw new Error('This skill already has a GitHub source');
    if (record.revision !== source.skillSha256) throw new Error('The local SKILL.md does not match this GitHub source');
    const directory = path.join(candidateRoot, id);
    const beforeDirectory = identityOf(await fs.lstat(directory));
    const files: Array<{ relative: string; sha: string; size: number }> = [];
    let folders = 0, entries = 0, bytes = 0;
    const collect = async (folder: string, relative: string, depth: number): Promise<void> => {
      if (++folders > 12 || depth > 10) throw new Error('The local skill has too many nested folders');
      const before = identityOf(await fs.lstat(folder));
      const directory = await fs.opendir(folder);
      try { for await (const entry of directory) {
        if (++entries > 52) throw new Error('The local skill exceeds GitHub update limits');
        if (relative === '' && SKILL_ORIGIN_FILENAMES.has(entry.name))
          throw new Error('The local skill already contains origin metadata');
        const nextRelative = [relative, entry.name].filter(Boolean).join('/');
        const filename = path.join(folder, entry.name);
        const stat = await fs.lstat(filename);
        if (stat.isSymbolicLink()) throw new Error('The local skill contains a linked resource');
        if (stat.isDirectory()) { await collect(filename, nextRelative, depth + 1); continue; }
        if (!stat.isFile()) throw new Error('The local skill contains an unsupported resource');
        if (files.length >= 40 || (bytes += stat.size) > 32 * 1024 * 1024)
          throw new Error('The local skill exceeds GitHub update limits');
        const handle = await fs.open(filename, 'r');
        let content: Buffer;
        try {
          if (!sameIdentity(identityOf(stat), identityOf(await handle.stat())))
            throw new Error('The local skill changed while linking');
          content = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < content.length) {
            const read = await handle.read(content, offset, content.length - offset, offset);
            if (!read.bytesRead) throw new Error('The local skill changed while linking');
            offset += read.bytesRead;
          }
          if (!sameIdentity(identityOf(stat), identityOf(await handle.stat())))
            throw new Error('The local skill changed while linking');
        } finally { await handle.close(); }
        if (!sameIdentity(identityOf(stat), identityOf(await fs.lstat(filename))))
          throw new Error('The local skill changed while linking');
        files.push({ relative: nextRelative, size: content.length,
          sha: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') });
      } } finally { await directory.close().catch(() => undefined); }
      if (!sameIdentity(before, identityOf(await fs.lstat(folder))))
        throw new Error('The local skill changed while linking');
    };
    await collect(directory, '', 0);
    const current = await recordAt(candidateRoot, id);
    if (!current || current.revision !== record.revision || !sameIdentity(beforeDirectory, identityOf(await fs.lstat(directory))))
      throw new Error('The local skill changed while linking');
    await assertManagedRoot(candidateRoot);
    const origin = { ...source, revision: skillPackageRevision(files) };
    const filename = path.join(directory, SKILL_ORIGIN_FILENAME);
    let owned: FileIdentity | null = null;
    try {
      const directoryReal = process.platform === 'win32' ? await rawRealpathNative(directory) : await fs.realpath(directory);
      if (!sameIdentity(beforeDirectory, identityOf(await fs.lstat(directory))) || !sameNativePath(directoryReal, directory))
        throw new Error('The local skill changed while linking');
      const handle = await fs.open(filename, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(origin)); await handle.sync(); owned = identityOf(await handle.stat()); }
      catch (error) { owned = identityOf(await handle.stat()); throw error; }
      finally { await handle.close(); }
      if ((await originAt(candidateRoot, id))?.revision !== origin.revision ||
          (await recordAt(candidateRoot, id))?.revision !== record.revision)
        throw new Error('The GitHub source could not be verified');
    } catch (error) {
      await removeOwnedFile(filename, owned);
      throw error;
    }
  });
}

/** Publish a complete selected package using the same serialized managed-library owner. */
export function importSkillPackage(sourcePath: string, origin?: GitHubSkillOrigin): Promise<SkillSummary> {
  return runSkillStoreOperation(async () => {
    const document = await packageDocument(sourcePath);
    const id = document.id;
    const candidateRoot = requiredRoot();
    const current = await scan(candidateRoot);
    if (current.length >= MAX_SKILLS) throw new Error('The Skills library supports at most 64 skills');
    const names = await directoryNames(candidateRoot);
    if (names.some(name => name.toLowerCase() === id.toLowerCase())) throw new Error(`Skill "${id}" already exists`);
    const { publishSkillPackage } = await import('../skill-package.js');
    await publishSkillPackage(sourcePath, candidateRoot, id, document.bytes, originBytes(origin, document.revision));
    const records = await scan(candidateRoot);
    const installed = records.find(record => record.summary.id === id);
    if (!installed) throw new Error('The imported package changed during publication');
    publish(records);
    return { ...installed.summary };
  });
}

/** Replace exactly one GitHub-owned package; old contents remain recoverable in OS Trash. */
export function updateSkillPackage(
  id: string,
  expectedOrigin: GitHubSkillOrigin,
  sourcePath: string,
  nextOrigin: GitHubSkillOrigin,
  moveToTrash: (directory: string) => Promise<void>
): Promise<{ updated: boolean; warning?: string }> {
  return runSkillStoreOperation(async () => {
    assertSkillId(id);
    const candidateRoot = requiredRoot();
    const document = await packageDocument(sourcePath);
    if (document.id !== id) throw new Error('GitHub skill folder no longer matches the installed skill');
    const metadata = originBytes(nextOrigin, document.revision);
    if (!metadata || !validGitHubSkillOrigin(expectedOrigin) || nextOrigin.url !== expectedOrigin.url)
      throw new Error('GitHub skill source changed');
    await assertManagedRoot(candidateRoot);
    const old = await recordAt(candidateRoot, id);
    const oldOrigin = await originAt(candidateRoot, id);
    if (!old || !oldOrigin || oldOrigin.url !== expectedOrigin.url || oldOrigin.revision !== expectedOrigin.revision)
      throw new Error('The skill changed while checking for updates; reload the library');
    if (nextOrigin.revision === oldOrigin.revision) return { updated: false };
    if (old.revision !== oldOrigin.skillSha256)
      throw new Error('SKILL.md has local edits; preserve them before updating from GitHub');
    const oldDirectory = identityOf(await fs.lstat(path.join(candidateRoot, id)));

    const operation = randomUUID();
    const stage = path.join(candidateRoot, `.update-${id}-${operation}`);
    const backup = path.join(candidateRoot, `.backup-${id}-${operation}`);
    const destination = path.join(candidateRoot, id);
    const { publishSkillPackage } = await import('../skill-package.js');
    await publishSkillPackage(sourcePath, candidateRoot, path.basename(stage), document.bytes, metadata);
    const stageDirectory = identityOf(await fs.lstat(stage));
    let oldMoved = false, nextMoved = false;
    try {
      const current = await recordAt(candidateRoot, id);
      const currentOrigin = await originAt(candidateRoot, id);
      if (!current || current.revision !== old.revision || !currentOrigin || currentOrigin.revision !== oldOrigin.revision ||
          !sameIdentity(oldDirectory, identityOf(await fs.lstat(destination))))
        throw new Error('The skill changed before update; reload the library');
      await assertManagedRoot(candidateRoot);
      await fs.rename(destination, backup); oldMoved = true;
      await fs.rename(stage, destination); nextMoved = true;
      const installed = await recordAt(candidateRoot, id);
      const installedOrigin = await originAt(candidateRoot, id);
      if (!installed || installed.revision !== document.revision || installedOrigin?.revision !== nextOrigin.revision)
        throw new Error('The updated skill could not be verified');
      publish(await scan(candidateRoot));
    } catch (error) {
      let restored = true;
      if (nextMoved) try { await fs.rename(destination, stage); } catch { restored = false; }
      if (oldMoved) try { await fs.rename(backup, destination); } catch { restored = false; }
      if (restored) {
        try {
          if (sameFileObject(stageDirectory, identityOf(await fs.lstat(stage)))) await moveToTrash(stage);
        } catch { /* Keep an unclaimed stage rather than trashing another path. */ }
      }
      if (!restored) throw new Error('Skill update could not restore the previous version; its backup was kept in Skills storage', { cause: error });
      throw error;
    }
    try {
      const stored = identityOf(await fs.lstat(backup));
      if (!sameFileObject(oldDirectory, stored)) throw new Error('The previous skill folder changed before cleanup');
      await moveToTrash(backup);
    }
    catch { return { updated: true, warning: 'Updated, but the previous version could not be moved to Trash' }; }
    return { updated: true };
  });
}

