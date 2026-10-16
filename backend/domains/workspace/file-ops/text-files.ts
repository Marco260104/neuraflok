import { rawPromises as fs } from '../rawfs.js';
import { lineDelta, type LineDelta } from '../diffstat.js';
import { FsOpError } from './limits.js';

const BINARY_SNIFF_BYTES = 8192;
const MAX_DIFF_READ_BYTES = 8 * 1024 * 1024;

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';
export interface TextFormat {
  encoding: TextEncoding;
  bom: boolean;
}

export async function textFormat(realPath: string): Promise<TextFormat> {
  const handle = await fs.open(realPath, 'r');
  try {
    const head = Buffer.alloc(3);
    const { bytesRead } = await handle.read(head, 0, 3, 0);
    if (bytesRead >= 2 && head[0] === 0xff && head[1] === 0xfe) {
      return { encoding: 'utf-16le', bom: true };
    }
    if (bytesRead >= 2 && head[0] === 0xfe && head[1] === 0xff) {
      return { encoding: 'utf-16be', bom: true };
    }
    return {
      encoding: 'utf-8',
      bom: bytesRead >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
    };
  } finally {
    await handle.close();
  }
}

export function decodeText(data: Buffer, format: TextFormat): string {
  return stripBom(new TextDecoder(format.encoding).decode(data));
}

export function encodeText(text: string, format: TextFormat, includeBom: boolean): Buffer {
  if (format.encoding === 'utf-8') {
    const body = Buffer.from(text, 'utf8');
    return includeBom && format.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  const body = Buffer.from(text, 'utf16le');
  if (format.encoding === 'utf-16be') body.swap16();
  if (!includeBom || !format.bom) return body;
  return Buffer.concat([
    format.encoding === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]),
    body
  ]);
}

/** Applies the binary sniff heuristic to bytes a caller already has in hand. */
export function sniffBinaryBytes(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  // UTF-16 text contains NUL bytes by design, so detect its BOM before applying the usual binary heuristic. UTF-8 BOM is harmless as well.
  if (
    (slice.length >= 2 && slice[0] === 0xff && slice[1] === 0xfe) ||
    (slice.length >= 2 && slice[0] === 0xfe && slice[1] === 0xff) ||
    (slice.length >= 3 && slice[0] === 0xef && slice[1] === 0xbb && slice[2] === 0xbf)
  ) {
    return false;
  }
  // A NUL byte in the first 8 KiB is the standard heuristic and is what git uses.
  if (slice.includes(0)) return true;
  // A high proportion of bytes that are neither printable nor common whitespace catches things like compressed data that happen to avoid NUL.
  let suspicious = 0;
  for (const byte of slice) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) suspicious++;
  }
  return suspicious / slice.length > 0.3;
}

/** Reads the first bytes of a file to decide whether it is binary. */
export async function sniffBinary(realPath: string): Promise<boolean> {
  const handle = await fs.open(realPath, 'r');
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    return sniffBinaryBytes(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Above this the pre-read that makes a whole-file rewrite countable is skipped. */

/** Rewrites a text file and reports how many lines that changed. The original is read back first purely to make the count real. That costs one read of a file we are about to overwrite anyway, and it is skipped for very large files, where the delta falls back to the honest approximation of "all lines replaced". */
export async function replaceTextFile(
  realPath: string,
  content: string
): Promise<{ bytes: number; delta: LineDelta }> {
  const format = await textFormat(realPath);
  let original: string | null = null;
  try {
    const stat = await fs.stat(realPath);
    if (stat.size <= MAX_DIFF_READ_BYTES) original = decodeText(await fs.readFile(realPath), format);
  } catch {
    // Unreadable or missing: the file is still written, only the count is coarser.
  }
  const encoded = encodeText(content, format, true);
  await fs.writeFile(realPath, encoded);
  return {
    bytes: encoded.length,
    delta:
      original === null
        ? { added: countTextLines(content), removed: 0, approximate: true }
        : lineDelta(original, content)
  };
}

function countTextLines(text: string): number {
  if (text === '') return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

export async function appendTextFile(realPath: string, content: string): Promise<{ bytes: number; added: number }> {
  let format: TextFormat = { encoding: 'utf-8', bom: false };
  try {
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) throw new FsOpError('Not a file');
    format = await textFormat(realPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const encoded = encodeText(content, format, false);
  await fs.appendFile(realPath, encoded);
  return { bytes: encoded.length, added: countTextLines(content) };
}

