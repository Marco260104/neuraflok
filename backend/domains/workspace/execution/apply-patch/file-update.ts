import { readFileText } from '../filesystem.js';
import { ApplyPatchError } from './errors.js';
import type { UpdateFileChunk } from './hunk.js';
import type { ApplyPatchFileUpdateMode } from './mode.js';
import { seekSequence } from './seek-sequence.js';
import { applyLineEdits, parseTextDocument, type LineEdit } from './text-file.js';

export interface AppliedPatch {
  originalContents: string;
  newContents: string;
}

interface LocatedChunk {
  start: number;
  oldLines: readonly string[];
  newLines: readonly string[];
}

async function readOriginalContents(path: string, baseContents?: string): Promise<string> {
  if (baseContents !== undefined) return baseContents;
  try {
    return await readFileText(path);
  } catch (error) {
    throw ApplyPatchError.io(`Failed to read file to update ${path}`, error);
  }
}

function splitNormalizedLines(contents: string): string[] {
  const lines = contents.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function createMismatch(
  heading: string,
  lines: readonly string[],
  expectedLines: readonly string[],
  searchFrom: number,
  mode: ApplyPatchFileUpdateMode,
  contextLine: number | null
): ApplyPatchError {
  const trimDisplayLine = (line: string): string => line.length > 240 ? `${line.slice(0, 240)}…` : line;
  const earlierMatch = searchFrom > 0 ? seekSequence(lines, expectedLines, 0, false, mode) : null;
  const isOutOfOrder = earlierMatch !== null && earlierMatch < searchFrom;
  const guidance = isOutOfOrder
    ? `Matching text exists at line ${earlierMatch + 1}, before the current search position at line ${searchFrom + 1}. Put edits in file order and avoid overlapping hunks.`
    : 'Use the current file text as patch context; do not reconstruct or reformat the old lines.';
  const preview = expectedLines.slice(0, 8).map(trimDisplayLine).join('\n');
  const omitted = expectedLines.length > 8 ? '\n… (expected text truncated)' : '';

  let excerptAnchor = isOutOfOrder ? earlierMatch : contextLine;
  if (excerptAnchor === null) {
    for (const candidate of expectedLines.slice(0, 12)) {
      const text = candidate.trim();
      if (text.length < 8) continue;
      const firstIndex = lines.findIndex(line => line.trim() === text);
      const isUnique = firstIndex !== -1 && !lines.some((line, index) => index > firstIndex && line.trim() === text);
      if (isUnique) {
        excerptAnchor = firstIndex;
        break;
      }
    }
  }

  let sourceContext: string | undefined;
  if (excerptAnchor !== null) {
    const excerptStart = Math.max(0, excerptAnchor - 2);
    const excerptLines = lines.slice(excerptStart, excerptStart + 8).map((line, index) =>
      `${excerptStart + index + 1}\t${trimDisplayLine(line)}`
    );
    sourceContext = `Source excerpt from the patch verification snapshot (line numbers are not file content):\n${excerptLines.join('\n')}`;
  }

  return ApplyPatchError.computeReplacements(
    `${heading}\n${guidance}\nExpected text:\n${preview}${omitted}`,
    sourceContext
  );
}

function locateChunk(
  lines: readonly string[],
  chunk: UpdateFileChunk,
  cursor: number,
  mode: ApplyPatchFileUpdateMode
): LocatedChunk | null {
  let expectedLines = chunk.oldLines;
  let replacementLines = chunk.newLines;
  let start = seekSequence(lines, expectedLines, cursor, chunk.isEndOfFile, mode);

  if (start === null && expectedLines.at(-1) === '') {
    expectedLines = expectedLines.slice(0, -1);
    if (replacementLines.at(-1) === '') replacementLines = replacementLines.slice(0, -1);
    start = seekSequence(lines, expectedLines, cursor, chunk.isEndOfFile, mode);
  }

  return start === null ? null : { start, oldLines: expectedLines, newLines: replacementLines };
}

function appendLineEndingPreservingEdits(
  edits: LineEdit[],
  start: number,
  oldLines: readonly string[],
  newLines: readonly string[],
  contextIndices: readonly (readonly [number, number])[]
): void {
  let oldCursor = 0;
  let newCursor = 0;

  for (const [oldContextIndex, newContextIndex] of contextIndices) {
    if (oldContextIndex >= oldLines.length || newContextIndex >= newLines.length) break;
    if (oldCursor !== oldContextIndex || newCursor !== newContextIndex) {
      edits.push({
        startLine: start + oldCursor,
        removeCount: oldContextIndex - oldCursor,
        insertedLines: newLines.slice(newCursor, newContextIndex)
      });
    }
    oldCursor = oldContextIndex + 1;
    newCursor = newContextIndex + 1;
  }

  if (oldCursor !== oldLines.length || newCursor !== newLines.length) {
    edits.push({
      startLine: start + oldCursor,
      removeCount: oldLines.length - oldCursor,
      insertedLines: newLines.slice(newCursor)
    });
  }
}

function planLineEdits(
  lines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
  mode: ApplyPatchFileUpdateMode
): LineEdit[] {
  const edits: LineEdit[] = [];
  let searchFrom = 0;

  for (const chunk of chunks) {
    let contextLine: number | null = null;
    if (chunk.changeContext !== null) {
      contextLine = seekSequence(lines, [chunk.changeContext], searchFrom, false, mode);
      if (contextLine === null) {
        throw createMismatch(`Failed to find context in ${path}:`, lines, [chunk.changeContext], searchFrom, mode, null);
      }
      searchFrom = contextLine + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionPoint = mode === 'normalize_to_lf' && lines.at(-1) === '' ? lines.length - 1 : lines.length;
      edits.push({ startLine: insertionPoint, removeCount: 0, insertedLines: [...chunk.newLines] });
      continue;
    }

    const located = locateChunk(lines, chunk, searchFrom, mode);
    if (located === null) {
      const expected = chunk.oldLines.at(-1) === '' ? chunk.oldLines.slice(0, -1) : chunk.oldLines;
      throw createMismatch(
        `Failed to find expected lines in ${path}:`,
        lines,
        expected,
        searchFrom,
        mode,
        contextLine
      );
    }

    if (mode === 'normalize_to_lf') {
      edits.push({
        startLine: located.start,
        removeCount: located.oldLines.length,
        insertedLines: [...located.newLines]
      });
    } else {
      appendLineEndingPreservingEdits(
        edits,
        located.start,
        located.oldLines,
        located.newLines,
        chunk.contextLineIndices
      );
    }

    searchFrom = located.start + located.oldLines.length;
  }

  return edits.sort((left, right) => left.startLine - right.startLine);
}

function applyNormalizedEdits(lines: readonly string[], edits: readonly LineEdit[]): string[] {
  const result = [...lines];
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index]!;
    result.splice(edit.startLine, edit.removeCount, ...edit.insertedLines);
  }
  if (result.at(-1) !== '') result.push('');
  return result;
}

export async function deriveNewContentsFromChunks(
  path: string,
  chunks: readonly UpdateFileChunk[],
  updateFileMode: ApplyPatchFileUpdateMode,
  baseContents?: string
): Promise<AppliedPatch> {
  const originalContents = await readOriginalContents(path, baseContents);
  const document = updateFileMode === 'preserve_line_endings' ? parseTextDocument(originalContents) : null;
  const originalLines = document === null
    ? splitNormalizedLines(originalContents)
    : document.lines.map(line => line.text);
  const edits = planLineEdits(originalLines, path, chunks, updateFileMode);

  let newContents: string;
  if (document === null) {
    newContents = applyNormalizedEdits(originalLines, edits).join('\n');
  } else {
    newContents = applyLineEdits(document, edits);
  }

  return { originalContents, newContents };
}
