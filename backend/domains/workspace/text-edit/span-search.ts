import type { MatchTier, SpanMatch, TextSpan } from './types.js';

const TYPOGRAPHIC_EQUIVALENTS = new Map<string, string>();

for (const character of '‐‑‒–—―−') TYPOGRAPHIC_EQUIVALENTS.set(character, '-');
for (const character of '‘’‚‛′') TYPOGRAPHIC_EQUIVALENTS.set(character, "'");
for (const character of '“”„‟″') TYPOGRAPHIC_EQUIVALENTS.set(character, '"');
for (const character of '\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000') {
  TYPOGRAPHIC_EQUIVALENTS.set(character, ' ');
}

export function foldUnicodeSameLength(value: string): string {
  const output: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    output.push(TYPOGRAPHIC_EQUIVALENTS.get(character) ?? character);
  }
  return output.join('');
}

function createSearchView(value: string): { text: string; sourceOffsets: number[] } {
  const characters: string[] = [];
  const sourceOffsets: number[] = [];

  for (let index = 0; index < value.length;) {
    sourceOffsets.push(index);
    if (value[index] === '\r') {
      characters.push('\n');
      index += value[index + 1] === '\n' ? 2 : 1;
    } else {
      characters.push(value[index]!);
      index++;
    }
  }

  sourceOffsets.push(value.length);
  return { text: characters.join(''), sourceOffsets };
}

function collectNonOverlappingMatches(haystack: string, needle: string, sourceOffsets: number[]): TextSpan[] {
  const segments = haystack.split(needle);
  const spans: TextSpan[] = [];
  let cursor = 0;

  for (let index = 0; index < segments.length - 1; index++) {
    cursor += segments[index]!.length;
    const end = cursor + needle.length;
    spans.push({ start: sourceOffsets[cursor]!, end: sourceOffsets[end]! });
    cursor = end;
  }

  return spans;
}

const MATCH_TIERS: readonly MatchTier[] = [
  { label: 'exact match', normalize: value => value },
  { label: 'ignoring unicode punctuation', normalize: foldUnicodeSameLength }
];

export function findSpans(original: string, needle: string): SpanMatch | null {
  if (!needle) return null;

  const view = createSearchView(original);
  const target = needle.replace(/\r\n|\r/g, '\n');

  for (const tier of MATCH_TIERS) {
    const normalizedTarget = tier.normalize(target);
    if (!normalizedTarget) continue;

    const spans = collectNonOverlappingMatches(tier.normalize(view.text), normalizedTarget, view.sourceOffsets);
    if (spans.length > 0) return { spans, tier };
  }

  return null;
}
