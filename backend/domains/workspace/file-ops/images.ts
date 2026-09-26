import { rawPromises as fs } from '../rawfs.js';
import { FsOpError, MAX_IMAGE_BYTES, MAX_BINARY_BASE64_CHARS, MAX_BINARY_WRITE_BYTES, formatBytes } from './limits.js';

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function imageMime(data: Buffer): SupportedImageMime | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return null;
}

let pngCrcTable: Uint32Array | null = null;

function pngCrc32(data: Buffer, start: number, end: number): number {
  if (!pngCrcTable) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    pngCrcTable = table;
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = pngCrcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function invalidImage(kind: string, detail: string): never {
  throw new FsOpError(`Invalid or corrupt ${kind} image: ${detail}`);
}

function validatePng(data: Buffer): void {
  if (data.length < 33) invalidImage('PNG', 'file is too short');
  let offset = 8;
  let first = true;
  let sawIend = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (crcOffset + 4 > data.length) invalidImage('PNG', 'a chunk extends past the end of the file');
    const type = data.subarray(typeStart, dataStart).toString('ascii');
    if (first) {
      if (type !== 'IHDR' || length !== 13) invalidImage('PNG', 'IHDR is missing or malformed');
      const width = data.readUInt32BE(dataStart);
      const height = data.readUInt32BE(dataStart + 4);
      if (width === 0 || height === 0) invalidImage('PNG', 'image dimensions are zero');
      first = false;
    }
    const expectedCrc = data.readUInt32BE(crcOffset);
    const actualCrc = pngCrc32(data, typeStart, crcOffset);
    if (expectedCrc !== actualCrc) invalidImage('PNG', `CRC check failed for ${type || 'unknown'} chunk`);
    offset = crcOffset + 4;
    if (type === 'IEND') {
      if (length !== 0) invalidImage('PNG', 'IEND chunk is malformed');
      sawIend = true;
      break;
    }
  }
  if (!sawIend) invalidImage('PNG', 'IEND chunk is missing');
}

function validateJpeg(data: Buffer): void {
  // EOI ends the JPEG codestream, not necessarily the containing file. Downloads can carry trailing bytes (including a newline). Pixel decoding remains mandatory at the MCP image boundary; finding this marker alone never proves valid scan data.
  const end = data.lastIndexOf(Buffer.from([0xff, 0xd9]));
  if (data.length < 8 || end < 2) {
    invalidImage('JPEG', 'end marker is missing');
  }
  let offset = 2;
  let sawFrame = false;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < end) {
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) break;
    const marker = data[offset++]!;
    if (marker === 0xd9) break;
    if (marker === 0xda) break; // scan data continues until the already-validated EOI marker
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) invalidImage('JPEG', 'segment length is truncated');
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) invalidImage('JPEG', 'segment extends past the end of the file');
    if (frameMarkers.has(marker)) {
      if (length < 7) invalidImage('JPEG', 'frame header is malformed');
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) invalidImage('JPEG', 'image dimensions are zero');
      sawFrame = true;
    }
    offset += length;
  }
  if (!sawFrame) invalidImage('JPEG', 'frame header is missing');
}

function validateGif(data: Buffer): void {
  if (data.length < 14) invalidImage('GIF', 'file is too short');
  if (data.readUInt16LE(6) === 0 || data.readUInt16LE(8) === 0) invalidImage('GIF', 'image dimensions are zero');
  if (data[data.length - 1] !== 0x3b) invalidImage('GIF', 'trailer is missing');
}

function validateWebp(data: Buffer): void {
  if (data.length < 20) invalidImage('WebP', 'file is too short');
  if (data.readUInt32LE(4) + 8 !== data.length) invalidImage('WebP', 'RIFF size does not match the file');
  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= data.length) {
    const type = data.subarray(offset, offset + 4).toString('ascii');
    const length = data.readUInt32LE(offset + 4);
    const next = offset + 8 + length + (length & 1);
    if (next > data.length) invalidImage('WebP', 'a chunk extends past the end of the file');
    if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') sawImageChunk = true;
    offset = next;
  }
  if (!sawImageChunk) invalidImage('WebP', 'image payload chunk is missing');
}

export function validateImageStructure(data: Buffer, mimeType: SupportedImageMime): void {
  if (mimeType === 'image/png') validatePng(data);
  else if (mimeType === 'image/jpeg') validateJpeg(data);
  else if (mimeType === 'image/gif') validateGif(data);
  else validateWebp(data);
}

export async function readImageFile(
  realPath: string
): Promise<{ data: string; mimeType: SupportedImageMime; bytes: number }> {
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new FsOpError('Not a file');
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new FsOpError(
      `Image is too large to return (${formatBytes(stat.size)}; limit ${formatBytes(MAX_IMAGE_BYTES)})`
    );
  }
  const data = await fs.readFile(realPath);
  const mimeType = imageMime(data);
  if (!mimeType) {
    throw new FsOpError('Unsupported image format. Use PNG, JPEG, GIF or WebP.');
  }
  validateImageStructure(data, mimeType);
  return { data: data.toString('base64'), mimeType, bytes: data.length };
}

export function decodeBase64Data(input: string): Buffer {
  const clean = input.replace(/\s+/g, '');
  if (clean.length === 0) throw new FsOpError('Binary data is empty');
  if (clean.length > MAX_BINARY_BASE64_CHARS) {
    throw new FsOpError(`Base64 payload is too large (limit ${MAX_BINARY_BASE64_CHARS} characters)`);
  }
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean) || /=/.test(clean.slice(0, -2))) {
    throw new FsOpError('Binary data is not valid base64');
  }
  const standard = clean.replace(/-/g, '+').replace(/_/g, '/');
  if (standard.length % 4 === 1) throw new FsOpError('Binary data is not valid base64');
  const data = Buffer.from(standard, 'base64');
  const canonical = data.toString('base64').replace(/=+$/, '');
  if (canonical !== standard.replace(/=+$/, '')) throw new FsOpError('Binary data is not valid base64');
  if (data.length > MAX_BINARY_WRITE_BYTES) {
    throw new FsOpError(
      `Binary data is too large (${formatBytes(data.length)}; limit ${formatBytes(MAX_BINARY_WRITE_BYTES)})`
    );
  }
  return data;
}

