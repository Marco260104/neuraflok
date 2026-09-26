import type { FileChange } from '../../../../../contracts/session.js';
import type { AppliedPatchDelta } from '../../../../domains/workspace/execution/apply-patch/index.js';
import { lineDelta } from '../../../../domains/workspace/diffstat.js';

export function patchFileChanges(delta: AppliedPatchDelta, virtualPaths: ReadonlyMap<string, string>): Array<{ change: FileChange; before: string; after: string }> {
  return delta.changes.map(({ path, change }) => {
    let realPath = path;
    let before: string;
    let after: string;
    if (change.kind === 'add') {
      before = change.overwrittenContent ?? '';
      after = change.content;
    } else if (change.kind === 'delete') {
      before = change.content;
      after = '';
    } else {
      realPath = change.movePath ?? path;
      before = change.oldContent;
      after = change.newContent;
    }
    const counts = lineDelta(before, after);
    return {
      change: {
        path: virtualPaths.get(realPath) ?? '[unresolved patch path]',
        added: counts.added,
        removed: counts.removed,
        approximate: counts.approximate || !delta.exact
      },
      before,
      after
    };
  });
}
