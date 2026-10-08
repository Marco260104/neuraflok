import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearWebProviderPresence,
  readWebProviderPresence,
  recordWebProviderPresence,
  resetWebProviderPresence
} from '../backend/domains/providers/presence.js';

describe('web provider presence', () => {
  beforeEach(() => resetWebProviderPresence());

  it('accepts only app-owned sightings and retains a live login through brief background gaps', () => {
    const first = recordWebProviderPresence({
      deepseek: { open: true, signedIn: true, tabId: 4 },
      kimi: { open: true, signedIn: false, tabId: 8 }
    }, 1_000);

    expect(first.changed).toBe(true);
    expect(first.labels).toEqual([
      { provider: 'deepseek', state: 'DeepSeek signed in' },
      { provider: 'kimi', state: 'Kimi open, signed out' }
    ]);

    recordWebProviderPresence({}, 20_000);
    expect(readWebProviderPresence(true, 20_000).deepseek).toMatchObject({ open: true, signedIn: true, tabId: 4 });
    recordWebProviderPresence({}, 27_000);
    expect(readWebProviderPresence(true, 27_000).deepseek).toMatchObject({ open: false, signedIn: null, tabId: null });
  });

  it('expires stale provider state after the bridge presence window', () => {
    recordWebProviderPresence({ qwen: { open: true, signedIn: true, tabId: 12 } }, 1_000);

    expect(readWebProviderPresence(true, 60_999).qwen).toMatchObject({ open: true, signedIn: true });
    expect(readWebProviderPresence(true, 61_000).qwen).toMatchObject({
      open: false,
      signedIn: null,
      tabId: null,
      lastSeenAt: 1_000
    });
  });

  it('clears the selected provider and resets all sightings', () => {
    recordWebProviderPresence({ glm: { open: true, signedIn: true, tabId: 15 } }, 1_000);

    expect(clearWebProviderPresence('glm', 2_000)).toBe(true);
    expect(readWebProviderPresence(true, 2_000).glm).toMatchObject({ open: false, signedIn: null, tabId: null, lastSeenAt: 2_000 });
    expect(clearWebProviderPresence('glm', 3_000)).toBe(false);

    resetWebProviderPresence();
    expect(readWebProviderPresence(true, 4_000).glm).toEqual({ open: false, signedIn: null, tabId: null, lastSeenAt: null });
  });
});
