import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { el } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

export interface DiffLine { kind: 'context' | 'added' | 'removed' | 'gap'; old: number | null; next: number | null; text: string }

type OperationKind = 'context' | 'added' | 'removed';
type Match = { old: number; next: number };
type OperationRun = { kind: OperationKind; oldStart: number; oldEnd: number; nextStart: number; nextEnd: number };

const SMALL_DIFF_CELL_LIMIT = 300_000;
const ANCHOR_DEPTH_LIMIT = 24;

function snapshotLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function uniqueMatches(oldLines: string[], nextLines: string[], oldStart: number, oldEnd: number, nextStart: number, nextEnd: number): Match[] {
  const positions = (lines: string[], start: number, end: number): Map<string, number> => {
    const found = new Map<string, number>();
    for (let index = start; index < end; index++) {
      const line = lines[index]!;
      const previous = found.get(line);
      found.set(line, previous === undefined ? index : -1);
    }
    return found;
  };
  const oldPositions = positions(oldLines, oldStart, oldEnd);
  const nextPositions = positions(nextLines, nextStart, nextEnd);
  const candidates: Match[] = [];
  for (const [line, old] of oldPositions) {
    const next = nextPositions.get(line);
    if (old >= 0 && next !== undefined && next >= 0) candidates.push({ old, next });
  }
  if (candidates.length < 2) return candidates;

  const tails: number[] = [];
  const tailMatches: number[] = [];
  const previousMatches = new Int32Array(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index++) {
    const value = candidates[index]!.next;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tails[middle]! < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previousMatches[index] = tailMatches[low - 1]!;
    tails[low] = value;
    tailMatches[low] = index;
  }

  const ordered: Match[] = [];
  let cursor = tailMatches[tails.length - 1]!;
  while (cursor >= 0) {
    ordered.push(candidates[cursor]!);
    cursor = previousMatches[cursor]!;
  }
  ordered.reverse();
  return ordered;
}

function appendSmallDiff(runs: OperationRun[], oldLines: string[], nextLines: string[], oldStart: number, oldEnd: number, nextStart: number, nextEnd: number, cursors: { old: number; next: number }): void {
  const oldCount = oldEnd - oldStart;
  const nextCount = nextEnd - nextStart;
  const width = nextCount + 1;
  const table = new Uint32Array((oldCount + 1) * width);
  for (let old = oldCount - 1; old >= 0; old--) {
    for (let next = nextCount - 1; next >= 0; next--) {
      const cell = old * width + next;
      table[cell] = oldLines[oldStart + old]! === nextLines[nextStart + next]!
        ? table[(old + 1) * width + next + 1]! + 1
        : Math.max(table[(old + 1) * width + next]!, table[old * width + next + 1]!);
    }
  }
  let old = 0;
  let next = 0;
  while (old < oldCount || next < nextCount) {
    if (old < oldCount && next < nextCount && oldLines[oldStart + old]! === nextLines[nextStart + next]!) {
      appendOperation(runs, 'context', cursors);
      old++;
      next++;
    } else if (old < oldCount && (next === nextCount || table[(old + 1) * width + next]! >= table[old * width + next + 1]!)) {
      appendOperation(runs, 'removed', cursors);
      old++;
    } else {
      appendOperation(runs, 'added', cursors);
      next++;
    }
  }
}

function appendOperation(runs: OperationRun[], kind: OperationKind, cursors: { old: number; next: number }): void {
  let run = runs.at(-1);
  if (!run || run.kind !== kind || run.oldEnd !== cursors.old || run.nextEnd !== cursors.next) {
    run = { kind, oldStart: cursors.old, oldEnd: cursors.old, nextStart: cursors.next, nextEnd: cursors.next };
    runs.push(run);
  }
  if (kind !== 'added') cursors.old++;
  if (kind !== 'removed') cursors.next++;
  run.oldEnd = cursors.old;
  run.nextEnd = cursors.next;
}

function alignRange(runs: OperationRun[], oldLines: string[], nextLines: string[], oldStart: number, oldEnd: number, nextStart: number, nextEnd: number, cursors: { old: number; next: number }, depth = 0): void {
  while (oldStart < oldEnd && nextStart < nextEnd && oldLines[oldStart]! === nextLines[nextStart]!) {
    appendOperation(runs, 'context', cursors);
    oldStart++;
    nextStart++;
  }

  let suffix = 0;
  while (oldStart < oldEnd - suffix && nextStart < nextEnd - suffix && oldLines[oldEnd - suffix - 1]! === nextLines[nextEnd - suffix - 1]!) suffix++;
  const middleOldEnd = oldEnd - suffix;
  const middleNextEnd = nextEnd - suffix;
  const oldCount = middleOldEnd - oldStart;
  const nextCount = middleNextEnd - nextStart;

  if (oldCount === 0) {
    for (let index = 0; index < nextCount; index++) appendOperation(runs, 'added', cursors);
  } else if (nextCount === 0) {
    for (let index = 0; index < oldCount; index++) appendOperation(runs, 'removed', cursors);
  } else if (oldCount * nextCount <= SMALL_DIFF_CELL_LIMIT) {
    appendSmallDiff(runs, oldLines, nextLines, oldStart, middleOldEnd, nextStart, middleNextEnd, cursors);
  } else if (depth < ANCHOR_DEPTH_LIMIT) {
    const anchors = uniqueMatches(oldLines, nextLines, oldStart, middleOldEnd, nextStart, middleNextEnd);
    if (anchors.length === 0) {
      for (let index = 0; index < oldCount; index++) appendOperation(runs, 'removed', cursors);
      for (let index = 0; index < nextCount; index++) appendOperation(runs, 'added', cursors);
    } else {
      let oldCursor = oldStart;
      let nextCursor = nextStart;
      for (const anchor of anchors) {
        alignRange(runs, oldLines, nextLines, oldCursor, anchor.old, nextCursor, anchor.next, cursors, depth + 1);
        appendOperation(runs, 'context', cursors);
        oldCursor = anchor.old + 1;
        nextCursor = anchor.next + 1;
      }
      alignRange(runs, oldLines, nextLines, oldCursor, middleOldEnd, nextCursor, middleNextEnd, cursors, depth + 1);
    }
  } else {
    for (let index = 0; index < oldCount; index++) appendOperation(runs, 'removed', cursors);
    for (let index = 0; index < nextCount; index++) appendOperation(runs, 'added', cursors);
  }

  for (let index = 0; index < suffix; index++) appendOperation(runs, 'context', cursors);
}

