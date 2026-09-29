import type { FlowRow, RoundPart } from './types.js';

export function recordedParts(
  run: FlowRow[],
  turnId: string | undefined,
  live: boolean,
  finished: boolean
): RoundPart[] {
  const parts: RoundPart[] = [];
  let open: Extract<RoundPart, { kind: 'work' }> | null = null;
  const prefix = turnId ?? run[0]!.key;
  for (const row of run) {
    const event = row.event!;
    if (event.kind === 'assistant_message' || event.kind === 'progress') {
      open = null;
      parts.push({ kind: 'say', key: row.key, rowKey: row.key });
      continue;
    }
    if (!open) {
      open = { kind: 'work', key: `work:${prefix}:${row.key}`, rows: [], recap: null, live: false, turnId };
      parts.push(open);
    }
    open.rows.push(row.key);
  }
  for (const [index, part] of parts.entries()) {
    if (part.kind !== 'work') continue;
    const closed = index < parts.length - 1 || finished;
    const last = run.find(row => row.key === part.rows.at(-1));
    if (closed && last?.event?.kind === 'page_tool' && part.rows.length > 1) {
      part.recap = last.event.label;
      part.rows.pop();
    }
  }
  if (live) {
    const last = parts.at(-1);
    if (last?.kind === 'work') last.live = true;
  }
  return parts;
}
