import { expect, it } from 'vitest';
import { finishInstruction, supportsFinishAutomation } from '../contracts/automation/completion-policy.js';

it('enables finish automation only for supported model and mode combinations', () => {
  expect(supportsFinishAutomation('off', 'astra')).toBe(false);
  expect(supportsFinishAutomation('goal', 'astra')).toBe(true);
  expect(supportsFinishAutomation('goal', 'pro')).toBe(false);
  expect(supportsFinishAutomation('loop', 'pro')).toBe(true);
  expect(supportsFinishAutomation('loop', undefined)).toBe(false);
});

it('keeps a bounded verification window and completion-only instructions', () => {
  const standard = finishInstruction();
  const short = finishInstruction(3);
  expect(standard).toContain('about 5 minutes of final verification remain');
  expect(short).toContain('about 3 minutes of final verification remain');
  expect(short).toContain('follow-up corrections');
  expect(short).toContain('New instructions extend the work; they do not require another finish call');
  expect(short).toContain('Do not use this tool for progress updates');
});
