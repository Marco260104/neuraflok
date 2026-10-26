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

it('carries the old assistant-message identity into recovery and never posts the old reply', async () => {
  vi.useFakeTimers();
  try {
    let posted: Record<string, unknown> | undefined;
    const identitySeen: Array<string | undefined> = [];
    const oldAnswer = 'The previous task is already complete.';
    const state = {
      stoppedProviderOffers: new Set<string>(),
      readDeepseekSent: async () => ({
        id: requestId, conversationId, tab: 7, before: oldAnswer, beforeThink: '', beforeIdentity: 'assistant-old'
      }),
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
      tabReply: async (_tabId: number, message: { type: string; beforeIdentity?: string }) => {
        if (message.type === 'neuraflok-deepseek-read') identitySeen.push(message.beforeIdentity);
        return { answer: '  The previous task is already   complete. ', answerIdentity: 'assistant-old', think: '', generating: false };
      },
      createBrowserTab: vi.fn(),
      queryProviderTabs: vi.fn(),
      restoreDeepseekTab: vi.fn(),
      waitForTabReady: vi.fn(),
      isDeepseekUrl: (url: string) => url.startsWith('https://chat.deepseek.com/'),
      usableProviderTab: vi.fn(),
      state,
      replyWatchTimings: { watchMs: 20, pollMs: 1, readMs: 5, readStaleMs: 100 }
    });

    executor.inspect({ id: requestId, provider: 'deepseek', conversationId, text: 'Now inspect the deployment.', stop: false, fresh: false }, false);
    await vi.advanceTimersByTimeAsync(50);

    expect(identitySeen.length).toBeGreaterThan(0);
    expect(identitySeen.every(identity => identity === 'assistant-old')).toBe(true);
    expect(posted).toMatchObject({ id: requestId, error: expect.stringContaining('did not finish this reply in time') });
    expect(posted).not.toHaveProperty('text');
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('keeps waiting when DeepSeek is reasoning without showing a public answer', async () => {
  const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Finish the project', stop: false, fresh: false };
  const privateReasoning = 'I am inspecting the project files before editing, checking the requested changes, and preparing the implementation plan.';
  let snapshot = { answer: '', text: privateReasoning, think: privateReasoning, generating: false };
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

  const watching = watch(7, offer, '', '', 'Initial private reasoning must never become a public progress message.');
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(settle).not.toHaveBeenCalled();
  expect(progress).toHaveLength(0);
  expect(progress.every(item => item.text === '')).toBe(true);
  expect(progress.every(item => !String(item.text).includes('inspecting the project'))).toBe(true);

  snapshot = {
    answer: 'The requested changes are complete.',
    text: 'The requested changes are complete.',
    think: 'I am inspecting the project files before editing.',
    generating: false
  };
  await watching;
  expect(settle).toHaveBeenCalledWith(offer, { text: 'The requested changes are complete.' }, 7);
}, 15_000);

it('uses elapsed time, not slow empty polls, to recover an idle DeepSeek reply', async () => {
  vi.useFakeTimers();
  try {
    const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Finish the project', stop: false, fresh: false };
    let readCount = 0;
    const snapshot = { answer: '', text: 'I am still reasoning privately.', think: 'I am still reasoning privately.', generating: false };
    const settle = vi.fn(async () => true);
    const watch = createDeepseekReplyWatcher({
      stoppedProviderOffers: new Set<string>(),
      call: async () => ({ ok: true, data: { ok: true } }),
      tabReply: async (_tabId: number, message: { type: string }) => {
        await new Promise(resolve => setTimeout(resolve, 8));
        if (message.type === 'neuraflok-deepseek-read') readCount++;
        return message.type === 'neuraflok-deepseek-read' ? snapshot : { before: '' };
      },
      postDeepseekPage: settle,
      timings: { readMs: 50, watchMs: 500, maxWatchMs: 5_000, readStaleMs: 5_000, pollMs: 10, emptyIdleMs: 35 }
    });

    const watching = watch(7, offer, '', '', '');
    await vi.advanceTimersByTimeAsync(200);
    await watching;

    expect(readCount).toBeLessThan(10);
    expect(settle).toHaveBeenCalledWith(offer, {
      error: expect.stringContaining('stopped without returning a reply'),
      providerIdle: true
    });
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('clicks DeepSeek Continue after private reasoning settles even when no public answer appeared', async () => {
  const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Finish the project', stop: false, fresh: false };
  const privateReasoning = 'I inspected the files and made the required edits, but I need to continue checking the project and finish the verification.';
  let snapshot = { answer: '', text: privateReasoning, think: privateReasoning, generating: false, continueAvailable: true };
  let continueCount = 0;
  const settle = vi.fn(async () => true);
  const watch = createDeepseekReplyWatcher({
    stoppedProviderOffers: new Set<string>(),
    call: async () => ({ ok: true, data: { ok: true } }),
    tabReply: async (_tabId: number, message: { type: string }) => {
      if (message.type === 'neuraflok-deepseek-continue') {
        continueCount++;
        snapshot = {
          answer: 'The requested changes are complete.',
          text: 'The requested changes are complete.',
          think: privateReasoning,
          generating: false,
          continueAvailable: false
        };
        return { continued: true };
      }
      return message.type === 'neuraflok-deepseek-read' ? snapshot : null;
    },
    postDeepseekPage: settle,
    timings: { readMs: 50, watchMs: 500, maxWatchMs: 5_000, readStaleMs: 5_000, pollMs: 2, emptyIdlePolls: 3 }
  });

  await watch(7, offer, '', '', privateReasoning);

  expect(continueCount).toBe(1);
  expect(settle).toHaveBeenCalledWith(offer, { text: 'The requested changes are complete.' }, 7);
}, 15_000);

it('stops a DeepSeek generation that has no observable progress and marks it safe to resume', async () => {
  vi.useFakeTimers();
  try {
    const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Finish the project', stop: false, fresh: false };
    let snapshot = { answer: '', text: '', think: '', generating: true };
    const stop = vi.fn(async () => {
      snapshot = { ...snapshot, generating: false };
      return { ok: true };
    });
    const settle = vi.fn(async (..._args: unknown[]) => true);
    const watch = createDeepseekReplyWatcher({
      stoppedProviderOffers: new Set<string>(),
      call: async () => ({ ok: true, data: { ok: true } }),
      tabReply: async (_tabId: number, message: { type: string; stop?: boolean }) => {
        if (message.type === 'neuraflok-deepseek-complete' && message.stop) return stop();
        return message.type === 'neuraflok-deepseek-read' ? snapshot : null;
      },
      postDeepseekPage: settle,
      timings: { readMs: 50, watchMs: 500, maxWatchMs: 5_000, readStaleMs: 5_000, pollMs: 10, stalledGenerationMs: 30, stopConfirmMs: 100 }
    });

    const watching = watch(7, offer, '', '', '');
    await vi.advanceTimersByTimeAsync(100);
    await watching;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(offer, {
      error: expect.stringContaining('stopped making observable progress'),
      providerIdle: true
    }, 7);
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('keeps a reply alive beyond its initial deadline while user-visible text progresses', async () => {
  vi.useFakeTimers();
  try {
    const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Finish the project', stop: false, fresh: false };
    let snapshot = { answer: '', text: '', think: 'Reading the files.', generating: true };
    const stop = vi.fn(async () => ({ ok: true }));
    const settle = vi.fn(async () => true);
    const watch = createDeepseekReplyWatcher({
      stoppedProviderOffers: new Set<string>(),
      call: async () => ({ ok: true, data: { ok: true } }),
      tabReply: async (_tabId: number, message: { type: string; stop?: boolean }) => {
        if (message.type === 'neuraflok-deepseek-complete' && message.stop) return stop();
        return message.type === 'neuraflok-deepseek-read' ? snapshot : null;
      },
      postDeepseekPage: settle,
      timings: { readMs: 50, watchMs: 20, maxWatchMs: 10, readStaleMs: 5_000, pollMs: 5, stalledGenerationMs: 30, stopConfirmMs: 100 }
    });

    setTimeout(() => { snapshot = { answer: 'I inspected the catalogue and am updating the logic.', text: '', think: 'Updating the catalogue logic.', generating: true }; }, 10);
    setTimeout(() => { snapshot = { answer: 'The requested changes are complete.', text: 'The requested changes are complete.', think: 'The tests passed.', generating: false }; }, 20);
    const watching = watch(7, offer, '', '', '');
    await vi.advanceTimersByTimeAsync(200);
    await watching;

    expect(stop).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(offer, { text: 'The requested changes are complete.' }, 7);
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('does not mark a DeepSeek request safe to resume unless generation is explicitly confirmed stopped', async () => {
  vi.useFakeTimers();
  try {
    const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Finish the project', stop: false, fresh: false };
    const snapshot = { answer: '', text: '', think: '', generating: true };
    const settle = vi.fn(async (..._args: unknown[]) => true);
    const watch = createDeepseekReplyWatcher({
      stoppedProviderOffers: new Set<string>(),
      call: async () => ({ ok: true, data: { ok: true } }),
      tabReply: async (_tabId: number, message: { type: string; stop?: boolean }) => {
        if (message.type === 'neuraflok-deepseek-complete' && message.stop) return { ok: true };
        return message.type === 'neuraflok-deepseek-read' ? snapshot : null;
      },
      postDeepseekPage: settle,
      timings: { readMs: 50, watchMs: 500, maxWatchMs: 5_000, readStaleMs: 5_000, pollMs: 10, stalledGenerationMs: 30, stopConfirmMs: 100 }
    });

    const watching = watch(7, offer, '', '', '');
    await vi.advanceTimersByTimeAsync(200);
    await watching;

    expect(settle).toHaveBeenCalledTimes(1);
    const failure = settle.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(failure).toMatchObject({ error: expect.stringContaining('did not confirm that generation stopped') });
    expect(failure).not.toHaveProperty('providerIdle');
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('does not publish a whitespace-different old answer from the snapshot recovery path', async () => {
  vi.useFakeTimers();
  try {
    const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'What changed today?', stop: false, fresh: false };
    const before = 'Yesterday\'s answer is still visible.';
    const settled = vi.fn(async (_offer: unknown, _body: Record<string, unknown>) => true);
    let reads = 0;
    const watch = createDeepseekReplyWatcher({
      stoppedProviderOffers: new Set<string>(),
      call: async () => ({ ok: true, data: { ok: true } }),
      tabReply: async (_tabId: number, message: { type: string; beforeIdentity?: string }) => {
        if (message.type === 'neuraflok-deepseek-read') {
          reads++;
          throw new Error('temporary read failure');
        }
        return {
          before: '  Yesterday\'s   answer is still visible.  ',
          beforeIdentity: 'assistant-yesterday',
          beforeThink: '',
          generating: false
        };
      },
      postDeepseekPage: settled,
      timings: { readMs: 5, watchMs: 30, readStaleMs: 100, pollMs: 1, emptyIdleMs: 4 }
    });

    const watching = watch(7, offer, before, '', '', 'assistant-yesterday');
    await vi.advanceTimersByTimeAsync(100);
    await watching;

    expect(reads).toBeGreaterThan(2);
    expect(settled).toHaveBeenCalled();
    expect(settled.mock.calls.every(([, body]) => !('text' in body))).toBe(true);
    expect(settled.mock.calls.at(-1)?.[1]).toMatchObject({ error: expect.stringContaining('did not finish this reply in time') });
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('accepts the same answer text when the page identifies a new assistant message', async () => {
  vi.useFakeTimers();
  try {
    const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Please confirm.', stop: false, fresh: false };
    const settled = vi.fn(async () => true);
    const watch = createDeepseekReplyWatcher({
      stoppedProviderOffers: new Set<string>(),
      call: async () => ({ ok: true, data: { ok: true } }),
      tabReply: async () => ({
        answer: 'Yes, it is ready.',
        answerIdentity: 'assistant-today',
        think: '',
        generating: false
      }),
      postDeepseekPage: settled,
      timings: { readMs: 5, watchMs: 100, readStaleMs: 100, pollMs: 1 }
    });

    const watching = watch(7, offer, 'Yes, it is ready.', '', '', 'assistant-yesterday');
    await vi.advanceTimersByTimeAsync(40);
    await watching;

    expect(settled).toHaveBeenCalledWith(offer, { text: 'Yes, it is ready.' }, 7);
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('does not trust a provisional node identity recreated after the provider page reloads', async () => {
  vi.useFakeTimers();
  try {
    const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Check the deployment again.', stop: false, fresh: false };
    const settled = vi.fn(async (_offer: unknown, _body: Record<string, unknown>) => true);
    const watch = createDeepseekReplyWatcher({
      stoppedProviderOffers: new Set<string>(),
      call: async () => ({ ok: true, data: { ok: true } }),
      tabReply: async () => ({ answer: 'Still complete.', answerIdentity: 'node:new-page:1', think: '', generating: false }),
      postDeepseekPage: settled,
      timings: { readMs: 5, watchMs: 15, readStaleMs: 100, pollMs: 1 }
    });

    const watching = watch(7, offer, 'Still complete.', '', '', 'node:old-page:3');
    await vi.advanceTimersByTimeAsync(30);
    await watching;

    expect(settled).toHaveBeenCalled();
    expect(settled.mock.calls.every(([, body]) => !('text' in body))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
}, 15_000);

it('passes the saved assistant-message identity to every provider read', async () => {
  const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'What now?', stop: false, fresh: false };
  const reads: Array<{ beforeIdentity?: string }> = [];
  const settled = vi.fn(async () => true);
  const watch = createDeepseekReplyWatcher({
    stoppedProviderOffers: new Set<string>(),
    call: async () => ({ ok: true, data: { ok: true } }),
    tabReply: async (_tabId: number, message: { type: string; beforeIdentity?: string }) => {
      if (message.type === 'neuraflok-deepseek-read') {
        reads.push(message);
        return { answer: 'Here is the current answer.', answerIdentity: 'assistant-current', generating: false };
      }
      return null;
    },
    postDeepseekPage: settled,
    timings: { readMs: 5, watchMs: 100, readStaleMs: 100, pollMs: 1 }
  });

  await watch(7, offer, '', '', '', 'assistant-before');

  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every(message => message.beforeIdentity === 'assistant-before')).toBe(true);
  expect(settled).toHaveBeenCalledWith(offer, { text: 'Here is the current answer.' }, 7);
});

it('keeps a reply alive through a simulated 31-minute task with steady visible progress', async () => {
  vi.useFakeTimers();
  let progressMinute = 0;
  let snapshot = {
    answer: 'Progress 00/31', answerIdentity: 'assistant-long-task', think: '', generating: true
  };
  let posted: Record<string, unknown> | undefined;
  const offer = { id: requestId, provider: 'deepseek', conversationId, text: 'Complete the long project task.', stop: false, fresh: false };
  const settle = vi.fn(async (_offer: unknown, body: Record<string, unknown>) => {
    posted = body;
    return true;
  });
  const advanceProgress = setInterval(() => {
    progressMinute++;
    snapshot = progressMinute >= 31
      ? { answer: 'The long task is complete after reviewing the project, applying the requested changes, and checking the results.', answerIdentity: 'assistant-long-task', think: '', generating: false }
      : { answer: `Progress ${String(progressMinute).padStart(2, '0')}/31`, answerIdentity: 'assistant-long-task', think: '', generating: true };
  }, 60_000);
  const watch = createDeepseekReplyWatcher({
    stoppedProviderOffers: new Set<string>(),
    call: async () => ({ ok: true, data: { ok: true } }),
    tabReply: async (_tabId: number, message: { type: string }) =>
      message.type === 'neuraflok-deepseek-read' ? snapshot : null,
    postDeepseekPage: settle,
    timings: { readMs: 5, watchMs: 5 * 60_000, readStaleMs: 5 * 60_000, pollMs: 60_000, stalledGenerationMs: 32 * 60_000 }
  });

  try {
    const watching = watch(7, offer, '', '', '', 'assistant-before');
    await vi.advanceTimersByTimeAsync(36 * 60_000);
    await watching;

    expect(progressMinute).toBeGreaterThanOrEqual(31);
    expect(posted).toEqual({ text: snapshot.answer });
    expect(String(posted?.text)).toContain('long task is complete');
  } finally {
    clearInterval(advanceProgress);
    vi.useRealTimers();
  }
}, 15_000);
