import { getMetadata, readFileStream } from '../../execution/filesystem.js';
import { sniffBinaryBytes } from '../text-files.js';
import type { FileInfo } from '../directory.js';
import { BINARY_SNIFF_BYTES, MAX_LINE_COUNT_BYTES } from './read-contract.js';

async function scanFile(realPath: string, wantLines: boolean): Promise<{ binary: boolean; lines: number | null }> {
  let sniffed = false;
  let lines = 0;
  let sawAny = false;
  let endsWithNewline = true;

  for await (const chunk of readFileStream(realPath)) {
    if (chunk.length === 0) continue;
    if (!sniffed) {
      sniffed = true;
      if (sniffBinaryBytes(chunk.subarray(0, Math.min(BINARY_SNIFF_BYTES, chunk.length)))) {
        return { binary: true, lines: null };
      }
      if (!wantLines) return { binary: false, lines: null };
    }
    sawAny = true;
    for (const byte of chunk) if (byte === 10) lines++;
    endsWithNewline = chunk[chunk.length - 1] === 10;
  }

  if (!wantLines) return { binary: false, lines: null };
  if (!sawAny) return { binary: false, lines: 0 };
  return { binary: false, lines: endsWithNewline ? lines : lines + 1 };
}

export async function statInfo(
  realPath: string,
  virtualPath: string,
  options: { scanContent?: boolean } = {}
): Promise<FileInfo> {
  const metadata = await getMetadata(realPath);
  const type = metadata.isDirectory ? 'directory' : metadata.isFile ? 'file' : 'other';
  const info: FileInfo = {
    virtualPath,
    type,
    bytes: metadata.size,
    modified: new Date(metadata.modifiedAtMs).toISOString(),
    created: new Date(metadata.createdAtMs).toISOString(),
    readOnly: false,
    binary: null,
    lines: null,
    sha256: null
  };
  if (type !== 'file') return info;
  if (options.scanContent === false) return info;

  const scan = await scanFile(realPath, metadata.size <= MAX_LINE_COUNT_BYTES);
  info.binary = scan.binary;
  info.lines = scan.lines;
  return info;
}
