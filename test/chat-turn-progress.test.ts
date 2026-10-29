import { expect, it } from 'vitest';
import { blocksStopForWarmup, shouldSuppressWarmupActivity, visibleWarmupPhase } from '../frontend/features/chat/chat-composer-ready.js';
import { isInternalWarmupTurnOpen } from '../frontend/features/chat/chat-turn-state.js';

it('keeps project preparation invisible until an authored message is waiting', () => {
  expect(visibleWarmupPhase('opening', false)).toBeNull();
  expect(visibleWarmupPhase('opening', true)).toBe('opening');
  expect(visibleWarmupPhase('failed', false)).toBeNull();
  expect(visibleWarmupPhase('failed', true)).toBe('failed');
});

it('keeps internal warmup hidden until an authored message is waiting', () => {
  expect(shouldSuppressWarmupActivity({ phase: 'opening', priorTurnWorking: false }, false)).toBe(true);
  expect(shouldSuppressWarmupActivity({ phase: 'opening' }, false)).toBe(true);
  expect(shouldSuppressWarmupActivity({ phase: 'opening', priorTurnWorking: false }, true)).toBe(false);
  expect(shouldSuppressWarmupActivity({ phase: 'opening', priorTurnWorking: true }, false)).toBe(true);
  expect(shouldSuppressWarmupActivity({ phase: 'failed', priorTurnWorking: false }, false)).toBe(true);
});

it('keeps an open hidden warmup turn from appearing as Thinking after a chat is restored', () => {
  const events = [
    { seq: 1, time: 100, source: 'extension', kind: 'turn_start', turnId: 'warmup-turn', internalWarmup: true },
    { seq: 2, time: 101, source: 'extension', kind: 'progress', turnId: 'warmup-turn',
      message: { text: 'Checking context…', chars: 19, truncated: false } },
  ] as const;

  expect(isInternalWarmupTurnOpen(events as never, 'warmup-turn', 90)).toBe(true);
  expect(isInternalWarmupTurnOpen([...events, {
    seq: 3, time: 102, source: 'extension', kind: 'turn_end', turnId: 'warmup-turn', outcome: 'completed'
  }] as never, 'warmup-turn', 90)).toBe(false);
  expect(isInternalWarmupTurnOpen(events as never, 'warmup-turn', 110)).toBe(false);
});

it('keeps a stale Stop hidden while a warmup is opening or waiting for retry', () => {
  expect(blocksStopForWarmup({ phase: 'opening' })).toBe(true);
  expect(blocksStopForWarmup({ phase: 'failed', error: 'context not detected' })).toBe(true);
  expect(blocksStopForWarmup(null)).toBe(false);
});

it('releases a failed warmup Stop gate only for fresh public activity in its turn', () => {
  const warmup = { phase: 'failed' as const, error: 'context not detected', failedAt: 100, generation: 3 };
  const freshProgress = { seq: 4, time: 101, source: 'mcp' as const, kind: 'page_tool' as const,
    messageId: 'progress', turnId: 'authored-turn', label: 'Working…' };
  expect(blocksStopForWarmup(warmup, [freshProgress], 'authored-turn', 3)).toBe(false);
  expect(blocksStopForWarmup(warmup, [{ ...freshProgress, internalWarmup: true }], 'authored-turn', 3)).toBe(true);
  expect(blocksStopForWarmup(warmup, [freshProgress], 'authored-turn', 4)).toBe(false);
  expect(blocksStopForWarmup(warmup, [{ ...freshProgress, time: 99 }], 'authored-turn', 3)).toBe(true);
});
