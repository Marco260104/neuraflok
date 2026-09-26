import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { rawPromises as fs } from '../../workspace/rawfs.js';
import { MAX_SKILLS, type SkillSummary } from '../../../../contracts/skills.js';
import { assertSkillId, importId } from '../skill-identifiers.js';
import {
  directoryNames,
  assertManagedRoot,
  identityOf,
  publish,
  readTextSnapshot,
  recordAt,
  removeOwnedFile,
  requiredRoot,
  runSkillStoreOperation,
  sameFileObject,
  sameIdentity,
  scan,
  SKILL_FILENAME,
  type FileIdentity
} from './core.js';

export function importSkillFile(sourcePath: string): Promise<SkillSummary> {
  return runSkillStoreOperation(async () => {
    if (!path.isAbsolute(sourcePath)) throw new Error('Choose an absolute local skill file');
    const id = importId(sourcePath);
    const source = await readTextSnapshot(sourcePath);
    const candidateRoot = requiredRoot();
    const current = await scan(candidateRoot);
    if (current.length >= MAX_SKILLS) throw new Error('The Skills library supports at most 64 skills');
    const names = await directoryNames(candidateRoot);
    if (names.some(name => name.toLowerCase() === id.toLowerCase())) throw new Error(`Skill "${id}" already exists`);

    const destination = path.join(candidateRoot, id);
    const finalFile = path.join(destination, SKILL_FILENAME);
    const temporaryFile = path.join(destination, `.import-${randomUUID()}.tmp`);
    let directoryOwned = false;
    let temporaryIdentity: FileIdentity | null = null;
    let finalIdentity: FileIdentity | null = null;
    try {
      try { await fs.mkdir(destination); directoryOwned = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Skill "${id}" already exists`);
        throw error;
      }
      const handle = await fs.open(temporaryFile, 'wx', 0o600);
      try {
        let offset = 0;
        while (offset < source.bytes.length) {
          offset += (await handle.write(source.bytes, offset, source.bytes.length - offset, offset)).bytesWritten;
        }
        await handle.sync();
        temporaryIdentity = identityOf(await handle.stat());
      } finally { await handle.close(); }
      const staged = await readTextSnapshot(temporaryFile);
      if (!staged.bytes.equals(source.bytes)) throw new Error('The imported skill changed while being staged');
      await fs.link(temporaryFile, finalFile);
      finalIdentity = identityOf(await fs.lstat(finalFile));
      if (!sameFileObject(staged.identity, finalIdentity)) throw new Error('The imported skill identity changed during publication');
      await fs.unlink(temporaryFile);
      temporaryIdentity = null;
      finalIdentity = identityOf(await fs.lstat(finalFile));
      const records = await scan(candidateRoot);
      const imported = records.find(record => record.summary.id === id);
      if (!imported || imported.revision !== createHash('sha256').update(source.bytes).digest('hex'))
        throw new Error('The imported skill changed during publication');
      publish(records);
      return { ...imported.summary };
    } catch (error) {
      await removeOwnedFile(temporaryFile, temporaryIdentity);
      await removeOwnedFile(finalFile, finalIdentity);
      if (directoryOwned) await fs.rmdir(destination).catch(() => undefined);
      throw error;
    }
  });
}

export function removeSkill(id: string, moveToTrash: (directory: string) => Promise<void>): Promise<void> {
  return runSkillStoreOperation(async () => {
    assertSkillId(id);
    const candidateRoot = requiredRoot();
    await assertManagedRoot(candidateRoot);
    const record = await recordAt(candidateRoot, id);
    if (!record) throw new Error(`Skill "${id}" was not found or is invalid`);
    const directory = path.join(candidateRoot, id);
    const before = identityOf(await fs.lstat(directory));
    const current = await recordAt(candidateRoot, id);
    await assertManagedRoot(candidateRoot);
    if (!current || record.revision !== current.revision || !sameIdentity(before, identityOf(await fs.lstat(directory))))
      throw new Error('The skill changed before removal; reload the library');
    await moveToTrash(directory);
    publish(await scan(candidateRoot));
  });
}
