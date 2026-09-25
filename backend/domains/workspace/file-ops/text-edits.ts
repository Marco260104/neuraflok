import { randomUUID } from 'node:crypto';
import { rawPromises as fs } from '../rawfs.js';
import path from 'node:path';
import { lineDelta, type LineDelta } from '../diffstat.js';
import { TextMatchError, applyTextEdit } from '../text-edit/apply.js';
import { decodeText, encodeText, sniffBinary, textFormat } from './text-files.js';
import { FsOpError, MAX_WRITE_BYTES, formatBytes } from './limits.js';

export interface EditOp {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export const MAX_BATCH_EDIT_FILES = 20;
export const MAX_BATCH_EDIT_OPS = 128;
export const MAX_BATCH_EDIT_BYTES = 32 * 1024 * 1024;

interface PreparedTextEdit {
  realPath: string;
  virtualPath: string;
  originalBytes: Buffer;
  nextBytes: Buffer;
  replacements: number;
  delta: LineDelta;
}

export interface BatchTextEditInput {
  realPath: string;
  virtualPath: string;
  edits: readonly EditOp[];
}

export interface BatchTextEditResult {
  virtualPath: string;
  replacements: number;
  bytes: number;
  delta: LineDelta;
}

async function prepareTextEdit(
  realPath: string,
  virtualPath: string,
  edits: readonly EditOp[]
): Promise<PreparedTextEdit> {
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new FsOpError(`${virtualPath}: not a file`);
  if (stat.size > MAX_WRITE_BYTES) {
    throw new FsOpError(`${virtualPath}: file is too large to edit (${formatBytes(stat.size)})`);
  }
  if (await sniffBinary(realPath)) throw new FsOpError(`${virtualPath}: cannot edit a binary file`);

  const format = await textFormat(realPath);
  const originalBytes = await fs.readFile(realPath);
  const original = decodeText(originalBytes, format);
  let content = original;
  let replacements = 0;

  for (const [index, edit] of edits.entries()) {
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) {
      throw new FsOpError(`${virtualPath}, edit ${index + 1}: oldText must be a non-empty string`);
    }
    if (typeof edit.newText !== 'string') {
      throw new FsOpError(`${virtualPath}, edit ${index + 1}: newText must be a string`);
    }
    // One matching engine for every mutation tool. read_file returns logical LF-separated lines on every platform, so a snippet copied out of it has to remain a valid edit input for a CRLF or mixed-ending file; applyTextEdit is where that is guaranteed.
    try {
      const applied = applyTextEdit(content, edit);
      content = applied.text;
      replacements += applied.replacements;
    } catch (error) {
      if (error instanceof TextMatchError) {
        throw new FsOpError(`${virtualPath}, edit ${index + 1}: ${error.message}`);
      }
      throw error;
    }
  }

  if (content === original) throw new FsOpError(`${virtualPath}: edits produced no change`);
  const nextBytes = encodeText(content, format, true);
  return { realPath, virtualPath, originalBytes, nextBytes, replacements, delta: lineDelta(original, content) };
}

/** Applies exact-text replacements. Line numbers are deliberately not used as an edit primitive: they drift the moment an earlier edit lands, and models get them wrong. A non-unique oldText is an error rather than a guess. */
export async function editTextFile(
  realPath: string,
  edits: readonly EditOp[]
): Promise<{ replacements: number; bytes: number; delta: LineDelta }> {
  const prepared = await prepareTextEdit(realPath, 'file', edits);
  await fs.writeFile(realPath, prepared.nextBytes);
  return { replacements: prepared.replacements, bytes: prepared.nextBytes.length, delta: prepared.delta };
}

