// Resolves workspace paths into bounded text, image, folder, and metadata results.
import nodePath from 'node:path';
import { MAX_READ_BYTES, formatBytes } from '../../../domains/workspace/fsops.js';
import { listDirectoryLevel, walkFiles } from '../../../domains/workspace/file-ops/reads/directory-reads.js';
import { BinaryReadError } from '../../../domains/workspace/file-ops/reads/read-contract.js';
import { statInfo } from '../../../domains/workspace/file-ops/reads/file-metadata.js';
import { readTextFile } from '../../../domains/workspace/file-ops/reads/text-range-reader.js';
import { inspectLocalImage } from '../../../domains/workspace/execution/image-inspection.js';
import { logInfo } from '../../settings/logger.js';
import { SandboxError, resolvePath } from '../../settings/sandbox.js';
import type { Root } from '../../../../contracts/types.js';
import { DEFAULT_EXCLUDES } from '../../../domains/workspace/file-ops/search/contracts.js';
import { globToRegExp } from '../../../domains/workspace/file-ops/search/matchers.js';
import { noteDetail } from './call-context.js';
import { resolveIn } from './kernel.js';
import { formatWorkspaceFileMetadata } from '../presentation/file-metadata.js';

const MAX_DIR_ENTRIES = 200;
export const MAX_GLOB_MATCHES = 20;
export const MAX_READ_TARGETS = 40;
export const MAX_READ_IMAGES = 4;
export const MAX_READ_IMAGE_BYTES = 12 * 1024 * 1024;
export const GLOB_SCAN_LIMIT = 5_000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// read helpers

export function hasGlob(path: string): boolean {
  return path.includes('*') || path.includes('?');
}

// Expands a glob to real virtual paths, bounded twice over. Bounded on the walk (`GLOB_SCAN_LIMIT`) so a pattern rooted at a huge tree cannot spend minutes, and bounded on the result (`MAX_GLOB_MATCHES`) so a pattern cannot quietly turn one call into a bulk read of a repository. Both bounds are reported rather than silently applied — a truncated expansion the model does not know about is worse than no expansion.
export async function expandGlob(
  roots: Parameters<typeof resolvePath>[0],
  pattern: string
): Promise<{ matches: string[]; truncated: 'matches' | 'scan' | null }> {
  const normalised = process.platform === 'win32' ? pattern.replace(/\\/g, '/') : pattern;
  const segments = normalised.split('/');
  const baseSegments: string[] = [];
  for (const segment of segments) {
    if (hasGlob(segment)) break;
    baseSegments.push(segment);
  }
  // A leading wildcard is workspace-relative. Substituting `/` here silently changed `*.ts` into an absolute virtual-root lookup and made every learned workspace useless.
  const base = baseSegments.join('/') || (normalised.startsWith('/') ? '/' : '');
  const rest = segments.slice(baseSegments.length).join('/');
  if (!rest) return { matches: [normalised], truncated: null };

  const resolved = await resolveIn(roots, base, { access: 'read' });
  const info = await statInfo(resolved.real, resolved.virtual, { scanContent: false });
  if (info.type !== 'directory') throw new SandboxError(`${resolved.virtual} is not a folder, so it cannot be globbed`);

  // `**` walks with the bounded breadth-first walk; a single-level pattern needs one directory read and nothing more.
  let candidates: string[];
  let scanTruncated = false;
  if (rest.includes('**')) {
    const walked = await walkFiles(resolved.real, resolved.virtual, {
      maxEntries: GLOB_SCAN_LIMIT,
      exclude: DEFAULT_EXCLUDES
    });
    candidates = walked.files;
    scanTruncated = walked.truncated;
  } else {
    const listed = await listDirectoryLevel(resolved.real, resolved.virtual, GLOB_SCAN_LIMIT, false);
    candidates = listed.entries.filter((entry) => entry.type === 'file').map((entry) => entry.virtualPath);
    scanTruncated = listed.truncated;
  }

  const matcher = globToRegExp(rest, false);
  const prefixLength = resolved.virtual.length + 1;
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (!matcher.test(candidate.slice(prefixLength))) continue;
    // Truncation means there is an actual omitted match, not merely that the result landed exactly on the cap. Returning `matches` as soon as the 20th item was added made a folder with exactly 20 matches claim "more than 20 matches" and sent the model narrowing a query that had already been answered completely.
    if (matches.length >= MAX_GLOB_MATCHES) return { matches, truncated: 'matches' };
    matches.push(candidate);
  }
  return { matches, truncated: scanTruncated ? 'scan' : null };
}

