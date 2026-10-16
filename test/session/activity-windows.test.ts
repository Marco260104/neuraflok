import {
  CHAT_ACTIVE_MS,
  CHAT_SILENCE_MS,
} from './context.js';
import { describe, expect, it } from 'vitest';

describe('activity windows', () => {
  /** The label must outlive the reload it triggers. Both durations came from one constant, so the Active badge expired on the same instant the silence ledger did — and the browser action still had this app's sweep and Chrome's alarm ahead of it. What a user saw was a chat going idle and then reloading itself half a minute later for no visible reason. Any future edit that collapses these two back into one number, or reorders them, reproduces that exactly. */
  it('keeps the Active badge alive past the silence reload it triggers', () => {
    expect(CHAT_SILENCE_MS).toBe(2 * 60_000);
    expect(CHAT_ACTIVE_MS).toBeGreaterThan(CHAT_SILENCE_MS);
    // Enough headroom for both hops a queued reload still has to make: this app's maintenance tick and the extension's thirty-second alarm floor.
    expect(CHAT_ACTIVE_MS - CHAT_SILENCE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
