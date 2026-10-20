import { expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension scripts are plain JavaScript and are exercised directly here.
import { createDeepseekPageExecutor } from '../browser-extension/src/background/providers/execution/deepseek.js';
// @ts-expect-error Browser extension scripts are plain JavaScript and are exercised directly here.
import { createDeepseekReplyWatcher } from '../browser-extension/src/background/providers/execution/deepseek-reply-watch.js';

const conversationId = 'ds-00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';

it('continues a DeepSeek reply at its explicit Continue control before finishing the input', async () => {
  vi.useFakeTimers();
  try {
    const partial = 'The response reached its first output limit, but the task is still being completed. '.repeat(2);
    const final = `${partial} The remaining steps are finished.`;
    let continueCount = 0;
    let posted: Record<string, unknown> | undefined;
    const state = {
      stoppedProviderOffers: new Set<string>(),
      readDeepseekSent: async () => ({ id: requestId, conversationId, tab: 7, before: '', beforeThink: '' }),
      writeDeepseekSent: vi.fn(async () => true),
      readProviderTab: vi.fn(async () => null),
      writeProviderTab: vi.fn(async () => true)
    };
    const executor = createDeepseekPageExecutor({
      chrome: { tabs: { get: async () => ({ id: 7, url: 'https://chat.deepseek.com/a/chat/s/abc', status: 'complete' }) } },
      activeTabs: { set: async () => undefined },
      call: async (path: string, init: { body?: string }) => {
        if (path === '/provider/page') posted = JSON.parse(init.body || '{}');
        return { ok: true, data: { ok: true } };
      },
      tabReply: async (_tabId: number, message: { type: string }) => {
        if (message.type === 'neuraflok-deepseek-continue') {
          continueCount++;
          return { continued: true };
        }
        return {
          answer: continueCount ? final : partial,
          text: continueCount ? final : partial,
          think: '',
          generating: false,
          ...(continueCount ? {} : { continueAvailable: true })
        };
      },
      createBrowserTab: vi.fn(),
      queryProviderTabs: vi.fn(),
      restoreDeepseekTab: vi.fn(),
      waitForTabReady: vi.fn(),
      isDeepseekUrl: (url: string) => url.startsWith('https://chat.deepseek.com/'),
      usableProviderTab: vi.fn(),
      state
    });

    executor.inspect({ id: requestId, provider: 'deepseek', conversationId, text: 'Finish the task', stop: false, fresh: false }, false);
    for (let tick = 0; tick < 24 && !posted; tick++) await vi.advanceTimersByTimeAsync(2_000);

    expect(continueCount).toBe(1);
    expect(posted).toMatchObject({ id: requestId, provider: 'deepseek', conversationId, text: final });
    expect(state.writeDeepseekSent).toHaveBeenCalledWith(null);
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('retries a transient DeepSeek tab read failure without failing an already-sent reply', async () => {
  vi.useFakeTimers();
  try {
    let reads = 0;
    let posted: Record<string, unknown> | undefined;
    const state = {
      stoppedProviderOffers: new Set<string>(),
      readDeepseekSent: async () => ({ id: requestId, conversationId, tab: 7, before: '', beforeThink: '' }),
      writeDeepseekSent: vi.fn(async () => true),
      readProviderTab: vi.fn(async () => null),
      writeProviderTab: vi.fn(async () => true)
    };
    const executor = createDeepseekPageExecutor({
      chrome: { tabs: { get: async () => ({ id: 7, url: 'https://chat.deepseek.com/a/chat/s/abc', status: 'complete' }) } },
      activeTabs: { set: async () => undefined },
      call: async (path: string, init: { body?: string }) => {
        if (path === '/provider/page') posted = JSON.parse(init.body || '{}');
        return { ok: true, data: { ok: true } };
      },
      tabReply: async (_tabId: number, message: { type: string }) => {
        if (message.type === 'neuraflok-deepseek-read' && reads++ === 0) throw new Error('temporary extension channel reset');
        return { answer: 'NEURAFLOK_READY', text: 'NEURAFLOK_READY', think: '', generating: false };
      },
      createBrowserTab: vi.fn(),
      queryProviderTabs: vi.fn(),
      restoreDeepseekTab: vi.fn(),
      waitForTabReady: vi.fn(),
      isDeepseekUrl: (url: string) => url.startsWith('https://chat.deepseek.com/'),
      usableProviderTab: vi.fn(),
      state
    });

    executor.inspect({ id: requestId, provider: 'deepseek', conversationId, text: 'Confirm the chat is ready', stop: false, fresh: false }, false);
    for (let tick = 0; tick < 8 && !posted; tick++) await vi.advanceTimersByTimeAsync(2_000);

    expect(reads).toBeGreaterThan(1);
    expect(posted).toMatchObject({ id: requestId, text: 'NEURAFLOK_READY' });
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('keeps waiting when DeepSeek is reasoning without showing a public answer', async () => {
  const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Finish the project', stop: false, fresh: false };
  let snapshot = { answer: '', text: '', think: 'I am inspecting the project files before editing.', generating: false };
  const progress: Array<Record<string, unknown>> = [];
  const call = vi.fn(async (_path: string, init: { body?: string }) => {
    progress.push(JSON.parse(init.body ?? '{}'));
    return { ok: true, data: { ok: true } };
  });
  const settle = vi.fn(async () => true);
  const watch = createDeepseekReplyWatcher({
    stoppedProviderOffers: new Set<string>(),
    call,
    tabReply: async (_tabId: number, message: { type: string }) =>
      message.type === 'neuraflok-deepseek-read' ? snapshot : null,
    postDeepseekPage: settle,
    timings: { readMs: 50, watchMs: 500, maxWatchMs: 5_000, readStaleMs: 5_000, pollMs: 2, emptyIdlePolls: 3 }
  });

  const watching = watch(7, offer, '', '', '');
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(settle).not.toHaveBeenCalled();
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.every(item => item.text === '')).toBe(true);

  snapshot = {
    answer: 'The requested changes are complete.',
    text: 'The requested changes are complete.',
    think: 'I am inspecting the project files before editing.',
    generating: false
  };
  await watching;
  expect(settle).toHaveBeenCalledWith(offer, { text: 'The requested changes are complete.' }, 7);
}, 15_000);
