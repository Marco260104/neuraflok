import { spawn } from 'node:child_process';
import path from 'node:path';
import { MAX_CONTENT_FILE_BYTES, MAX_LINE_CHARS, TIME_BUDGET_MS } from './limits.js';
import { ripgrepExcludeGlob, ripgrepIncludeGlob } from './matchers.js';
import type { SearchHit, SearchOutcome, SearchRequest } from './contracts.js';

export async function searchWithRipgrep(
  executable: string,
  req: SearchRequest,
  realTarget: string,
  virtualTarget: string,
  targetIsFile = false
): Promise<SearchOutcome> {
  const started = Date.now();
  const deadline = Math.min(started + TIME_BUDGET_MS, req.deadline ?? Number.POSITIVE_INFINITY);
  if (deadline <= started) {
    return { hits: [], filesScanned: 0, truncated: true, stoppedBecause: 'time', elapsedMs: 0 };
  }
  const args = [
    '--json',
    '--line-number',
    '--color',
    'never',
    '--hidden',
    '--no-ignore',
    '--max-filesize',
    String(MAX_CONTENT_FILE_BYTES)
  ];
  if (!req.caseSensitive) args.push('--ignore-case');
  if (!req.regex) args.push('--fixed-strings');
  if (req.include) args.push(req.caseSensitive ? '--glob' : '--iglob', ripgrepIncludeGlob(req.include));
  for (const excluded of req.exclude) args.push('--iglob', ripgrepExcludeGlob(excluded));
  args.push('--', req.query, targetIsFile ? realTarget : '.');

  return new Promise<SearchOutcome>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: targetIsFile ? path.dirname(realTarget) : realTarget,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const hits: SearchHit[] = [];
    let filesScanned = 0;
    let stdout = '';
    let stderr = '';
    let stoppedBecause: SearchOutcome['stoppedBecause'] = null;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({
        hits,
        filesScanned,
        truncated: stoppedBecause !== null,
        stoppedBecause,
        elapsedMs: Date.now() - started
      });
    };

    const consider = (line: string): void => {
      if (!line) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event?.type === 'summary') {
        // `begin` is emitted once per file that *has* a match, so counting it reported matches, not coverage. The summary is the only event that knows how many files were actually searched.
        const searches = Number(event?.data?.stats?.searches);
        if (Number.isSafeInteger(searches)) filesScanned = searches;
        return;
      }
      if (event?.type !== 'match') return;
      // Killing the child does not stop this. The pipe already holds whatever ripgrep wrote before the signal landed, and every buffered line still arrives here, so without this guard a maxResults of 3 could return 9.
      if (stoppedBecause !== null) return;
      const data = event.data;
      const lineNo = Number(data?.line_number);
      // With a target of "." and cwd set, ripgrep reports paths as ".\README.md". Left alone that becomes "/root/./README.md" and no caller can match it against the path it asked about.
      const rawPath = String(data?.path?.text ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
      const rawText = String(data?.lines?.text ?? '').replace(/\r?\n$/, '');
      const trimmed = rawText.trim();
      const hitPath = targetIsFile
        ? virtualTarget
        : `${virtualTarget}/${rawPath}`.replace(/\/+/g, '/').replace(/\/\.\//g, '/');
      hits.push({
        path: hitPath,
        line: Number.isSafeInteger(lineNo) ? lineNo : undefined,
        text: trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
      });
      if (hits.length >= req.maxResults && stoppedBecause === null) {
        stoppedBecause = 'limit';
        child.kill();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let consumed = 0;
      for (;;) {
        const newline = stdout.indexOf('\n', consumed);
        if (newline === -1) break;
        consider(stdout.slice(consumed, newline).trim());
        consumed = newline + 1;
      }
      if (consumed > 0) stdout = stdout.slice(consumed);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000);
    });
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(new Error(`ripgrep could not start${code ? ` (${code})` : ''}`));
    });
    child.once('close', (code) => {
      if (stdout.trim()) consider(stdout.trim());
      // rg uses 1 for "no matches". A deliberate limit/time kill can return any code.
      if (stoppedBecause !== null || code === 0 || code === 1) finish();
      // Never surface rg's raw stderr here. For an exact file it can echo the hidden native approved-root path after a rename/ACL race; the model only needs the backend verdict.
      else finish(new Error(`ripgrep search failed${code === null ? '' : ` (exit ${code})`}`));
    });
    const timer = setTimeout(() => {
      if (stoppedBecause === null) stoppedBecause = 'time';
      child.kill();
    }, Math.max(1, deadline - Date.now()));
  });
}
