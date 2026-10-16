import { describe, expect, it, vi } from 'vitest';
import { createChatInputNoticeDismissals } from '../frontend/features/chat/chat-input-notice-dismissals.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values
  };
}

describe('chat input notice dismissals', () => {
  it('restores only bounded string ids from local storage', () => {
    const storage = memoryStorage({ 'dismissed-input-notices': JSON.stringify(['old', 42, 'x'.repeat(65), ...Array.from({ length: 101 }, (_, index) => `notice-${index}`)]) });
    const state = createChatInputNoticeDismissals({ storage: () => storage, refreshInputQueue: async () => {} });

    expect(state.dismissedInputNotices.size).toBe(100);
    expect(state.dismissedInputNotices.has('old')).toBe(false);
    expect(state.dismissedInputNotices.has('notice-100')).toBe(true);
  });

  it('persists the newest hundred dismissals and refreshes the queue', () => {
    const storage = memoryStorage();
    const refreshInputQueue = vi.fn(async () => {});
    const state = createChatInputNoticeDismissals({ storage: () => storage, refreshInputQueue });

    for (let index = 0; index < 101; index += 1) state.dismissInputNotice(`notice-${index}`);

    const saved = JSON.parse(storage.values.get('dismissed-input-notices') ?? '[]') as string[];
    expect(saved).toHaveLength(100);
    expect(saved[0]).toBe('notice-1');
    expect(saved.at(-1)).toBe('notice-100');
    expect(state.dismissedInputNotices.has('notice-0')).toBe(true);
    expect(refreshInputQueue).toHaveBeenCalledTimes(101);
  });

  it('keeps a dismissal for this window and refreshes after storage fails', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('storage unavailable'); } };
    const refreshInputQueue = vi.fn(async () => {});
    const state = createChatInputNoticeDismissals({ storage: () => storage, refreshInputQueue });

    expect(() => state.dismissInputNotice('notice-1')).not.toThrow();
    expect(state.dismissedInputNotices.has('notice-1')).toBe(true);
    expect(refreshInputQueue).toHaveBeenCalledOnce();
  });
});
