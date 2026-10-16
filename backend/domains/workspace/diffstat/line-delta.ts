import { boundedInsertDeleteDistance } from './bounded-edit-distance.js';
import { longestCommonLineCount } from './line-lcs.js';
import { removeSharedEdges, splitLineSequence } from './line-sequences.js';
import type { LineDelta } from './types.js';

const DENSE_COMPARE_LIMIT = 1500;
const LARGE_EDIT_LIMIT = 512;

export function lineDelta(beforeText: string, afterText: string): LineDelta {
  if (beforeText === afterText) return { added: 0, removed: 0, approximate: false };

  const changed = removeSharedEdges(splitLineSequence(beforeText), splitLineSequence(afterText));
  const oldCount = changed.before.length;
  const newCount = changed.after.length;
  if (oldCount === 0 || newCount === 0) {
    return { added: newCount, removed: oldCount, approximate: false };
  }

  if (oldCount <= DENSE_COMPARE_LIMIT && newCount <= DENSE_COMPARE_LIMIT) {
    const common = longestCommonLineCount(changed.before, changed.after);
    return { added: newCount - common, removed: oldCount - common, approximate: false };
  }

  const distance = boundedInsertDeleteDistance(changed.before, changed.after, LARGE_EDIT_LIMIT);
  if (distance === null) return { added: newCount, removed: oldCount, approximate: true };

  const common = (oldCount + newCount - distance) / 2;
  return { added: newCount - common, removed: oldCount - common, approximate: false };
}