function boundedRows(runs: OperationRun[], oldLines: string[], nextLines: string[], limit: number): { lines: DiffLine[]; truncated: boolean } {
  const cap = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 600));
  const lines: DiffLine[] = [];
  let truncated = false;
  const add = (line: DiffLine): boolean => {
    if (lines.length >= cap) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };
  const appendContext = (oldStart: number, nextStart: number, count: number): boolean => {
    const show = (offset: number): boolean => add({ kind: 'context', old: oldStart + offset + 1, next: nextStart + offset + 1, text: oldLines[oldStart + offset]! });
    if (count <= 6) {
      for (let offset = 0; offset < count; offset++) if (!show(offset)) return false;
      return true;
    }
    for (let offset = 0; offset < 3; offset++) if (!show(offset)) return false;
    if (!add({ kind: 'gap', old: null, next: null, text: t('{0} unchanged lines', [count - 6]) })) return false;
    for (let offset = count - 3; offset < count; offset++) if (!show(offset)) return false;
    return true;
  };

  for (const run of runs) {
    if (run.kind === 'context') {
      if (!appendContext(run.oldStart, run.nextStart, run.oldEnd - run.oldStart)) break;
    } else if (run.kind === 'removed') {
      for (let index = run.oldStart; index < run.oldEnd; index++) {
        if (!add({ kind: 'removed', old: index + 1, next: null, text: oldLines[index]! })) break;
      }
      if (truncated) break;
    } else {
      for (let index = run.nextStart; index < run.nextEnd; index++) {
        if (!add({ kind: 'added', old: null, next: index + 1, text: nextLines[index]! })) break;
      }
      if (truncated) break;
    }
  }
  return { lines, truncated };
}

export function unifiedDiffLines(base: string, current: string, limit = 600): { lines: DiffLine[]; truncated: boolean } {
  const oldLines = snapshotLines(base);
  const nextLines = snapshotLines(current);
  if (oldLines.length === 0 && nextLines.length === 0) {
    return boundedRows([{ kind: 'context', oldStart: 0, oldEnd: 1, nextStart: 0, nextEnd: 1 }], [''], [''], limit);
  }
  const oldHasFinalNewline = base.endsWith('\n');
  const nextHasFinalNewline = current.endsWith('\n');
  const sameContent = oldLines.length === nextLines.length && oldLines.every((line, index) => line === nextLines[index]);
  if (sameContent && oldHasFinalNewline !== nextHasFinalNewline && oldLines.length > 0) {
    if (oldHasFinalNewline) oldLines.push('');
    else nextLines.push('');
  }
  const runs: OperationRun[] = [];
  const cursors = { old: 0, next: 0 };
  alignRange(runs, oldLines, nextLines, 0, oldLines.length, 0, nextLines.length, cursors);
  return boundedRows(runs, oldLines, nextLines, limit);
}

export async function renderUnifiedDiff(host: HTMLElement, filename: string, base: string, current: string, currentOwner: () => boolean): Promise<void> {
  const description = LanguageDescription.matchFilename(languages, filename);
  let language = null;
  if (description) try { language = (await description.load()).language; } catch { /* Text remains readable. */ }
  if (!currentOwner()) return;
  const { lines, truncated } = unifiedDiffLines(base, current);
  const content = el('div', 'unified-diff-lines'); content.setAttribute('role', 'table');
  for (const line of lines) {
    const row = el('div', `diff-line is-${line.kind}`); row.setAttribute('role', 'row');
    row.append(el('span', 'diff-gutter', line.old === null ? '' : String(line.old)),
      el('span', 'diff-gutter', line.next === null ? '' : String(line.next)),
      el('span', 'diff-sign', line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '));
    const code = el('code', 'diff-code');
    if (language && line.text.length <= 4000 && line.kind !== 'gap') {
      let cursor = 0;
      highlightTree(language.parser.parse(line.text), classHighlighter, (from, to, classes) => {
        code.append(line.text.slice(cursor, from), el('span', classes, line.text.slice(from, to))); cursor = to;
      });
      code.append(line.text.slice(cursor));
    } else code.textContent = line.text;
    row.append(code); content.append(row);
  }
  host.replaceChildren(content);
  if (truncated) host.append(el('p', 'meta', () => t('Preview limited to 600 lines. Open Review for the complete edit.')));
}
