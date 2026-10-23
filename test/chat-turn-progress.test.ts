import { expect, it } from 'vitest';
import { shouldSuppressWarmupActivity, visibleWarmupPhase } from '../frontend/features/chat/chat-composer-ready.js';

it('keeps project preparation invisible until an authored message is waiting', () => {
  expect(visibleWarmupPhase('opening', false)).toBeNull();
  expect(visibleWarmupPhase('opening', true)).toBe('opening');
  expect(visibleWarmupPhase('failed', false)).toBeNull();
  expect(visibleWarmupPhase('failed', true)).toBe('failed');
});

it('hides the internal warmup turn while preserving real work already in progress', () => {
  expect(shouldSuppressWarmupActivity({ phase: 'opening', priorTurnWorking: false }, false)).toBe(true);
  expect(shouldSuppressWarmupActivity({ phase: 'opening' }, false)).toBe(true);
  expect(shouldSuppressWarmupActivity({ phase: 'opening', priorTurnWorking: false }, true)).toBe(false);
  expect(shouldSuppressWarmupActivity({ phase: 'opening', priorTurnWorking: true }, false)).toBe(false);
  expect(shouldSuppressWarmupActivity({ phase: 'failed', priorTurnWorking: false }, false)).toBe(false);
});
