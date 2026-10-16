import type { ActivitySummary, FileChange } from '../../../../contracts/session.js';
import type { SummaryInput } from './summary-types.js';
import { arr, fileTitle, lineRangeMetric, locatedTitle, num, plural, shortPath, str, totalDelta } from './summary-format.js';

export function summarizeFileTool(
  input: SummaryInput,
  args: Record<string, unknown>,
  changes: readonly FileChange[] = input.evidence.changes
): ActivitySummary | null {
  const evidence = input.evidence;
  const delta = totalDelta(changes);
  switch (input.tool) {
    case 'read': {
      const paths = arr(args['paths']).map(path => String(path));
      const first = paths[0];
      const start = num(args['start_line']);
      const end = num(args['end_line']);
      const range = paths.length === 1
        ? (evidence.detail ?? (start && end ? `lines ${start}–${end}` : start ? `from line ${start}` : null))
        : null;
      const metric = lineRangeMetric(range);
      const multiDetail = paths.length > 1
        ? paths.length <= 3
          ? paths.map(shortPath).join(', ')
          : `${paths.slice(0, 2).map(shortPath).join(', ')} +${paths.length - 2} more`
        : null;
      return {
        kind: 'read',
        tone: 'neutral',
        title: paths.length === 1 && first ? locatedTitle('Read', first) : `Read ${plural(paths.length, 'path')}`,
        ...(range ? { detail: range } : multiDetail ? { detail: multiDetail } : {}),
        ...(metric ? { metric } : {})
      };
    }
    case 'find': {
      const query = str(args['query']) ?? '';
      const mode = str(args['mode']) ?? 'name';
      return {
        kind: 'search',
        tone: 'neutral',
        title: `Searched ${JSON.stringify(query.slice(0, 60))}`,
        detail: evidence.count !== null
          ? `${plural(evidence.count, 'match', 'matches')}${mode === 'content' ? ' in file contents' : ''}`
          : mode === 'content' ? 'in file contents' : 'by name'
      };
    }
    case 'apply_patch': {
      const patch = str(args['patch']) ?? '';
      const adds = /^\*\*\* Add File:/m.test(patch);
      const deletes = /^\*\*\* Delete File:/m.test(patch);
      const updates = /^\*\*\* Update File:/m.test(patch);
      const moves = /^\*\*\* Move to:/m.test(patch);
      const only = adds && !deletes && !updates
        ? 'create'
        : deletes && !adds && !updates
          ? 'delete'
          : moves && !adds && !deletes ? 'move' : 'edit';
      const verb = only === 'create' ? 'Created' : only === 'delete' ? 'Deleted' : only === 'move' ? 'Moved' : 'Edited';
      return {
        kind: only,
        tone: only === 'delete' ? 'warn' : 'good',
        title: changes.length === 0 ? 'Applied a patch' : fileTitle(verb, changes, null),
        ...(delta ? { metric: delta } : {})
      };
    }
    default:
      return null;
  }
}
