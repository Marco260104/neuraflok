import { SAMPLE_BRIEF, briefShortfall } from './context.js';
import { describe, expect, it } from 'vitest';

describe('a brief that cannot be the whole handoff', () => {
  it('refuses nothing at all', () => {
    expect(briefShortfall('', 50_000)).toMatch(/nothing/i);
    expect(briefShortfall('   \n  ', 50_000)).toMatch(/nothing/i);
  });

  it('refuses the twenty-eight characters that started this', () => {
    const cut = 'TASK\nContinue implementing `';
    const refusal = briefShortfall(cut, 318_422);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain('28 characters');
  });

  it('refuses a plausible-looking brief that is far too small for the session it carries', () => {
    // Long enough to read as a document, and nowhere near enough to be one. This is the shape a turn cut off mid-way actually produces.
    const partial = `TASK — ${'continue the rewrite. '.repeat(12)}`;
    expect(partial.length).toBeGreaterThan(200);
    expect(briefShortfall(partial, 300_000)).toMatch(/cannot be the whole handoff/i);
    // The same text is a fine brief for a session that has barely started.
    expect(briefShortfall(partial, 900)).toBeNull();
  });

  it('accepts a real one', () => {
    expect(briefShortfall(SAMPLE_BRIEF, 318_422)).toBeNull();
  });
});