interface ReadOneOptions {
  roots: Parameters<typeof resolvePath>[0];
  canRead: boolean;
  canBrowse: boolean;
  startLine?: number;
  endLine?: number;
  maxBytes: number;
  imageBytes: number;
}

export interface ReadTarget {
  path: string;
  // A range the caller attached to this one path, or null for the call-wide range.
  range: { start: number; end: number | undefined } | null;
}

// Reads a `path:12-40` or `path:12` suffix off one requested path. It is the spelling a model reaches for when it wants several ranges of one file in one call, and the sandbox used to refuse it as a colon in a path — five calls across the 50 most recent recorded sessions, each carrying three or four ranges of the same file. Only a suffix after the last separator counts, so a `C:\\...` drive letter is never read as a range, and a range that runs backwards is left on the path for the sandbox to refuse as before.
export function splitLineRange(requested: string): { path: string; range: ReadTarget['range'] } {
  const match = /^(.*[^\\/:]):(\d{1,9})(?:-(\d{1,9}))?$/.exec(requested);
  if (!match) return { path: requested, range: null };
  const start = Number(match[2]);
  const end = match[3] === undefined ? undefined : Number(match[3]);
  if (start < 1 || (end !== undefined && end < start)) return { path: requested, range: null };
  return { path: match[1]!, range: { start, end } };
}

// How many entries a not-found error lists from the nearest folder that does exist.
const MISSING_PATH_LISTING = 40;

// For a path that does not exist, the nearest folder above it that does, listed. "Not found" alone sends the model into a listing call it could have been spared: in the 50 most recent recorded sessions the single most repeated read failure was a repository file guessed one folder too high, followed by a read of the folder to see what was there. Listing the nearest existing ancestor answers that follow-up in the same reply. It walks up through the sandbox one level at a time and says nothing unless a folder resolved.
export async function nearestFolderListing(roots: Root[], requested: string, err: unknown): Promise<string> {
  if (!(err instanceof SandboxError) || !err.message.startsWith('Not found:')) return '';
  let candidate = requested;
  for (let depth = 0; depth < 8; depth++) {
    const parent = candidate.replace(/[\\/]+[^\\/]+[\\/]*$/, '');
    if (parent === candidate || parent === '' || /^[A-Za-z]:$/.test(parent)) return '';
    candidate = parent;
    let resolved;
    try {
      resolved = await resolveIn(roots, candidate, { access: 'read' });
    } catch (error) {
      if (error instanceof SandboxError && error.message.startsWith('Not found:')) continue;
      return '';
    }
    try {
      const { entries, truncated } = await listDirectoryLevel(resolved.real, resolved.virtual, MISSING_PATH_LISTING, false);
      const names = entries.map((entry) => `${entry.type === 'directory' ? 'd' : 'f'} ${entry.name}`);
      const more = truncated ? `, …` : '';
      return `\nThe nearest existing folder is ${resolved.virtual}${
        entries.length === 0 ? ', and it is empty.' : `; it contains: ${names.join(', ')}${more}`
      }`;
    } catch {
      return '';
    }
  }
  return '';
}

