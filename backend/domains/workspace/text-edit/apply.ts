import { alignLineEndings, preferredNewline } from './line-endings.js';
import { findSpans } from './span-search.js';
import type { AppliedTextEdit, TextEdit, TextSpan } from './types.js';

export class TextMatchError extends Error {}

function lineNumberAt(text: string, offset: number): number {
  return (text.slice(0, Math.min(offset, text.length)).match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
}

function firstLinePreview(value: string): string {
  const firstLine = value.split(/\r\n|\n|\r/)[0] ?? '';
  const compact = firstLine.replace(/\t/g, '→').trimEnd();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function selectSpans(spans: TextSpan[], replaceAll: boolean): TextSpan[] {
  return replaceAll ? spans : [spans[0]!];
}

export function applyTextEdit(original: string, edit: TextEdit): AppliedTextEdit {
  if (!edit.oldText) throw new TextMatchError('oldText must not be empty');

  const match = findSpans(original, edit.oldText);
  if (!match) {
    throw new TextMatchError(
      `oldText was not found. First line looked for: ${JSON.stringify(firstLinePreview(edit.oldText))}. ` +
        'Read the target region again and use its text without the line-number prefix. ' +
        'Line endings are normalized; if indentation or trailing whitespace differs, use apply_patch instead.'
    );
  }

  if (!edit.replaceAll && match.spans.length > 1) {
    const lineNumbers = match.spans.slice(0, 8).map(span => lineNumberAt(original, span.start));
    const suffix = match.spans.length > lineNumbers.length ? ', ...' : '';
    throw new TextMatchError(
      `oldText is ambiguous (${match.tier.label}): it occurs ${match.spans.length} times, at lines ` +
        `${lineNumbers.join(', ')}${suffix}. Include more context, or pass replaceAll to change every occurrence.`
    );
  }

  const spans = selectSpans(match.spans, edit.replaceAll === true);
  const fallback = preferredNewline(original);
  const output: string[] = [];
  let cursor = 0;

  for (const span of spans) {
    output.push(original.slice(cursor, span.start));
    output.push(alignLineEndings(original.slice(span.start, span.end), edit.newText, fallback));
    cursor = span.end;
  }

  output.push(original.slice(cursor));
  return { text: output.join(''), replacements: spans.length, tier: match.tier.label };
}

export type { AppliedTextEdit, TextEdit } from './types.js';
