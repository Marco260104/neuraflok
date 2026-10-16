import { expect, it } from 'vitest';
import { unifiedDiffLines } from '../frontend/features/chat/unified-diff.js';

it('aligns old and new gutters through replacement, insertion and deletion', () => {
  const result = unifiedDiffLines('one\ntwo\nthree\n', 'one\nchanged\nnew\nthree\n');
  expect(result.lines.map(({ kind, old, next, text }) => [kind, old, next, text])).toEqual([
    ['context', 1, 1, 'one'], ['removed', 2, null, 'two'], ['added', null, 2, 'changed'], ['added', null, 3, 'new'], ['context', 3, 4, 'three']
  ]);
  expect(result.truncated).toBe(false);
});
it('shows creation and deletion from exact snapshots including a missing final newline', () => {
  expect(unifiedDiffLines('', 'hello').lines.filter(line => line.kind === 'added').map(line => line.text)).toEqual(['hello']);
  expect(unifiedDiffLines('hello', '').lines.filter(line => line.kind === 'removed').map(line => line.text)).toEqual(['hello']);
});
it('bounds rendered lines and folds long unchanged context without changing line identities', () => {
  const source = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const result = unifiedDiffLines(source, source.replace('line 50', 'edited 50'));
  expect(result.lines.some(line => line.kind === 'gap')).toBe(true);
  expect(result.lines.find(line => line.kind === 'added')?.next).toBe(51);
  expect(unifiedDiffLines('', 'line\n'.repeat(5000)).lines).toHaveLength(600);
  expect(unifiedDiffLines('', 'line\n'.repeat(5000)).truncated).toBe(true);
});

it('keeps separate old and new line numbers after insertions and aligns repeated text', () => {
  const result = unifiedDiffLines('head\nrepeat\nrepeat\ntail', 'head\nrepeat\nnew\nrepeat\ntail');
  expect(result.lines.map(({ kind, old, next, text }) => [kind, old, next, text])).toEqual([
    ['context', 1, 1, 'head'], ['context', 2, 2, 'repeat'], ['added', null, 3, 'new'],
    ['context', 3, 4, 'repeat'], ['context', 4, 5, 'tail']
  ]);
});

it('preserves empty snapshots and interior blank lines', () => {
  expect(unifiedDiffLines('', '').lines).toEqual([{ kind: 'context', old: 1, next: 1, text: '' }]);
  expect(unifiedDiffLines('first\n\nlast', 'first\nadded\n\nlast').lines.map(({ kind, old, next, text }) => [kind, old, next, text])).toEqual([
    ['context', 1, 1, 'first'], ['added', null, 2, 'added'], ['context', 2, 3, ''], ['context', 3, 4, 'last']
  ]);
});

it('shows a final newline change without replacing an unchanged content line', () => {
  expect(unifiedDiffLines('one', 'one\n').lines.map(({ kind, old, next, text }) => [kind, old, next, text])).toEqual([
    ['context', 1, 1, 'one'], ['added', null, 2, '']
  ]);
  expect(unifiedDiffLines('one\n', 'one').lines.map(({ kind, old, next, text }) => [kind, old, next, text])).toEqual([
    ['context', 1, 1, 'one'], ['removed', 2, null, '']
  ]);
});

it('uses stable unique lines to align large separated edits', () => {
  const before = [...Array.from({ length: 300 }, (_, index) => `old-left-${index}`), 'stable-middle', ...Array.from({ length: 300 }, (_, index) => `old-right-${index}`)].join('\n');
  const after = [...Array.from({ length: 300 }, (_, index) => `new-left-${index}`), 'stable-middle', ...Array.from({ length: 300 }, (_, index) => `new-right-${index}`)].join('\n');
  const result = unifiedDiffLines(before, after, 2000);
  expect(result.lines).toContainEqual({ kind: 'context', old: 301, next: 301, text: 'stable-middle' });
  expect(result.truncated).toBe(false);
});

it('honors a caller supplied row limit', () => {
  const result = unifiedDiffLines('', 'one\ntwo\nthree', 2);
  expect(result.lines.map(line => line.text)).toEqual(['one', 'two']);
  expect(result.truncated).toBe(true);
});

it('reconstructs both snapshots across small repeated-line combinations', () => {
  const snapshots = ['', 'a', 'b', '\n', 'a\n', 'a\nb', 'b\na', 'a\na', 'a\nb\n'];
  const contentLines = (value: string): string[] => {
    if (value === '') return [];
    const lines = value.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  };
  for (const before of snapshots) {
    for (const after of snapshots) {
      if (before === '' && after === '') continue;
      const result = unifiedDiffLines(before, after, 100);
      const expectedBefore = contentLines(before);
      const expectedAfter = contentLines(after);
      const sameBody = expectedBefore.length === expectedAfter.length && expectedBefore.every((line, index) => line === expectedAfter[index]);
      if (sameBody && before.endsWith('\n') !== after.endsWith('\n') && expectedBefore.length > 0) {
        if (before.endsWith('\n')) expectedBefore.push('');
        else expectedAfter.push('');
      }
      expect(result.truncated).toBe(false);
      expect(result.lines.filter(line => line.kind === 'context' || line.kind === 'removed').map(line => line.text)).toEqual(expectedBefore);
      expect(result.lines.filter(line => line.kind === 'context' || line.kind === 'added').map(line => line.text)).toEqual(expectedAfter);
    }
  }
});
