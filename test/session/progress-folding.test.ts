import {
  foldProgress,
} from './context.js';
import type {
  SessionEvent,
} from './context.js';
import { describe, expect, it } from 'vitest';

/** The log is append-only, so a commentary line being written arrives as a run of records under one id. Every reader that is not watching it live wants the opposite: the newest text, once, where the line started. */
describe('folding redrawn commentary', () => {
  const progress = (seq: number, progressId: string, text: string, origin?: number): SessionEvent =>
    ({
      seq,
      time: seq,
      source: 'extension',
      kind: 'progress',
      progressId,
      ...(origin === undefined ? {} : { origin }),
      message: { text, truncated: false, chars: text.length }
    }) as SessionEvent;

  it('keeps a Stop request truthful when the page reports stopped without a final answer', () => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. The assistant has not yet confirmed that generation stopped.'), source: 'app', turnId: 'stop-one' };
    const stopped: SessionEvent = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'stop-one', outcome: 'stopped' };
    const rows = [pending, stopped];
    const folded = foldProgress(rows);
    expect(folded).toHaveLength(2);
    expect(folded[0]).toEqual(pending);
    expect(foldProgress(folded)).toEqual(folded);
    expect(pending.kind === 'progress' && pending.message.text).toContain('not yet confirmed');
  });
  it.each(['completed', 'interrupted', 'error', 'unknown'])('does not confirm Stop from a %s outcome', outcome => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. Still unconfirmed.'), source: 'app', turnId: 'stop-one' };
    const end = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'stop-one', outcome } as SessionEvent;
    expect(foldProgress([pending, end])[0]).toEqual(pending);
  });
  it('never lets another turn or app-authored terminal evidence confirm a pending Stop', () => {
    const pending: SessionEvent = { ...progress(2, 'finish-release:stop-one', 'Stop requested. Still unconfirmed.'), source: 'app', turnId: 'stop-one' };
    const other: SessionEvent = { seq: 4, time: 4, source: 'extension', kind: 'turn_end', turnId: 'other', outcome: 'stopped' };
    const synthetic: SessionEvent = { ...other, source: 'app', turnId: 'stop-one' };
    expect(foldProgress([pending, other, synthetic])[0]).toEqual(pending);
  });

  it('keeps the newest text at the earliest record’s position', () => {
    const folded = foldProgress([
      progress(1, 'p1', 'Monitoring'),
      progress(2, 'p2', 'Reading'),
      progress(3, 'p1', 'Monitoring the review', 1),
      progress(4, 'p1', 'Wrote the summary', 1)
    ]);

    expect(folded.map((event) => event.seq)).toEqual([1, 2]);
    expect(folded.map((event) => (event as { message: { text: string } }).message.text)).toEqual([
      'Wrote the summary',
      'Reading'
    ]);
  });

  it('leaves everything that is not identified commentary exactly where it was', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, source: 'extension', kind: 'turn_start' } as SessionEvent,
      progress(2, 'p1', 'first'),
      // No id: an older recording, or a page that would not take the stamp. Nothing to fold.
      {
        seq: 3,
        time: 3,
        source: 'extension',
        kind: 'progress',
        message: { text: 'unidentified', truncated: false, chars: 12 }
      } as SessionEvent,
      progress(4, 'p1', 'second', 2),
      { seq: 5, time: 5, source: 'extension', kind: 'turn_end', outcome: 'completed' } as SessionEvent
    ];

    const folded = foldProgress(events);
    expect(folded.map((event) => event.seq)).toEqual([1, 2, 3, 5]);
    expect(foldProgress(events)).toEqual(folded);
    // Non-destructive: the original array is untouched.
    expect(events).toHaveLength(5);
  });
});
