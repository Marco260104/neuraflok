import { createHash } from 'node:crypto';
import { rawPromises as fs } from '../../rawfs.js';
import { MAX_PREVIEW_BYTES } from './limits.js';
import { recheckTarget, sameFile, type ProjectFileTarget } from './target.js';

export async function textSnapshot(target: Omit<ProjectFileTarget, 'kind'>) {
  const before = await fs.lstat(target.real);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular file');
  const handle = await fs.open(target.real, 'r');
  try {
    const stat = await handle.stat();
    if (!sameFile(before, stat)) throw new Error('File changed on disk. Reload it before saving your edits.');
    if (stat.size > MAX_PREVIEW_BYTES) throw new Error('This file is too large for the editor');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('File changed while being read');
      offset += bytesRead;
    }
    await recheckTarget(target);
    if (!sameFile(stat, await handle.stat()) || !sameFile(stat, await fs.lstat(target.real))) {
      throw new Error('File changed on disk. Reload it before saving your edits.');
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { throw new Error('This file is not UTF-8 text and cannot be edited here'); }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) throw new Error('Binary files cannot be edited here');
    const revision = createHash('sha256').update(data)
      .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex');
    return { data, text, stat, revision };
  } finally { await handle.close(); }
}
