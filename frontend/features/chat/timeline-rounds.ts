import { isActivity } from './timeline-rounds/activity.js';
import { recordedParts } from './timeline-rounds/recorded-parts.js';
import type { FlowRow, RoundPart } from './timeline-rounds/types.js';

export type { FlowRow, RoundPart } from './timeline-rounds/types.js';
export { isActivity };

function runTurn(rows: FlowRow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = row.event?.turnId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
}

export function structureTimeline(rows: readonly FlowRow[], working: boolean): RoundPart[] {
  const output: RoundPart[] = [];
  const runs: Array<{ start: number; rows: FlowRow[] }> = [];
  let current: FlowRow[] | null = null;
  rows.forEach((row, index) => {
    if (!isActivity(row.event)) { current = null; return; }
    if (!current) { current = []; runs.push({ start: index, rows: current }); }
    current.push(row);
  });
  const lastRun = runs.at(-1);
  const liveRun = working && lastRun && !rows.slice(lastRun.start + lastRun.rows.length).some(row => row.event) ? lastRun : undefined;
  let at = 0;
  for (const run of runs) {
    while (at < run.start) output.push({ kind: 'row', key: rows[at++]!.key });
    const live = run === liveRun;
    output.push(...recordedParts(run.rows, runTurn(run.rows), live, !live));
    at = run.start + run.rows.length;
  }
  while (at < rows.length) output.push({ kind: 'row', key: rows[at++]!.key });
  return output;
}
