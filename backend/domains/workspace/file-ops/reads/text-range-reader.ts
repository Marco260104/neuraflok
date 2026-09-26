import { getMetadata, readFileStream } from '../../execution/filesystem.js';
import { DEFAULT_READ_BYTES, FsOpError, MAX_READ_BYTES, clamp, formatBytes } from '../limits.js';
import { sniffBinaryBytes } from '../text-files.js';
import { BINARY_SNIFF_BYTES, MAX_DECODED_LINE_CHARS, MAX_LINE_COUNT_BYTES, BinaryReadError, detectTextFormat, stripBom, type ReadTextResult } from './read-contract.js';

export async function readTextFile(
  realPath: string,
  opts: { startLine?: number; endLine?: number; maxBytes?: number } = {}
): Promise<ReadTextResult> {
  const metadata = await getMetadata(realPath);
  if (!metadata.isFile) throw new FsOpError('Not a file');

  const maxBytes = clamp(opts.maxBytes ?? DEFAULT_READ_BYTES, 1, MAX_READ_BYTES);
  const startLine = opts.startLine === undefined ? 1 : Math.max(1, Math.floor(opts.startLine));
  const endLine = opts.endLine === undefined ? Infinity : Math.floor(opts.endLine);
  if (endLine < startLine) throw new FsOpError('endLine must be greater than or equal to startLine');

  let countToEnd = metadata.size <= MAX_LINE_COUNT_BYTES;
  const out: string[] = [];
  let bytesReturned = 0;
  let lineNo = 0;
  let firstLine = 0;
  let lastLine = 0;
  let carry = '';
  let truncated = false;
  let budgetExhausted = false;
  let sawAllLines = true;
  let decoder: TextDecoder | null = null;
  let bytesScanned = 0;
  let passedRange = false;

  const pushLine = (line: string): boolean => {
    lineNo++;
    if (lineNo < startLine) return true;
    if (lineNo > endLine) {
      passedRange = true;
      return countToEnd;
    }
    if (budgetExhausted) return countToEnd;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (bytesReturned + size > maxBytes) {
      if (firstLine === 0) {
        throw new FsOpError(
          `Line ${lineNo} is larger than max_bytes=${maxBytes}. Increase max_bytes (up to ${MAX_READ_BYTES}) or use exec_command to transform it.`
        );
      }
      truncated = true;
      budgetExhausted = true;
      return countToEnd;
    }
    if (firstLine === 0) firstLine = lineNo;
    lastLine = lineNo;
    out.push(line);
    bytesReturned += size;
    return true;
  };

  for await (const chunk of readFileStream(realPath)) {
    bytesScanned += chunk.length;
    if (bytesScanned > MAX_LINE_COUNT_BYTES) countToEnd = false;
    if (decoder === null) {
      if (sniffBinaryBytes(chunk.subarray(0, Math.min(BINARY_SNIFF_BYTES, chunk.length)))) {
        throw new BinaryReadError(
          `This is a binary file (${formatBytes(metadata.size)}); text decoding is unavailable. Use exec_command if you need to inspect or convert it.`
        );
      }
      decoder = new TextDecoder(detectTextFormat(chunk).encoding);
    }
    carry += decoder.decode(chunk, { stream: true });
    let index = carry.indexOf('\n');
    while (index !== -1) {
      const line = carry.slice(0, index).replace(/\r$/, '');
      carry = carry.slice(index + 1);
      if (!pushLine(line)) {
        sawAllLines = false;
        carry = '';
        break;
      }
      index = carry.indexOf('\n');
    }
    if (carry.length > MAX_DECODED_LINE_CHARS) {
      throw new FsOpError(
        `A line exceeds the safe decoded-line limit (${formatBytes(MAX_DECODED_LINE_CHARS)}). Narrow or transform the file before reading it.`
      );
    }
    if (!sawAllLines) break;
  }

  if (sawAllLines && decoder !== null) {
    carry += decoder.decode();
    if (carry.length > 0) {
      if (!pushLine(carry.replace(/\r$/, ''))) sawAllLines = false;
    }
  }

  if (firstLine === 0) {
    firstLine = startLine;
    lastLine = startLine - 1;
  }

  return {
    text: stripBom(out.join('\n')),
    truncated,
    hasMore: passedRange || truncated,
    firstLine,
    lastLine,
    totalLines: sawAllLines ? lineNo : null,
    bytesReturned,
    fileBytes: metadata.size
  };
}
