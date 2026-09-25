import { rawCreateReadStream as createReadStream, rawPromises as fs } from '../../rawfs.js';
import path from 'node:path';
import { isExcludedFolderName, sniffBinaryBytes, type TextEncoding } from '../../fsops.js';
import { compileIncludeMatcher } from './matchers.js';
import { CONTENT_CONCURRENCY, MAX_CONTENT_FILE_BYTES, MAX_DIRECTORIES_SCANNED, MAX_FILES_SCANNED, MAX_LINE_CHARS, TIME_BUDGET_MS } from './limits.js';
import type { SearchHit, SearchOutcome, SearchRequest } from './contracts.js';

function textEncodingFromHead(head: Buffer): TextEncoding {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}


export async function searchFileSystem(req: SearchRequest): Promise<SearchOutcome> {
  const started = Date.now();
  const deadline = Math.min(started + TIME_BUDGET_MS, req.deadline ?? Number.POSITIVE_INFINITY);
  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let directoriesScanned = 0;
  let stoppedBecause: SearchOutcome['stoppedBecause'] = null;

  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  const includeMatcher = req.include ? compileIncludeMatcher(req.include, req.caseSensitive) : null;
  const candidates: Array<{ real: string; rel: string }> = [];

  const outOfBudget = (): boolean => {
    if (Date.now() > deadline) {
      stoppedBecause = 'time';
      return true;
    }
    if (filesScanned >= MAX_FILES_SCANNED) {
      stoppedBecause = 'files';
      return true;
    }
    return false;
  };

  const pendingDirectories: Array<{ dir: string; rel: string }> = [{ dir: req.realDir, rel: '' }];
  // Queue head cursor rather than Array.shift(): a broad tree can enqueue thousands of directories, and shifting the front reindexes the whole remaining array on every BFS step. Keeping the same append-only breadth-first order makes traversal O(n) instead of adding an avoidable O(n²) queue-management term.
  let directoryHead = 0;
  while (directoryHead < pendingDirectories.length && !outOfBudget()) {
    if (directoriesScanned >= MAX_DIRECTORIES_SCANNED) {
      stoppedBecause = 'files';
      break;
    }
    const current = pendingDirectories[directoryHead++]!;
    directoriesScanned++;
    let directory;
    try {
      directory = await fs.opendir(current.dir);
    } catch {
      continue;
    }
    try {
      for await (const dirent of directory) {
        if (outOfBudget()) break;
        const childRel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          if (!isExcludedFolderName(dirent.name, req.exclude)) {
            pendingDirectories.push({ dir: path.join(current.dir, dirent.name), rel: childRel });
          }
          continue;
        }
        if (!dirent.isFile()) continue;
        filesScanned++;
        if (includeMatcher && !includeMatcher(childRel)) continue;
        if (req.mode === 'name') {
          const haystack = req.caseSensitive ? dirent.name : dirent.name.toLowerCase();
          if (needle === '' || haystack.includes(needle)) {
            hits.push({ path: `${req.virtualDir}/${childRel}` });
            if (hits.length >= req.maxResults) {
              stoppedBecause = 'limit';
              break;
            }
          }
        } else {
          candidates.push({ real: path.join(current.dir, dirent.name), rel: childRel });
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (stoppedBecause === 'limit') break;
  }

  if (req.mode === 'content' && stoppedBecause !== 'limit') {
    await scanContents(req, candidates, hits, deadline, (reason) => {
      stoppedBecause = reason;
    });
  }

  return {
    hits,
    filesScanned,
    truncated: stoppedBecause !== null,
    stoppedBecause,
    elapsedMs: Date.now() - started
  };
}

async function scanContents(
  req: SearchRequest,
  candidates: Array<{ real: string; rel: string }>,
  hits: SearchHit[],
  deadline: number,
  stop: (reason: 'limit' | 'time') => void
): Promise<void> {
  let index = 0;
  let done = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (done) return;
      if (Date.now() > deadline) {
        done = true;
        stop('time');
        return;
      }
      const item = candidates[index++];
      if (!item) return;
      if (hits.length >= req.maxResults) {
        done = true;
        stop('limit');
        return;
      }
      const found = await scanOneFile(item.real, req);
      for (const hit of found) {
        if (hits.length >= req.maxResults) {
          done = true;
          stop('limit');
          return;
        }
        hits.push({ path: `${req.virtualDir}/${item.rel}`, line: hit.line, text: hit.text });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONTENT_CONCURRENCY, candidates.length || 1) }, worker)
  );
}

export async function scanOneFile(
  realPath: string,
  req: SearchRequest
): Promise<Array<{ line: number; text: string }>> {
  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return [];
  }
  if (stat.size === 0 || stat.size > MAX_CONTENT_FILE_BYTES) return [];
  const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
  let regex: RegExp | null = null;
  if (req.regex) {
    try {
      regex = new RegExp(req.query, req.caseSensitive ? '' : 'i');
    } catch (error) {
      throw new Error(`Invalid search regex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const results: Array<{ line: number; text: string }> = [];
  let lineNo = 0;
  let carry = '';
  let decoder: TextDecoder | null = null;

  const consider = (line: string): void => {
    lineNo++;
    const haystack = req.caseSensitive ? line : line.toLowerCase();
    if (regex ? !regex.test(line) : !haystack.includes(needle)) return;
    const trimmed = line.trim();
    results.push({
      line: lineNo,
      text: trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
    });
  };

  const stream = createReadStream(realPath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      const data = chunk as Buffer;
      if (decoder === null) {
        if (sniffBinaryBytes(data.subarray(0, Math.min(8192, data.length)))) return [];
        decoder = new TextDecoder(textEncodingFromHead(data));
      }
      carry += decoder.decode(data, { stream: true });
      let at = carry.indexOf('\n');
      while (at !== -1) {
        consider(carry.slice(0, at).replace(/\r$/, ''));
        carry = carry.slice(at + 1);
        at = carry.indexOf('\n');
      }
      // A file with no newlines would otherwise grow `carry` without bound.
      if (carry.length > MAX_CONTENT_FILE_BYTES) break;
    }
    if (decoder !== null) carry += decoder.decode();
    if (carry.length > 0) consider(carry.replace(/\r$/, ''));
  } catch {
    return results;
  } finally {
    stream.destroy();
  }
  return results;
}