import { FsOpError, MAX_READ_BYTES } from '../limits.js';

export const BINARY_SNIFF_BYTES = 8192;
export const MAX_LINE_COUNT_BYTES = MAX_READ_BYTES * 8;
export const MAX_DECODED_LINE_CHARS = 2 * 1024 * 1024;

export interface TextFormat {
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  bom: boolean;
}

export interface ReadTextResult {
  text: string;
  truncated: boolean;
  hasMore: boolean;
  firstLine: number;
  lastLine: number;
  totalLines: number | null;
  bytesReturned: number;
  fileBytes: number;
}

export function detectTextFormat(head: Buffer): TextFormat {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bom: true };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bom: true };
  return {
    encoding: 'utf-8',
    bom: head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  };
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export class BinaryReadError extends FsOpError {}
