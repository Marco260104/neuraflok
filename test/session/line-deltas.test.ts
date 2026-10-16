import {
  formatDelta,
  lineDelta,
} from './context.js';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------- diffstat

describe('line deltas', () => {
  it('counts a pure insertion and a pure deletion exactly', () => {
    expect(lineDelta('a\nb\n', 'a\nnew\nb\n')).toEqual({ added: 1, removed: 0, approximate: false });
    expect(lineDelta('a\nb\nc\n', 'a\nc\n')).toEqual({ added: 0, removed: 1, approximate: false });
  });

  it('counts a replacement as one added and one removed', () => {
    expect(lineDelta('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('reports nothing for identical text, including a new file', () => {
    expect(lineDelta('same\n', 'same\n')).toEqual({ added: 0, removed: 0, approximate: false });
    expect(lineDelta('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0, approximate: false });
    expect(formatDelta({ added: 0, removed: 0 })).toBeNull();
  });

  it('handles a reordered block without inventing changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'c', 'b', 'd', 'e'].join('\n');
    expect(lineDelta(before, after)).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('counts sparse edits exactly even when they are thousands of lines apart', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = 'changed ten';
    after[3500] = 'changed thirty-five hundred';
    expect(lineDelta(before.join('\n'), after.join('\n'))).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('counts sparse edits exactly when large unchanged regions repeat the same lines', () => {
    const before = Array.from({ length: 4000 }, (_, index) => `group ${index % 4}`);
    const after = [...before];
    after[10] = 'changed first';
    after[3500] = 'changed second';
    expect(lineDelta(before.join('\n'), after.join('\n'))).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('normalizes CRLF/LF for sparse large-file counting', () => {
    const before = Array.from({ length: 3200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[5] = 'changed five';
    after[3000] = 'changed three thousand';
    expect(lineDelta(`${before.join('\r\n')}\r\n`, `${after.join('\n')}\n`)).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('says so when a rewrite is too large to diff exactly', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 4000 }, (_, i) => `changed ${i}`).join('\n');
    const delta = lineDelta(before, after);
    expect(delta.approximate).toBe(true);
    expect(delta.added).toBe(4000);
  });

  it('formats the metric the way the timeline shows it', () => {
    expect(formatDelta({ added: 18, removed: 4 })).toBe('+18 −4');
    expect(formatDelta({ added: 214, removed: 0 })).toBe('+214');
    expect(formatDelta({ added: 0, removed: 83 })).toBe('−83');
  });
});
