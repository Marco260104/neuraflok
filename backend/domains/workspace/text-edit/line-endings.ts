import type { LogicalText, Newline } from './types.js';

export function preferredNewline(text: string): Newline {
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n') {
        crlf++;
        index++;
      } else {
        cr++;
      }
    } else if (text[index] === '\n') {
      lf++;
    }
  }

  if (crlf > 0 && crlf >= lf && crlf >= cr) return '\r\n';
  return cr > lf ? '\r' : '\n';
}

export function splitLogicalText(text: string): LogicalText {
  const lines: string[] = [];
  const endings: string[] = [];
  let cursor = 0;

  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    const offset = match.index ?? cursor;
    lines.push(text.slice(cursor, offset));
    endings.push(match[0]);
    cursor = offset + match[0].length;
  }

  const finalNewline = text.length > 0 && cursor === text.length;
  if (!finalNewline) {
    lines.push(text.slice(cursor));
    endings.push('');
  }

  return { lines, endings, newline: preferredNewline(text), finalNewline };
}

export function alignLineEndings(spanText: string, newText: string, fallback: Newline): string {
  const source = splitLogicalText(spanText);
  const replacement = splitLogicalText(newText);
  const output: string[] = [];

  for (let index = 0; index < replacement.lines.length; index++) {
    output.push(replacement.lines[index]!);
    if (replacement.endings[index]) output.push(source.endings[index] || fallback);
  }

  return output.join('');
}
