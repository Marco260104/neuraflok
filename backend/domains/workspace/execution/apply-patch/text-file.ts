export type LineEnding = 'lf' | 'crlf' | 'cr';

export interface TextLine {
  readonly text: string;
  readonly ending: LineEnding | null;
}

export interface TextDocument {
  readonly lines: readonly TextLine[];
  readonly preferredEnding: LineEnding;
}

export interface LineEdit {
  readonly startLine: number;
  readonly removeCount: number;
  readonly insertedLines: readonly string[];
}

const LINE_ENDING_TEXT: Record<LineEnding, string> = {
  lf: '\n',
  crlf: '\r\n',
  cr: '\r'
};

export function parseTextDocument(contents: string): TextDocument {
  const lines: TextLine[] = [];
  let lineStart = 0;
  let offset = 0;

  while (offset < contents.length) {
    const code = contents.charCodeAt(offset);
    let ending: LineEnding | null = null;
    let width = 1;

    if (code === 13 && contents.charCodeAt(offset + 1) === 10) {
      ending = 'crlf';
      width = 2;
    } else if (code === 13) {
      ending = 'cr';
    } else if (code === 10) {
      ending = 'lf';
    }

    if (ending === null) {
      offset += 1;
      continue;
    }

    lines.push({ text: contents.slice(lineStart, offset), ending });
    offset += width;
    lineStart = offset;
  }

  if (lineStart < contents.length) lines.push({ text: contents.slice(lineStart), ending: null });
  return {
    lines,
    preferredEnding: lines.find(line => line.ending !== null)?.ending ?? 'lf'
  };
}

export function applyLineEdits(document: TextDocument, edits: readonly LineEdit[]): string {
  const result: TextLine[] = [];
  let sourceOffset = 0;
  let previousEnd = 0;

  for (const edit of edits) {
    const unchangedCount = Math.max(0, edit.startLine - previousEnd);
    for (let index = 0; index < unchangedCount && sourceOffset < document.lines.length; index += 1) {
      result.push(document.lines[sourceOffset++]!);
    }

    for (let index = 0; index < edit.removeCount && sourceOffset < document.lines.length; index += 1) {
      sourceOffset += 1;
    }

    for (const text of edit.insertedLines) result.push({ text, ending: document.preferredEnding });
    previousEnd = edit.startLine + edit.removeCount;
  }

  while (sourceOffset < document.lines.length) result.push(document.lines[sourceOffset++]!);

  return result.map(line => line.text + LINE_ENDING_TEXT[line.ending ?? document.preferredEnding]).join('');
}