/** Preflights every file before touching any of them, stages complete replacements in sibling temp files, then commits by rename. A commit-time failure triggers a best-effort reverse rollback using the exact original bytes. This cannot provide a filesystem-wide ACID transaction across unrelated NTFS files, but ordinary stale snippets, path failures and validation errors are guaranteed to make zero changes. */
export async function editTextFiles(
  files: readonly BatchTextEditInput[]
): Promise<BatchTextEditResult[]> {
  if (files.length === 0) throw new FsOpError('At least one file is required');
  if (files.length > MAX_BATCH_EDIT_FILES) {
    throw new FsOpError(`Too many files in one batch (limit ${MAX_BATCH_EDIT_FILES})`);
  }
  const totalOps = files.reduce((sum, file) => sum + file.edits.length, 0);
  if (totalOps > MAX_BATCH_EDIT_OPS) {
    throw new FsOpError(`Too many edits in one batch (limit ${MAX_BATCH_EDIT_OPS})`);
  }

  const seen = new Set<string>();
  for (const file of files) {
    const key = process.platform === 'win32' ? file.realPath.toLowerCase() : file.realPath;
    if (seen.has(key)) throw new FsOpError(`${file.virtualPath}: the same file appears more than once in the batch`);
    seen.add(key);
  }

  const prepared: PreparedTextEdit[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (file.edits.length === 0) throw new FsOpError(`${file.virtualPath}: at least one edit is required`);
    const item = await prepareTextEdit(file.realPath, file.virtualPath, file.edits);
    totalBytes += Math.max(item.originalBytes.length, item.nextBytes.length);
    if (totalBytes > MAX_BATCH_EDIT_BYTES) {
      throw new FsOpError(`Batch is too large to edit safely (limit ${formatBytes(MAX_BATCH_EDIT_BYTES)})`);
    }
    prepared.push(item);
  }

  const staged = new Map<string, string>();
  const committed: PreparedTextEdit[] = [];
  const makeTemp = (target: string, kind: 'stage' | 'rollback'): string =>
    path.join(path.dirname(target), `.clf-${kind}-${process.pid}-${randomUUID()}.tmp`);
  const writeTemp = async (temp: string, data: Buffer): Promise<void> => {
    try {
      const handle = await fs.open(temp, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  };

  try {
    // Stage every complete new file first. Same-directory temps keep the final rename on one volume and avoid exposing partially written target files.
    for (const item of prepared) {
      const temp = makeTemp(item.realPath, 'stage');
      await writeTemp(temp, item.nextBytes);
      staged.set(item.realPath, temp);
    }

    for (const item of prepared) {
      // Refuse to clobber a file another process changed after our preflight.
      const current = await fs.readFile(item.realPath);
      if (!current.equals(item.originalBytes)) {
        throw new FsOpError(`${item.virtualPath}: file changed after preflight; batch was aborted`);
      }
      const temp = staged.get(item.realPath);
      if (!temp) throw new FsOpError(`${item.virtualPath}: internal staging file is missing`);
      await fs.rename(temp, item.realPath);
      staged.delete(item.realPath);
      committed.push(item);
    }
  } catch (err) {
    const rollbackProblems: string[] = [];
    for (const item of [...committed].reverse()) {
      try {
        const current = await fs.readFile(item.realPath);
        if (!current.equals(item.nextBytes)) {
          rollbackProblems.push(`${item.virtualPath} changed again before rollback`);
          continue;
        }
        const rollbackTemp = makeTemp(item.realPath, 'rollback');
        await writeTemp(rollbackTemp, item.originalBytes);
        try {
          await fs.rename(rollbackTemp, item.realPath);
        } finally {
          await fs.rm(rollbackTemp, { force: true }).catch(() => undefined);
        }
      } catch (rollbackErr) {
        rollbackProblems.push(`${item.virtualPath}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }
    for (const temp of staged.values()) await fs.rm(temp, { force: true }).catch(() => undefined);

    const reason = err instanceof Error ? err.message : String(err);
    if (rollbackProblems.length > 0) {
      throw new FsOpError(
        `${reason}. Rollback could not safely restore every committed file: ${rollbackProblems.join('; ')}`
      );
    }
    throw err;
  }

  return prepared.map((item) => ({
    virtualPath: item.virtualPath,
    replacements: item.replacements,
    bytes: item.nextBytes.length,
    delta: item.delta
  }));
}

