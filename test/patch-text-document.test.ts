import { describe, expect, it } from 'vitest';
import { applyLineEdits, parseTextDocument } from '../backend/domains/workspace/execution/apply-patch/text-file.js';

describe('patch text document', () => {
  it('records CRLF, LF, and CR endings without adding a trailing empty line', () => {
    const document = parseTextDocument('first\r\nsecond\nthird\rfourth');

    expect(document.lines).toEqual([
      { text: 'first', ending: 'crlf' },
      { text: 'second', ending: 'lf' },
      { text: 'third', ending: 'cr' },
      { text: 'fourth', ending: null }
    ]);
    expect(document.preferredEnding).toBe('crlf');
  });

  it('keeps untouched endings and uses the preferred ending for inserted or final lines', () => {
    const document = parseTextDocument('first\r\nkeep\nreplace\r\ntail');
    const contents = applyLineEdits(document, [
      { startLine: 2, removeCount: 1, insertedLines: ['changed'] }
    ]);

    expect(contents).toBe('first\r\nkeep\nchanged\r\ntail\r\n');
    expect(document.lines[2]).toEqual({ text: 'replace', ending: 'crlf' });
  });

  it('uses LF when inserting into an empty document', () => {
    const document = parseTextDocument('');

    expect(applyLineEdits(document, [
      { startLine: 0, removeCount: 0, insertedLines: ['first'] }
    ])).toBe('first\n');
  });
});
