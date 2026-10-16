import type { ApplyPatchFileUpdateMode } from './mode.js';

const LEADING_WHITE_SPACE = /^\p{White_Space}+/u;
const TRAILING_WHITE_SPACE = /\p{White_Space}+$/u;
const COMMON_TYPOGRAPHY = /[‐‑‒–—―−‘’‚‛“”„‟            　]/gu;
const ASCII_EQUIVALENTS = new Map<string, string>([
  ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'], ['—', '-'], ['―', '-'], ['−', '-'],
  ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
  ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '],
  [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], [' ', ' '], ['　', ' ']
]);

type LineTransform = (line: string) => string;

function trimWhiteSpace(value: string): string {
  return value.replace(LEADING_WHITE_SPACE, '').replace(TRAILING_WHITE_SPACE, '');
}

function trimWhiteSpaceEnd(value: string): string {
  return value.replace(TRAILING_WHITE_SPACE, '');
}

function normalizeCommonTypography(value: string): string {
  return trimWhiteSpace(value).replace(COMMON_TYPOGRAPHY, character => ASCII_EQUIVALENTS.get(character) ?? character);
}

function buildPrefixTable(pattern: readonly string[]): Uint32Array {
  const prefixTable = new Uint32Array(pattern.length);
  let prefixLength = 0;

  for (let index = 1; index < pattern.length; index += 1) {
    while (prefixLength > 0 && pattern[index] !== pattern[prefixLength]) {
      prefixLength = prefixTable[prefixLength - 1]!;
    }
    if (pattern[index] === pattern[prefixLength]) prefixLength += 1;
    prefixTable[index] = prefixLength;
  }

  return prefixTable;
}

function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  first: number,
  transform: LineTransform
): number | null {
  const expected = pattern.map(transform);
  const prefixTable = buildPrefixTable(expected);
  let matched = 0;

  for (let index = first; index < lines.length; index += 1) {
    const sourceLine = lines[index];
    if (sourceLine === undefined) {
      matched = 0;
      continue;
    }

    const candidate = transform(sourceLine);
    while (matched > 0 && candidate !== expected[matched]) {
      matched = prefixTable[matched - 1]!;
    }
    if (candidate === expected[matched]) matched += 1;
    if (matched === expected.length) return index - expected.length + 1;
  }

  return null;
}

export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  updateFileMode: ApplyPatchFileUpdateMode
): number | null {
  if (pattern.length === 0) return start;
  const last = lines.length - pattern.length;
  if (last < 0) return null;

  const eofStart = last;
  const first = eof
    ? updateFileMode === 'normalize_to_lf' ? eofStart : Math.max(eofStart, start)
    : Math.max(0, start);
  if (first > last) return null;

  const transforms: readonly LineTransform[] = [
    line => line,
    trimWhiteSpaceEnd,
    trimWhiteSpace,
    normalizeCommonTypography
  ];

  for (const transform of transforms) {
    const match = findSequence(lines, pattern, first, transform);
    if (match !== null) return match;
  }

  return null;
}