// One path, one section of output, and the byte cost of producing it. The three result shapes are decided here rather than by an action argument, because from the caller's side they are one question — what is at this path — and asking a model to pick the right verb for a path it has not looked at yet is how `read_file` on a directory became a routine error.
export async function readOne(
  requested: string,
  options: ReadOneOptions
): Promise<{ text: string; bytes: number; image?: { data: string; mimeType: string } }> {
  // The virtual root itself: a model that has not looked yet naturally starts at "/", and "Path is empty" left it guessing the names. The shared folders are what "/" contains.
  if (typeof requested === 'string' && (process.platform === 'win32' ? /^[/\\]+$/ : /^\/+$/).test(requested.trim())) {
    if (!options.canBrowse) {
      return { text: `--- / ---\nTOOL_DISABLED: listing folders needs the Browse folders permission.`, bytes: 0 };
    }
    const text = options.roots.length === 0
      ? '--- / — no folders are shared yet ---'
      : `--- / — ${options.roots.length} entr${options.roots.length === 1 ? 'y' : 'ies'}, one level ---\n${options.roots.map(root => `d ${root.name}`).join('\n')}`;
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }
  const resolved = await resolveIn(options.roots, requested, { access: 'read' });
  const info = await statInfo(resolved.real, resolved.virtual, { scanContent: !options.canRead });

  if (info.type === 'directory') {
    if (!options.canBrowse) {
      return { text: `--- ${resolved.virtual} ---\nTOOL_DISABLED: listing folders needs the Browse folders permission.`, bytes: 0 };
    }
    const { entries, truncated } = await listDirectoryLevel(resolved.real, resolved.virtual, MAX_DIR_ENTRIES);
    const prefixLength = resolved.virtual.length + 1;
    const body = entries
      .map((entry) => {
        const kind = entry.type === 'directory' ? 'd' : entry.type === 'file' ? 'f' : '?';
        const size = entry.bytes === null ? '' : `  ${formatBytes(entry.bytes)}`;
        return `${kind} ${entry.virtualPath.slice(prefixLength)}${size}`;
      })
      .join('\n');
    const note = truncated
      ? `\n(stopped at ${MAX_DIR_ENTRIES} entries — read a subfolder, or use a glob such as ${resolved.virtual}/**/*.ts)`
      : '';
    const text =
      entries.length === 0
        ? `--- ${resolved.virtual} — empty folder ---`
        : `--- ${resolved.virtual} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, one level ---\n${body}${note}`;
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  if (info.type !== 'file') {
    const text = `--- ${resolved.virtual} ---\n${formatWorkspaceFileMetadata(info)}\nNot a regular file, so there is nothing to read.`;
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  if (!options.canRead) {
    // Metadata without content is a real answer when the user granted exactly that, and it is strictly better than refusing the path outright.
    const text = `--- ${resolved.virtual} ---\n${formatWorkspaceFileMetadata(info)}\n(file contents need the Read files permission)`;
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  const extension = nodePath.extname(resolved.virtual).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) {
    // The same loader `view_image` uses, so an image opened through either tool is validated and decoded identically. `view_image` still exists in its own right: it is the dedicated image tool, with its own name, schema, and errors, and this branch is only `read` continuing to answer "what is at this path" for a path that happens to be a picture. Text and image representations have separate aggregate bounds. An ordinary screenshot must not fail solely because it is larger than the text budget. Still charge base64, not just compressed file bytes, and refuse an exhausted image batch before decoding.
    if (options.imageBytes <= 0) throw new Error('Read image output cap reached; read remaining images in another call or use view_image.');
    const image = await inspectLocalImage(resolved.real, resolved.virtual);
    logInfo(`tool read image ${resolved.virtual} (${formatBytes(image.bytes)})`);
    const text = `--- ${resolved.virtual} — ${formatBytes(image.bytes)} ${image.mimeType} ---`;
    if (image.base64.length > options.imageBytes) {
      throw new Error(
        `Read image output cap reached (${formatBytes(MAX_READ_IMAGE_BYTES)} base64 per call); read remaining images in another call or use view_image.`
      );
    }
    return {
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      image: { data: image.base64, mimeType: image.mimeType }
    };
  }

  if (info.binary) {
    // Never dumped as base64. A model that asked to read a .dll wanted to know what it is, and several megabytes of base64 answers a question nobody asked at ruinous cost.
    const text =
      `--- ${resolved.virtual} ---\n${formatWorkspaceFileMetadata(info)}\n` +
      'Binary file, so its bytes are not returned. Use exec_command if you need to inspect or convert it.';
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }

  let result;
  try {
    result = await readTextFile(resolved.real, {
      startLine: options.startLine,
      endLine: options.endLine,
      maxBytes: options.maxBytes
    });
  } catch (error) {
    if (!(error instanceof BinaryReadError)) throw error;
    info.binary = true;
    const text =
      `--- ${resolved.virtual} ---\n${formatWorkspaceFileMetadata(info)}\n` +
      'Binary file, so its bytes are not returned. Use exec_command if you need to inspect or convert it.';
    return { text, bytes: Buffer.byteLength(text, 'utf8') };
  }
  if (result.lastLine >= result.firstLine) noteDetail(`lines ${result.firstLine}–${result.lastLine}`);
  // How long is this file? That is the question the header's line count exists to answer, and it used to go unanswered on exactly the reads that needed it: a range read stopped at `end_line`, so `totalLines` was null and the header said `lines 600-750` with no denominator. The caller could see what it had and not what it was a part of — which is how "600-750" gets mistaken for a whole file, and how a follow-up read gets aimed at a line that does not exist. `info.lines` is no help here: `readOne` calls `statInfo` with `scanContent: !canRead`, so in the ordinary read path the content scan is skipped and `info.lines` is null. The total now comes from the read itself, which counts on past the range (see `MAX_LINE_COUNT_BYTES`). So a total is missing in one case only — a range inside a file too big to be worth counting — and the header then states the range plainly rather than inventing a denominator.
  const numbered = boundedNumberedRead(
    result.text,
    result.firstLine,
    result.lastLine >= result.firstLine,
    options.maxBytes
  );
  const visibleLastLine = numbered.lastLine;
  const range =
    visibleLastLine < result.firstLine
      ? result.totalLines === null
        ? 'no lines in that range'
        : `no lines in that range; the file has ${result.totalLines}`
      : result.totalLines === null
        ? `lines ${result.firstLine}-${visibleLastLine}`
        : `lines ${result.firstLine}-${visibleLastLine} of ${result.totalLines}`;
  const note = result.truncated || numbered.truncated
    ? `\n(output cap reached; continue from line ${visibleLastLine + 1} or raise max_bytes up to ${MAX_READ_BYTES})`
    : result.hasMore
      ? `\n(more lines follow — continue from line ${visibleLastLine + 1})`
      : '';
  const header = `--- ${resolved.virtual} — ${range}, ${formatBytes(info.bytes)}, modified ${info.modified} ---`;
  const text = `${header}${numbered.text === '' && visibleLastLine < result.firstLine ? '' : `\n${numbered.text}`}${note}`;
  return {
    text,
    // Charge the aggregate call budget for what is actually serialized, including headers and line-number prefixes. Counting only raw file bytes let thousands of short lines amplify a nominal 512 KiB cap into a multi-megabyte MCP response.
    bytes: Buffer.byteLength(text, 'utf8')
  };
}

// Adds the model-visible line-number prefix without letting that metadata amplify a bounded file slice into an unbounded MCP result. `readTextFile` caps raw decoded bytes; a file made of hundreds of thousands of empty/tiny lines can add several extra megabytes of decimal prefixes afterwards. Spend the same budget on the numbered representation too. A real empty logical line is represented by `N\t`; `hasLine=false` is the only case that renders no row.
function boundedNumberedRead(
  text: string,
  firstLine: number,
  hasLine: boolean,
  maxBytes: number
): { text: string; lastLine: number; truncated: boolean } {
  if (!hasLine) return { text: '', lastLine: firstLine - 1, truncated: false };
  const lines = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let index = 0; index < lines.length; index++) {
    const rendered = `${firstLine + index}\t${lines[index] ?? ''}`;
    const cost = Buffer.byteLength(rendered, 'utf8') + (kept.length === 0 ? 0 : 1);
    // Always return the first logical line. The backend already guaranteed that raw line fits the requested budget; the small line-number prefix must not turn that into an empty-page retry loop.
    if (kept.length > 0 && bytes + cost > maxBytes) break;
    kept.push(rendered);
    bytes += cost;
  }
  return {
    text: kept.join('\n'),
    lastLine: firstLine + kept.length - 1,
    truncated: kept.length < lines.length
  };
}

