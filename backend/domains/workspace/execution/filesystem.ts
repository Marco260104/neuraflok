/** Bounded filesystem operations used by the workspace. */

import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import nodePath from 'node:path';

import { rawPromises } from '../rawfs.js';

export const MAX_READ_FILE_BYTES = 512 * 1024 * 1024;
export const FILE_READ_CHUNK_SIZE = 1024 * 1024;
export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_DIRECTORIES = 10_000;
export const MAX_WALK_ENTRIES = 50_000;
export const MAX_WALK_RESPONSE_BYTES = 4 * 1024 * 1024;
export const WALK_RESPONSE_ITEM_OVERHEAD_BYTES = 64;

/** Creates an input error with the errno expected by filesystem callers. */
export function invalidInput(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'EINVAL';
  return error;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(milliseconds: number): number {
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.trunc(milliseconds) : 0;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function fileTooLarge(limitBytes: number): NodeJS.ErrnoException {
  return invalidInput(`file is too large to read: limit is ${limitBytes} bytes`);
}

/** Opens a regular file and always releases its handle after the operation. */
async function withRegularFile<T>(
  path: string,
  operation: (handle: FileHandle, stats: Stats) => Promise<T>
): Promise<T> {
  const handle = await rawPromises.open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw invalidInput(`path \`${path}\` is not a file`);
    return await operation(handle, stats);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Normalized metadata for a filesystem entry. */
export interface FileMetadata {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  createdAtMs: number;
  modifiedAtMs: number;
}

/** Normalized name and type information for a directory entry. */
export interface ReadDirectoryEntry {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Options for creating a directory. */
export interface CreateDirectoryOptions {
  recursive: boolean;
}

/** Options for removing a filesystem entry. */
export interface RemoveOptions {
  recursive: boolean;
  force: boolean;
}

/** Bounds and traversal rules for a recursive filesystem walk. */
export interface WalkOptions {
  maxDepth: number;
  maxDirectories: number;
  maxEntries: number;
  followDirectorySymlinks: boolean;
  pruneHiddenDirectories?: boolean;
  pruneDirectory?: (entry: ReadDirectoryEntry, path: string) => boolean;
}

export type WalkEntryKind = 'directory' | 'file';

/** One filesystem entry returned by a walk. */
export interface WalkEntry {
  path: string;
  kind: WalkEntryKind;
}

/** A descendant that could not be inspected during a walk. */
export interface WalkError {
  path: string;
  message: string;
}

/** Entries, recoverable errors, and truncation state from a bounded walk. */
export interface WalkOutcome {
  entries: WalkEntry[];
  errors: WalkError[];
  truncated: boolean;
}

interface WalkState {
  outcome: WalkOutcome;
  responseBytes: number;
  examinedEntries: number;
  visitedDirectories: Set<string>;
  queuedDirectories: Array<{ path: string; depth: number }>;
  directoryCount: number;
}

function appendWalkResult(state: WalkState, contentBytes: number, publish: () => void): boolean {
  const nextSize = state.responseBytes + contentBytes + WALK_RESPONSE_ITEM_OVERHEAD_BYTES;
  if (nextSize > MAX_WALK_RESPONSE_BYTES) {
    state.outcome.truncated = true;
    return false;
  }
  state.responseBytes = nextSize;
  publish();
  return true;
}

function appendWalkError(state: WalkState, path: string, message: string): boolean {
  const size = utf8Length(path) + utf8Length(message);
  return appendWalkResult(state, size, () => state.outcome.errors.push({ path, message }));
}

/** Resolves a path to its canonical filesystem location. */
export async function canonicalize(path: string): Promise<string> {
  return rawPromises.realpath(path);
}

/** Reads a bounded file and rejects files that exceed the configured byte ceiling. */
export async function readFile(path: string, maxBytes: number = MAX_READ_FILE_BYTES): Promise<Buffer> {
  const limit = Number.isFinite(maxBytes)
    ? Math.max(1, Math.min(MAX_READ_FILE_BYTES, Math.floor(maxBytes)))
    : MAX_READ_FILE_BYTES;
  return withRegularFile(path, async (handle, stats) => {
    if (stats.size > limit) throw fileTooLarge(limit);
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_SIZE, limit + 1));
    let length = 0;
    while (length <= limit) {
      const capacity = Math.min(buffer.length, limit + 1 - length);
      const { bytesRead } = await handle.read(buffer, 0, capacity, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > limit) throw fileTooLarge(limit);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, length);
  });
}

/** Streams a regular file in fixed-size chunks. */
export async function* readFileStream(path: string): AsyncGenerator<Buffer, void, undefined> {
  const handle = await rawPromises.open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw invalidInput(`path \`${path}\` is not a file`);
    const chunk = Buffer.allocUnsafe(FILE_READ_CHUNK_SIZE);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return;
      yield Buffer.from(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Reads a whole file and rejects malformed UTF-8. */
export async function readFileText(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const error = new Error('stream did not contain valid UTF-8') as NodeJS.ErrnoException;
    error.code = 'EILSEQ';
    throw error;
  }
}

/** Writes bytes or text to a file. */
export async function writeFile(path: string, contents: Buffer | string): Promise<void> {
  await rawPromises.writeFile(path, contents);
}

/** Creates a directory with the requested recursion behavior. */
export async function createDirectory(path: string, options: CreateDirectoryOptions): Promise<void> {
  await rawPromises.mkdir(path, { recursive: options.recursive });
}

/** Reads target metadata while retaining whether the original path is a symlink. */
export async function getMetadata(path: string): Promise<FileMetadata> {
  const linkStats = await rawPromises.lstat(path);
  const isSymlink = linkStats.isSymbolicLink();
  const stats = isSymlink ? await rawPromises.stat(path) : linkStats;
  return {
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymlink,
    size: stats.size,
    createdAtMs: timestamp(stats.birthtimeMs),
    modifiedAtMs: timestamp(stats.mtimeMs)
  };
}

/** Lists direct children without following symlinks during classification. */
export async function readDirectory(path: string): Promise<ReadDirectoryEntry[]> {
  const children = await rawPromises.readdir(path, { withFileTypes: true });
  return children.map(child => ({
    fileName: child.name,
    isDirectory: !child.isSymbolicLink() && child.isDirectory(),
    isFile: !child.isSymbolicLink() && child.isFile()
  }));
}

/** Removes a file, symlink, or directory using the requested options. */
export async function remove(path: string, options: RemoveOptions): Promise<void> {
  let stats: Stats;
  try {
    stats = await rawPromises.lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && options.force) return;
    throw error;
  }
  if (!stats.isDirectory()) {
    await rawPromises.unlink(path);
    return;
  }
  if (options.recursive) await rawPromises.rm(path, { recursive: true });
  else await rawPromises.rmdir(path);
}

/** Walks directories breadth-first and returns bounded partial results when a limit is reached. */
export async function walk(root: string, options: WalkOptions): Promise<WalkOutcome> {
  if (options.maxDirectories <= 0 || options.maxEntries <= 0) {
    throw invalidInput('filesystem walk limits must be greater than zero');
  }
  if (
    options.maxDepth > MAX_WALK_DEPTH ||
    options.maxDirectories > MAX_WALK_DIRECTORIES ||
    options.maxEntries > MAX_WALK_ENTRIES
  ) {
    throw invalidInput(
      `filesystem walk limits exceed maximums: depth=${MAX_WALK_DEPTH}, directories=${MAX_WALK_DIRECTORIES}, entries=${MAX_WALK_ENTRIES}`
    );
  }

  const rootInfo = await getMetadata(root);
  if (!rootInfo.isDirectory || (rootInfo.isSymlink && !options.followDirectorySymlinks)) {
    return { entries: [], errors: [], truncated: false };
  }

  const outcome: WalkOutcome = { entries: [], errors: [], truncated: false };
  const firstIdentity = options.followDirectorySymlinks ? await canonicalize(root) : root;
  const state: WalkState = {
    outcome,
    responseBytes: 0,
    examinedEntries: 0,
    visitedDirectories: new Set([firstIdentity]),
    queuedDirectories: [{ path: root, depth: 0 }],
    directoryCount: 1
  };

  for (let queueIndex = 0; queueIndex < state.queuedDirectories.length; queueIndex++) {
    const current = state.queuedDirectories[queueIndex]!;
    let children: ReadDirectoryEntry[];
    try {
      children = await readDirectory(current.path);
    } catch (error) {
      if (!appendWalkError(state, current.path, errorMessage(error))) return outcome;
      continue;
    }
    children.sort((left, right) => left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0);

    for (const child of children) {
      if (state.examinedEntries >= options.maxEntries) {
        outcome.truncated = true;
        return outcome;
      }
      state.examinedEntries++;
      const childPath = nodePath.join(current.path, child.fileName);
      let info: FileMetadata;
      try {
        info = await getMetadata(childPath);
      } catch (error) {
        if (!appendWalkError(state, childPath, errorMessage(error))) return outcome;
        continue;
      }
      if (info.isSymlink && (!options.followDirectorySymlinks || !info.isDirectory)) continue;

      const kind: WalkEntryKind | null = info.isDirectory ? 'directory' : info.isFile ? 'file' : null;
      if (!kind) continue;
      if (!appendWalkResult(state, utf8Length(childPath), () => outcome.entries.push({ path: childPath, kind }))) {
        return outcome;
      }
      if (kind !== 'directory') continue;
      if (options.pruneHiddenDirectories === true && child.fileName.startsWith('.')) continue;
      if (options.pruneDirectory?.(child, childPath) === true) continue;
      if (current.depth >= options.maxDepth) {
        outcome.truncated = true;
        continue;
      }

      let identity = childPath;
      if (options.followDirectorySymlinks) {
        try {
          identity = await canonicalize(childPath);
        } catch (error) {
          if (!appendWalkError(state, childPath, errorMessage(error))) return outcome;
          continue;
        }
      }
      if (state.visitedDirectories.has(identity)) continue;
      state.visitedDirectories.add(identity);
      if (state.directoryCount >= options.maxDirectories) {
        outcome.truncated = true;
        continue;
      }
      state.directoryCount++;
      state.queuedDirectories.push({ path: childPath, depth: current.depth + 1 });
    }
  }

  return outcome;
}
