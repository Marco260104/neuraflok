import { describe, expect, it } from 'vitest';
import { seekSequence } from '../backend/domains/workspace/execution/apply-patch/seek-sequence.js';

function exactReference(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  mode: 'normalize_to_lf' | 'preserve_line_endings'
): number | null {
  if (pattern.length === 0) return start;
  const last = lines.length - pattern.length;
  if (last < 0) return null;
  const first = eof
    ? mode === 'normalize_to_lf' ? last : Math.max(last, start)
    : Math.max(0, start);
  if (first > last) return null;

  for (let index = first; index <= last; index += 1) {
    if (pattern.every((line, offset) => lines[index + offset] === line)) return index;
  }
  return null;
}

function binaryLines(length: number, mask: number): string[] {
  return Array.from({ length }, (_, index) => mask & (1 << index) ? 'a' : 'b');
}

describe('patch context matching', () => {
  it('prefers a later exact match over an earlier relaxed match', () => {
    expect(seekSequence(['value  ', 'value'], ['value'], 0, false, 'normalize_to_lf')).toBe(1);
  });

  it('prefers a complete exact sequence over an earlier sequence with relaxed spacing', () => {
    expect(seekSequence(['head ', 'tail', 'head', 'tail'], ['head', 'tail'], 0, false, 'normalize_to_lf')).toBe(2);
  });

  it('finds a sequence after falling back across repeated prefixes', () => {
    expect(seekSequence(['a', 'b', 'a', 'b', 'a', 'b', 'c'], ['a', 'b', 'a', 'b', 'c'], 0, false, 'normalize_to_lf')).toBe(2);
  });

  it('relaxes trailing whitespace before trimming both sides', () => {
    expect(seekSequence(['value  '], ['value'], 0, false, 'normalize_to_lf')).toBe(0);
    expect(seekSequence(['  value  '], ['value'], 0, false, 'normalize_to_lf')).toBe(0);
  });

  it('matches common Unicode punctuation to its plain-text form', () => {
    expect(seekSequence(['A—B C'], ['A-B C'], 0, false, 'normalize_to_lf')).toBe(0);
  });

  it('does not trim a byte-order mark as whitespace', () => {
    expect(seekSequence(['\uFEFFvalue\uFEFF'], ['value'], 0, false, 'normalize_to_lf')).toBeNull();
  });

  it('keeps EOF search policy distinct between update modes', () => {
    const lines = ['top', 'target', 'target'];
    expect(seekSequence(lines, ['target'], 3, true, 'preserve_line_endings')).toBeNull();
    expect(seekSequence(lines, ['target'], 3, true, 'normalize_to_lf')).toBe(2);
  });

  it('keeps empty and oversized patterns bounded', () => {
    expect(seekSequence(['one'], [], 7, false, 'normalize_to_lf')).toBe(7);
    expect(seekSequence(['one'], ['one', 'two'], 0, false, 'normalize_to_lf')).toBeNull();
  });

  it('matches the exact-search reference across short repeated sequences', () => {
    const modes = ['normalize_to_lf', 'preserve_line_endings'] as const;
    for (let lineCount = 0; lineCount <= 5; lineCount += 1) {
      for (let lineMask = 0; lineMask < 1 << lineCount; lineMask += 1) {
        const lines = binaryLines(lineCount, lineMask);
        for (let patternLength = 1; patternLength <= 3; patternLength += 1) {
          for (let patternMask = 0; patternMask < 1 << patternLength; patternMask += 1) {
            const pattern = binaryLines(patternLength, patternMask);
            for (let start = -1; start <= lineCount + 1; start += 1) {
              for (const eof of [false, true]) {
                for (const mode of modes) {
                  const expected = exactReference(lines, pattern, start, eof, mode);
                  expect(seekSequence(lines, pattern, start, eof, mode)).toBe(expected);
                }
              }
            }
          }
        }
      }
    }
  });
});
