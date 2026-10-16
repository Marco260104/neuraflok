import path from 'node:path';
import { rawPromises as fs } from '../../rawfs.js';
import { locateRipgrep } from '../../../../infrastructure/binaries/ripgrep.js';
import { compileIncludeMatcher } from './matchers.js';
import { MAX_CONTENT_FILE_BYTES } from './limits.js';
import { searchFileSystem, scanOneFile } from './filesystem.js';
import { searchWithRipgrep } from './ripgrep.js';
import type { SearchOutcome, SearchRequest } from './contracts.js';

export async function search(req: SearchRequest): Promise<SearchOutcome> {
  if (req.mode === 'content') {
    const ripgrep = locateRipgrep();
    if (ripgrep) return searchWithRipgrep(ripgrep, req, req.realDir, req.virtualDir);
    if (req.regex) throw new Error('Regex content search requires the bundled ripgrep runtime.');
  }
  return searchFileSystem(req);
}

export async function searchOneFile(
  realPath: string,
  virtualPath: string,
  req: Pick<SearchRequest, 'query' | 'mode' | 'include' | 'caseSensitive' | 'regex' | 'maxResults' | 'deadline'>
): Promise<SearchOutcome> {
  const started = Date.now();
  const rel = path.basename(virtualPath);
  // Ripgrep deliberately ignores glob filters when the search target is one explicit file. Apply the connector's include contract before selecting either backend so both paths agree.
  if (req.include && !compileIncludeMatcher(req.include, req.caseSensitive)(rel)) {
    return { hits: [], filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  if (req.mode === 'content') {
    // Both the bundled-rg path (`--max-filesize`) and the JS fallback intentionally skip files above this ceiling. For an explicitly named file, returning plain "No matches" is false: the file was never searched. Surface the stop reason before either backend can hide it.
    try {
      const stat = await fs.stat(realPath);
      if (stat.size > MAX_CONTENT_FILE_BYTES) {
        return {
          hits: [],
          filesScanned: 0,
          truncated: true,
          stoppedBecause: 'size',
          elapsedMs: Date.now() - started
        };
      }
    } catch {
      // Preserve the backend's existing missing/unreadable-file behaviour below.
    }
  }
  if (req.mode === 'content') {
    const ripgrep = locateRipgrep();
    if (ripgrep) {
      return searchWithRipgrep(
        ripgrep,
        { ...req, realDir: path.dirname(realPath), virtualDir: path.dirname(virtualPath).replace(/\\/g, '/'), exclude: [] },
        realPath,
        virtualPath,
        true
      );
    }
    if (req.regex) throw new Error('Regex content search requires the bundled ripgrep runtime.');
  }
  if (req.mode === 'name') {
    const haystack = req.caseSensitive ? rel : rel.toLowerCase();
    const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
    const hits = needle === '' || haystack.includes(needle) ? [{ path: virtualPath }] : [];
    return { hits, filesScanned: 1, truncated: false, stoppedBecause: null, elapsedMs: Date.now() - started };
  }
  const found = await scanOneFile(realPath, {
    realDir: path.dirname(realPath),
    virtualDir: path.dirname(virtualPath).replace(/\\/g, '/'),
    query: req.query,
    mode: 'content',
    include: req.include,
    exclude: [],
    caseSensitive: req.caseSensitive,
    maxResults: req.maxResults
  });
  const limited = found.slice(0, req.maxResults);
  return {
    hits: limited.map((hit) => ({ path: virtualPath, line: hit.line, text: hit.text })),
    filesScanned: 1,
    truncated: found.length > limited.length,
    stoppedBecause: found.length > limited.length ? 'limit' : null,
    elapsedMs: Date.now() - started
  };
}
