import { describe, expect, it } from 'vitest';
import {
  approxTokenCount,
  countLines,
  formattedTruncateText,
  truncateMiddleChars,
  truncateMiddleWithTokenBudget
} from '../backend/domains/workspace/execution/output-bounds.js';

describe('bounded text output', () => {
  it('keeps both ends and reports removed characters', () => {
    expect(truncateMiddleChars('abcdefghijklmnopqrst', 10)).toBe('abcde…10 chars truncated…pqrst');
  });

  it('keeps Unicode characters intact when the byte limit cuts through a multibyte character', () => {
    expect(truncateMiddleChars('ab😀cdefgh', 6)).toBe('ab…4 chars truncated…fgh');
  });

  it('keeps valid Unicode boundaries when both retained edges cut through a code point', () => {
    expect(truncateMiddleChars('x😀yz', 6)).toBe('x…1 chars truncated…yz');
  });

  it('keeps text intact within its byte limit and counts CRLF lines once', () => {
    expect(truncateMiddleChars('short', 5)).toBe('short');
    expect(countLines('one\r\ntwo\r\n')).toBe(2);
  });

  it('reports approximate token counts and preserves an explicit token budget', () => {
    expect(approxTokenCount('abcdefghijklmnopqrst')).toBe(5);
    expect(truncateMiddleWithTokenBudget('abcdefghijklmnopqrst', 2)).toEqual({
      text: 'abcd…3 tokens truncated…qrst',
      originalTokenCount: 5
    });
  });

  it('leaves token-bounded text intact when the estimate fits', () => {
    expect(truncateMiddleWithTokenBudget('small', 2)).toEqual({
      text: 'small',
      originalTokenCount: 2
    });
  });

  it('formats the original line count before a bounded preview', () => {
    expect(countLines('one\ntwo\nthree\n')).toBe(3);
    expect(formattedTruncateText('one\ntwo\nthree\n', { kind: 'bytes', bytes: 5 })).toContain(
      'Warning: truncated output (original token count: 4)\nTotal output lines: 3\n\n'
    );
  });
});
