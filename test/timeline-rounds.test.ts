import { describe, expect, it } from 'vitest';
import { structureTimeline, type FlowRow } from '../frontend/features/chat/timeline-rounds.js';
import type { SessionEvent } from '../contracts/session.js';

const TURN = 'provider-turn-1';
let seq = 0;
const base = (turnId: string | undefined = TURN) => ({ seq: ++seq, time: 1_000 + seq, source: 'extension' as const, ...(turnId ? { turnId } : {}) });
const text = (value: string) => ({ text: value, chars: value.length, truncated: false });
const user = (): FlowRow => { const event = { ...base(undefined), kind: 'user_message', message: text('Make three files') } as SessionEvent; return { key: `u${event.seq}`, event }; };
const call = (title: string, tool = 'apply_patch', extra: Record<string, unknown> = {}): FlowRow => {
  const event = { ...base(), kind: 'tool_call', call: { callId: `c${seq}`, tool, summary: { kind: 'create', title }, ...extra } } as unknown as SessionEvent;
  return { key: `c${event.seq}`, event };
};
const say = (value: string): FlowRow => {
  const event = { ...base(), kind: 'assistant_message', message: text(value), final: false, state: 'streaming' } as SessionEvent;
  return { key: `m${event.seq}`, event };
};
const answer = (value = 'Done'): FlowRow => {
  const event = { ...base(), kind: 'assistant_message', message: text(value), final: true, state: 'final' } as SessionEvent;
  return { key: `a${event.seq}`, event };
};
const step = (label: string): FlowRow => {
  const event = { ...base(), kind: 'page_tool', messageId: `p${seq}`, label } as SessionEvent;
  return { key: `p${event.seq}`, event };
};
const shape = (parts: ReturnType<typeof structureTimeline>) => parts.map(part =>
  part.kind === 'row' ? `row ${part.key}` :
  part.kind === 'say' ? `say ${part.rowKey}` :
  `work[${part.rows.join(',')}]${part.recap ? ` "${part.recap}"` : ''}${part.live ? ' live' : ''}`);

describe('timeline rounds from recorded provider activity', () => {
  it('keeps recorded interim messages between the work groups they describe', () => {
    const rows = [user(), say('Looking first'), call('Read a'), step('Inspected the project'), say('Now editing'), call('Edited a'), answer()];
    expect(shape(structureTimeline(rows, false))).toEqual([
      `row ${rows[0]!.key}`, `say ${rows[1]!.key}`, `work[${rows[2]!.key}] "Inspected the project"`,
      `say ${rows[4]!.key}`, `work[${rows[5]!.key}]`, `row ${rows[6]!.key}`
    ]);
  });

  it('titles a finished tool group with its last recorded provider step', () => {
    const rows = [user(), call('Read package metadata', 'read'), step('Inspected package metadata'), answer()];
    expect(shape(structureTimeline(rows, false))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key}] "Inspected package metadata"`, `row ${rows[3]!.key}`
    ]);
  });

  it('keeps the newest recorded work group live while the turn is working', () => {
    const rows = [user(), call('Read package metadata'), step('Searching the web')];
    expect(shape(structureTimeline(rows, true))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key},${rows[2]!.key}] live`
    ]);
  });

  it('keeps a pending status row after the live work group', () => {
    const rows: FlowRow[] = [user(), call('Read package metadata'), { key: 'working' }, { key: 'now', tail: true }];
    expect(shape(structureTimeline(rows, true))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key}] live`, 'row working', 'row now'
    ]);
  });

  it('keeps nested tool calls with the recorded work group', () => {
    const rows = [user(), call('Ran code'), call('Read a', 'read', { nested: true }), answer()];
    expect(shape(structureTimeline(rows, false))).toEqual([
      `row ${rows[0]!.key}`, `work[${rows[1]!.key},${rows[2]!.key}]`, `row ${rows[3]!.key}`
    ]);
  });
});
