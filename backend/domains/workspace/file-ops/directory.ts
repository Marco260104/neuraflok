import { createHash } from 'node:crypto';
import { rawCreateReadStream as createReadStream, rawPromises as fs } from '../rawfs.js';
import path from 'node:path';
import { FsOpError, MAX_READ_BYTES, formatBytes } from './limits.js';
import { sniffBinary } from './text-files.js';

const MAX_LINE_COUNT_BYTES = MAX_READ_BYTES * 8;
const MAX_HASH_BYTES = 256 * 1024 * 1024;

export interface FileInfo {
  virtualPath: string;
  type: 'file' | 'directory' | 'other';
  bytes: number;
  modified: string;
  created: string;
  readOnly: boolean;
  binary: boolean | null;
  lines: number | null;
  sha256: string | null;
}

export async function statInfo(
  realPath: string,
  virtualPath: string,
  opts: { hash?: boolean } = {}
): Promise<FileInfo> {
  const stat = await fs.lstat(realPath);
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  const info: FileInfo = {
    virtualPath,
    type,
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    // 0o200 is the owner-write bit; Node maps the Windows read-only attribute onto it.
    readOnly: (stat.mode & 0o200) === 0,
    binary: null,
    lines: null,
    sha256: null
  };
  if (type !== 'file') return info;

  info.binary = await sniffBinary(realPath);
  if (!info.binary && stat.size <= MAX_LINE_COUNT_BYTES) {
    info.lines = await countLines(realPath);
  }
  if (opts.hash) {
    if (stat.size > MAX_HASH_BYTES) {
      throw new FsOpError(`File is too large to hash (${formatBytes(stat.size)})`);
    }
    info.sha256 = await hashFile(realPath);
  }
  return info;
}

async function countLines(realPath: string): Promise<number> {
  let count = 0;
  let sawAny = false;
  let endsWithNewline = true;
  const stream = createReadStream(realPath);
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    if (buf.length === 0) continue;
    sawAny = true;
    for (const byte of buf) if (byte === 10) count++;
    endsWithNewline = buf[buf.length - 1] === 10;
  }
  if (!sawAny) return 0;
  return endsWithNewline ? count : count + 1;
}

async function hashFile(realPath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(realPath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function isExcludedFolderName(name: string, patterns: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    return pattern.endsWith('*') ? lower.startsWith(pattern.slice(0, -1)) : lower === pattern;
  });
}

export interface DirEntry {
  name: string;
  virtualPath: string;
  type: 'file' | 'directory' | 'other';
  bytes: number | null;
}

/** Lists a directory, optionally recursing, always bounded by maxEntries. */
export async function listDirectory(
  realDir: string,
  virtualDir: string,
  opts: { recursive?: boolean; maxEntries: number; exclude: readonly string[] }
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const entries: DirEntry[] = [];
  let truncated = false;

  const walk = async (dir: string, virt: string, depth: number): Promise<void> => {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw err;
      return; // Unreadable subdirectory: skip rather than fail the whole listing.
    }
    dirents.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    for (const dirent of dirents) {
      if (entries.length >= opts.maxEntries) {
        truncated = true;
        return;
      }
      const isDir = dirent.isDirectory();
      if (isDir && opts.recursive && isExcludedFolderName(dirent.name, opts.exclude)) continue;
      const childVirtual = `${virt}/${dirent.name}`;
      let bytes: number | null = null;
      if (dirent.isFile()) {
        try {
          bytes = (await fs.stat(path.join(dir, dirent.name))).size;
        } catch {
          bytes = null;
        }
      }
      entries.push({
        name: dirent.name,
        virtualPath: childVirtual,
        type: isDir ? 'directory' : dirent.isFile() ? 'file' : 'other',
        bytes
      });
      if (isDir && opts.recursive) {
        await walk(path.join(dir, dirent.name), childVirtual, depth + 1);
      }
    }
  };

  await walk(realDir, virtualDir, 0);
  return { entries, truncated };
}

