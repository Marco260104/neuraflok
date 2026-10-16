import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usageMessageTotals } from '../contracts/usage.js';
const store = vi.hoisted(() => ({ listUsageSessions: vi.fn(), readEvents: vi.fn() }));
vi.mock('../backend/domains/sessions/history/store.js', () => store);
const durable = vi.hoisted(() => ({ readDurable: vi.fn(), writeDurableSoon: vi.fn() }));
vi.mock('../backend/persistence/durable.js', () => durable);
const logger = vi.hoisted(() => ({ logInfo: vi.fn() }));
vi.mock('../backend/infrastructure/settings/logger.js', async (importOriginal) => ({ ...(await importOriginal<object>()), logInfo: logger.logInfo }));
let usage: typeof import('../backend/domains/sessions/history/usage.js');
let now: number;
beforeEach(async () => {
  vi.resetModules();
  durable.readDurable.mockReset().mockResolvedValue(null); durable.writeDurableSoon.mockReset();
  store.listUsageSessions.mockReset().mockResolvedValue([]);
  store.readEvents.mockReset().mockResolvedValue([]);
  now = Date.parse('2026-09-05T12:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  usage = await import('../backend/domains/sessions/history/usage.js');
});
afterEach(() => vi.restoreAllMocks());
it('logs an overview pass only when it rebuilt something, not each refresh of the open page', async () => {
  store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 0 }]);
  logger.logInfo.mockReset();
  await usage.usageOverview();
  expect(logger.logInfo).toHaveBeenCalledTimes(1);
  expect(logger.logInfo.mock.calls[0]![0]).toContain('rebuilt=1');
  await usage.usageOverview();
  await usage.usageOverview();
  expect(logger.logInfo).toHaveBeenCalledTimes(1);
});
describe('supported provider message counts', () => {
  const message = (messageId: string | undefined, time: number, extra = {}) => ({ kind: 'user_message', messageId, time, message: { text: '' }, ...extra });
  const start = (conversationId: string | null, time = now) => ({ kind: 'session_start', time, conversationId, title: 'Provider session' });
  beforeEach(() => {
    now = new Date(2026, 8, 21, 12).getTime();
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 20, estimatedTokens: 0 }]);
  });

  it('counts recorded sends for supported web providers and API conversations without model inference', async () => {
    store.readEvents.mockResolvedValue([
      start('ds-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), message('deepseek', now),
      start('km-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef'), message('kimi', now),
      start('qw-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeea'), message('qwen', now),
      start('gm-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeb'), message('glm', now),
      start('ap-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeec'), message('api', now, { model: 'custom-model' }),
      message('offered', now, { inputDelivery: 'offered' }),
      message('input:tool', now, { inputDelivery: 'confirmed' }),
      start('legacy-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), message('unsupported', now),
      message(undefined, now), message('invalid-time', Number.NaN)
    ]);
    const result = await usage.usageOverview();
    expect(usageMessageTotals(result.messages, 1)).toEqual({ date: '2026-09-21', sent: 5 });
    expect(result.tokens).toBe(0);
  });

  it('uses exact session conversation identity and counts only messages in that conversation', async () => {
    store.readEvents.mockResolvedValue([
      start('ds-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), message('first', now),
      start('ap-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeec'), message('second', now),
      start(null), message('unattributed', now)
    ]);
    const result = await usage.usageOverview();
    expect(usageMessageTotals(result.messages, 1)).toEqual({ date: '2026-09-21', sent: 2 });
  });

  it('uses authored time and inclusive local-week boundaries', async () => {
    const saturday = new Date(2026, 8, 19).getTime();
    store.readEvents.mockResolvedValue([
      start('ds-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
      message('before', saturday - 1), message('at-start', saturday),
      message('now', now), message('future', now + 1),
      message('old-replayed', now, { authoredAt: new Date(2026, 8, 12).getTime() }),
      message('bad-time', now, { authoredAt: NaN }), message('zero-time', now, { authoredAt: 0 })
    ]);
    const result = await usage.usageOverview();
    expect(result.messages.through).toBe(now);
    expect(usageMessageTotals(result.messages, 6)).toEqual({ date: '2026-09-19', sent: 2 });
    expect(usageMessageTotals(result.messages, 1)).toMatchObject({ sent: 1 });
    now++;
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ sent: 2 });
    expect(store.readEvents).toHaveBeenCalledTimes(1);
  });

  it('deduplicates copied message identities and excludes conflicting provider evidence', async () => {
    store.listUsageSessions.mockResolvedValue(['one', 'two'].map(id => ({ id, updatedAt: 1, events: 4, estimatedTokens: 0 })));
    const startDeepSeek = start('ds-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const native = message('native-id', now);
    store.readEvents.mockResolvedValueOnce([startDeepSeek, native, native, message('conflicting', now)])
      .mockResolvedValueOnce([startDeepSeek, native, start('km-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef'), message('conflicting', now)]);
    const first = await usage.usageOverview();
    expect(usageMessageTotals(first.messages, 1)).toMatchObject({ sent: 1 });
    first.messages.days[0]!.sent = 999;
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ sent: 1 });
    expect(store.readEvents).toHaveBeenCalledTimes(2);
  });

  it('reuses provider identity after restart and advances the week without rereading unchanged recordings', async () => {
    store.readEvents.mockResolvedValue([start('qw-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeea'), message('native', now)]);
    await usage.usageOverview();
    const saved = structuredClone(durable.writeDurableSoon.mock.calls.at(-1)![1]);
    vi.resetModules(); durable.readDurable.mockResolvedValue(saved); store.readEvents.mockClear();
    usage = await import('../backend/domains/sessions/history/usage.js');
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ sent: 1 });
    now = new Date(2026, 8, 28).getTime();
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toEqual({ date: '2026-09-28', sent: 0 });
    expect(store.readEvents).not.toHaveBeenCalled();
  });

  it('ignores legacy conversations and removes deleted recordings from counts', async () => {
    store.readEvents.mockResolvedValue([start('ap-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeec'), message('native', now)]);
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ sent: 1 });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 20, estimatedTokens: 0 }]);
    store.readEvents.mockResolvedValue([start('legacy-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), message('legacy', now)]);
    expect(usageMessageTotals((await usage.usageOverview()).messages, 1)).toMatchObject({ sent: 0 });
    store.listUsageSessions.mockResolvedValue([]);
    expect((await usage.usageOverview()).messages.days).toEqual([]);
  });
});
describe('canonical token totals', () => {
  it('counts only the outer code-mode exchange while retaining ordinary calls sharing its request', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, nested = false) => ({ kind: 'tool_call', time, call: {
      callId, nested, requestId: 'same-generation', conversationId: 'chat',
      args: { text: 'aaaa' }, result: nested ? { text: 'preview', truncated: true, chars: 80_000 } : { text: 'bbbb' }, summary: { title: '' }
    } });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 4, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([call('child-a', true), call('child-b', true), call('outer'), call('direct')]);
    // Four context tokens across two outer calls; nested code-mode calls add no usage.
    expect((await usage.usageOverview()).tokens).toBe(4);
  });
  it('recomputes changed session revisions and removes deleted sessions from daily totals', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 1 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    expect(await usage.usageOverview()).toMatchObject({ tokens: 0.5, sessions: 1, days: [{ date: '2026-09-05', tokens: 0.5 }] });
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 1, estimatedTokens: 2 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaaaaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).days).toMatchObject([{ date: '2026-09-05', tokens: 1 }]);
    expect(store.readEvents).toHaveBeenCalledTimes(2);
    store.listUsageSessions.mockResolvedValue([]);
    expect(await usage.usageOverview()).toMatchObject({ tokens: 0, sessions: 0, days: [] });
  });
  it('uses final frontend context times unique tool calls divided by two', async () => {
    const time = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, conversationId = 'a') => ({ kind: 'tool_call', time, call: { callId, conversationId, args: { text: 'aaaa' }, result: { text: 'bbbb' }, summary: { title: '' } } });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 6, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([
      { kind: 'user_message', time, message: { text: 'aaaa' } },
      call('1'), call('2'), call('2'), call('3', 'b')
    ]);
    // The first frontend contributes five tokens across two calls and the second adds one token.
    const results = await Promise.all([usage.usageOverview(), usage.usageOverview()]);
    expect(results[0]?.tokens).toBe(6);
    expect(results[0]?.days[0]?.tokens).toBe(6);
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(1);
  });
  it('assigns work to the call day and does not charge authored-only sessions', async () => {
    const first = new Date(2026, 8, 4, 23, 59).getTime();
    const second = new Date(2026, 8, 5, 0, 1).getTime();
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 3, estimatedTokens: 999 }]);
    store.readEvents.mockResolvedValue([
      { kind: 'user_message', time: first, message: { text: 'aaaa' } },
      { kind: 'tool_call', time: second, call: { callId: 'one', conversationId: 'a', args: { text: 'bbbb' }, result: { text: '' }, summary: { title: '' } } },
      { kind: 'assistant_message', time: second, message: { text: 'cccc' } }
    ]);
    expect((await usage.usageOverview()).days).toMatchObject([{ date: '2026-09-05', tokens: 1.5 }]);
    store.listUsageSessions.mockResolvedValue([{ id: 'text-only', updatedAt: 1, events: 1, estimatedTokens: 99 }]);
    store.readEvents.mockResolvedValue([{ kind: 'user_message', time: first, message: { text: 'aaaa' } }]);
    expect((await usage.usageOverview()).tokens).toBe(0);
  });
  it('reuses valid persisted revisions after restart without rereading transcripts', async () => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 1 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } }]);
    const first = await usage.usageOverview();
    const persisted = durable.writeDurableSoon.mock.calls.at(-1)![1];
    vi.resetModules(); durable.readDurable.mockResolvedValue(persisted); store.readEvents.mockClear();
    usage = await import('../backend/domains/sessions/history/usage.js');
    expect((await usage.usageOverview()).tokens).toBe(first.tokens);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('caps long frontend estimates before aggregation while preserving raw context and short successors', async () => {
    const first = new Date(2026, 8, 4, 12).getTime();
    const second = new Date(2026, 8, 5, 12).getTime();
    const call = (callId: string, time: number, model: string, conversationId = 'a') => ({ kind: 'tool_call', time, call: { callId, conversationId, model, args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' } } });
    const session = { id: 'one', updatedAt: 1, events: 9, estimatedTokens: 2_000_000, contextTokens: 2_000_000 };
    const events = [
      { kind: 'user_message', time: first, message: { text: 'preview', truncated: true, chars: 8_000_000 } },
      call('1', first, 'deepseek-chat'), call('2', first, 'deepseek-chat'), call('3', first, 'deepseek-chat'),
      call('4', second, 'kimi-k2'), call('4', second, 'kimi-k2'),
      { kind: 'session_start', time: second, conversationId: 'b' },
      { kind: 'user_message', time: second, message: { text: 'aaaa' } },
      call('5', second, 'deepseek-chat', 'b')
    ];
    store.listUsageSessions.mockResolvedValue([session]); store.readEvents.mockResolvedValue(events);
    const result = await usage.usageOverview();
    expect(result.tokens).toBe(512_001);
    expect(result.days.map(day => [day.date, day.tokens])).toEqual([['2026-09-04', 384_000], ['2026-09-05', 128_001]]);
    expect(result.models).toEqual([
      { model: 'deepseek-chat', reasoningEffort: null, assumed: false, tokens: 384_001 },
      { model: 'kimi-k2', reasoningEffort: null, assumed: false, tokens: 128_000 }
    ]);
    const { usageEstimate, DEFAULT_USAGE_FORMULA } = await import('../contracts/usage.js');
    expect(usageEstimate(result.models, { ...DEFAULT_USAGE_FORMULA, divisor: 1 }).tokens).toBe(1_024_002);
    expect(usageEstimate(result.models, { ...DEFAULT_USAGE_FORMULA, divisor: 4 }).tokens).toBe(256_000.5);
    expect(session).toMatchObject({ estimatedTokens: 2_000_000, contextTokens: 2_000_000 });
    const { eventTokens } = await import('../contracts/session.js');
    expect(eventTokens(events[0] as Parameters<typeof eventTokens>[0])).toBe(2_000_000);
  });
  it.each([255_999, 256_000, 256_001, 2_000_000])('bounds a %i-token frontend without scaling short context', async (context) => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: context }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', args: { text: '', truncated: true, chars: context * 4 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(Math.min(context, 256_000) / 2);
  });
  it('uses a fixed local estimate ceiling independent of provider model catalogs', async () => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'deepseek-chat',
      args: { text: '', truncated: true, chars: 8_000_000 }, result: { text: '' }, summary: { title: '' } } }]);
    expect(await usage.usageOverview()).toMatchObject({ contextTokenCap: 256_000, tokens: 128_000 });
  });
  it.each([4, 5, 6, 7, 8, 9])('rebuilds old cache version %i and reuses the corrected cache after restart', async (version) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    durable.readDurable.mockResolvedValue({ version, rows: [{ id: 'one', revision: `${timezone}:1:1:2000000`, days: [['2026-09-05', [{ model: 'deepseek-chat', reasoningEffort: null, assumed: false, tokens: 1_000_000 }]]] }] });
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 1, estimatedTokens: 2_000_000 }]);
    store.readEvents.mockResolvedValue([{ kind: 'tool_call', time: now, call: { callId: 'a', conversationId: 'chat', model: 'deepseek-chat', args: { text: '', truncated: true, chars: 8_000_000 }, result: { text: '' }, summary: { title: '' } } }]);
    expect((await usage.usageOverview()).tokens).toBe(128_000);
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    const persisted = durable.writeDurableSoon.mock.calls.at(-1)![1];
    expect(persisted.version).toBe(10);
    vi.resetModules(); durable.readDurable.mockResolvedValue(persisted); store.readEvents.mockClear();
    usage = await import('../backend/domains/sessions/history/usage.js');
    expect((await usage.usageOverview()).tokens).toBe(128_000);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('caps each return before aggregating frontend context and repeated call usage', async () => {
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 3, estimatedTokens: 400000 }]);
    store.readEvents.mockResolvedValue(Array.from({ length: 3 }, (_, i) => ({ kind: 'tool_call', time: now,
      call: { callId: String(i), conversationId: 'chat', args: { text: '' },
        result: { text: 'preview', truncated: true, chars: 524582 }, summary: { title: '' } } })));
    expect((await usage.usageOverview()).tokens).toBe(30000 / 2 * 3);
  });

  it('releases a failed calculation so opening again can retry', async () => {
    store.listUsageSessions.mockRejectedValueOnce(new Error('temporary read failure'));
    await expect(usage.usageOverview()).rejects.toThrow('temporary read failure');
    expect((await usage.usageOverview()).tokens).toBe(0);
  });
  it('shares background work with page visits and reads changed sessions one at a time', async () => {
    store.listUsageSessions.mockResolvedValue(['one', 'two'].map(id => ({ id, updatedAt: 1, events: 1, estimatedTokens: 0 })));
    let release!: () => void;
    store.readEvents.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const background = usage.usageOverview(new AbortController().signal);
    expect(usage.usageOverview()).toBe(background);
    await vi.waitFor(() => expect(store.readEvents).toHaveBeenCalledTimes(1));
    expect(store.readEvents.mock.calls[0]).toEqual(['one']);
    release();
    await background;
    expect(store.readEvents.mock.calls).toEqual([['one'], ['two']]);
    await usage.usageOverview();
    expect(store.readEvents).toHaveBeenCalledTimes(2);
  });
  it('cancels warmup between reads without publishing a partial cache and permits a later retry', async () => {
    store.listUsageSessions.mockResolvedValue(['one', 'two'].map(id => ({ id, updatedAt: 1, events: 1, estimatedTokens: 0 })));
    const controller = new AbortController();
    store.readEvents.mockImplementationOnce(async () => { controller.abort(); return []; });
    await expect(usage.usageOverview(controller.signal)).rejects.toThrow();
    expect(store.readEvents.mock.calls).toEqual([['one']]);
    expect(durable.writeDurableSoon).not.toHaveBeenCalled();
    expect((await usage.usageOverview()).sessions).toBe(2);
    expect(durable.writeDurableSoon).toHaveBeenCalledTimes(1);
  });
});

describe('model attribution and equivalent cost', () => {
  const call = (id: string, extra = {}) => ({ kind: 'tool_call', time: new Date(2026, 8, 5, 12).getTime(), call: { callId: id, conversationId: 'chat', args: { text: 'aaaa' }, result: { text: '' }, summary: { title: '' }, ...extra } });
  const message = (model?: string, reasoningEffort?: string, messageId = 'native') => ({ kind: 'user_message', time: now, messageId, message: { text: 'aaaa' }, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) });
  beforeEach(() => store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 1, events: 10, estimatedTokens: 10 }]));
  it('splits model and effort attribution without splitting final frontend context or duplicating calls', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), message('model-b', 'low'), call('b'), call('b')]);
    const result = await usage.usageOverview();
    expect(result.tokens).toBe(4);
    expect(result.models).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 2 },
      { model: 'model-b', reasoningEffort: 'low', assumed: false, tokens: 2 }
    ]);
    expect(result.days[0]?.models).toEqual(result.models);
  });
  it('a native user row without evidence clears earlier selection; injected rows neither select nor clear', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), message('wrong', 'low', 'input:x'), call('a'), message(), call('b')]);
    expect((await usage.usageOverview()).models).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 2.5 },
      { model: 'unknown', reasoningEffort: null, assumed: true, tokens: 2.5 }
    ]);
  });
  it('direct call model overrides only that call and never inherits a different models effort', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a', { model: 'model-b' }), call('b')]);
    expect((await usage.usageOverview()).models).toEqual([
      { model: 'model-b', reasoningEffort: null, assumed: false, tokens: 1.5 },
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 1.5 }
    ]);
  });
  it('a recorded legacy model name without effort does not turn assumed High into evidence', async () => {
    store.readEvents.mockResolvedValue([message('qwen-plus'), call('a')]);
    expect((await usage.usageOverview()).models).toEqual([
      { model: 'qwen-plus', reasoningEffort: null, assumed: false, tokens: 1 }
    ]);
  });
  it('new frontend and unattributed calls cannot inherit the previous model', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), call('b', { conversationId: 'other' }), call('c', { conversationId: null })]);
    const result = await usage.usageOverview();
    expect(result.models).toEqual([
      { model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 1 },
      { model: 'unknown', reasoningEffort: null, assumed: true, tokens: 1 }
    ]);
  });
  it('keeps effort changes for the same model separate and late evidence invalidates the saved revision', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a'), message('model-a', 'low'), call('b')]);
    expect((await usage.usageOverview()).models.map(row => row.reasoningEffort)).toEqual(['high', 'low']);
    store.listUsageSessions.mockResolvedValue([{ id: 'one', updatedAt: 2, events: 10, estimatedTokens: 10 }]);
    store.readEvents.mockResolvedValue([message('model-b', 'low'), call('a')]);
    expect((await usage.usageOverview()).models).toEqual([{ model: 'model-b', reasoningEffort: 'low', assumed: false, tokens: 1 }]);
  });
  it('reuses model totals from persisted cache without transcript reads or aliasing returned values', async () => {
    store.readEvents.mockResolvedValue([message('model-a', 'high'), call('a')]);
    const first = await usage.usageOverview();
    const saved = structuredClone(durable.writeDurableSoon.mock.calls.at(-1)![1]);
    first.models[0]!.tokens = 999;
    first.days[0]!.models[0]!.tokens = 999;
    expect((await usage.usageOverview()).tokens).toBe(1);
    vi.resetModules(); durable.readDurable.mockResolvedValue(saved); store.readEvents.mockClear();
    usage = await import('../backend/domains/sessions/history/usage.js');
    expect((await usage.usageOverview()).models).toEqual([{ model: 'model-a', reasoningEffort: 'high', assumed: false, tokens: 1 }]);
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('projects editable divisor and per-model cached rates while exposing unknown cost', async () => {
    const { usageEstimate } = await import('../contracts/usage.js');
    const rows = [
      { model: 'a', reasoningEffort: 'high', assumed: false, tokens: 1e6 },
      { model: 'b', reasoningEffort: 'low', assumed: false, tokens: 2e6 },
      { model: 'unknown', reasoningEffort: null, assumed: false, tokens: 1e6 }
    ];
    expect(usageEstimate(rows, { divisor: 2, multiplier: 1.2, rates: { a: 0.4, b: 1 } })).toEqual({ tokens: 4e6, cost: 2.88, unpricedTokens: 1e6 });
    expect(usageEstimate(rows, { divisor: 4, multiplier: 1, rates: { a: 0, b: 1 } })).toEqual({ tokens: 2e6, cost: 1, unpricedTokens: 0.5e6 });
    expect(rows[0]!.tokens).toBe(1e6);
  });
  it('keeps unpriced provider models exact and honors explicit user-entered rates', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate } = await import('../contracts/usage.js');
    const rows = [{ model: 'kimi-k2', reasoningEffort: null, assumed: false, tokens: 427245 }];
    expect(usageEstimate(rows, DEFAULT_USAGE_FORMULA)).toEqual({ tokens: 427245, cost: 0, unpricedTokens: 427245 });
    for (const rate of [null, 0, 0.8]) {
      const estimate = usageEstimate(rows, { ...DEFAULT_USAGE_FORMULA, rates: { ...DEFAULT_USAGE_FORMULA.rates, 'kimi-k2': rate } });
      expect(estimate.unpricedTokens).toBe(rate === null ? 427245 : 0);
      expect(estimate.cost).toBeCloseTo(rate === null ? 0 : 427245 / 1e6 * rate * 1.2);
    }
    expect(usageEstimate(rows, { ...DEFAULT_USAGE_FORMULA, rates: { 'kimi-k2': 0.8 } }).cost).toBeCloseTo(0.4101552);
    expect(rows[0]!.model).toBe('kimi-k2');
  });
  it('does not merge distinct provider model identifiers', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate } = await import('../contracts/usage.js');
    const rows = ['deepseek-chat', 'deepseek-reasoner', 'kimi-k2', 'qwen-plus', 'glm-4'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 }));
    const estimate = usageEstimate(rows, DEFAULT_USAGE_FORMULA);
    expect(estimate).toEqual({ tokens: 5e6, cost: 0, unpricedTokens: 5e6 });
  });
  it('groups only exact model, effort, and attribution identities', async () => {
    const { DEFAULT_USAGE_FORMULA, usageEstimate, usageModelGroups } = await import('../contracts/usage.js');
    const rows = [
      ...['deepseek-chat', 'deepseek-reasoner', 'kimi-k2', 'qwen-plus'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 })),
      { model: 'deepseek-chat', reasoningEffort: 'high', assumed: true, tokens: 1e6 },
      { model: 'deepseek-chat', reasoningEffort: null, assumed: false, tokens: 1e6 },
      ...['glm-4', 'qwen-max', 'kimi-thinking', 'custom-model'].map(model => ({ model, reasoningEffort: 'high', assumed: false, tokens: 1e6 }))
    ];
    const groups = usageModelGroups(rows);
    expect(groups).toHaveLength(10);
    expect(groups[0]).toMatchObject({ model: 'deepseek-chat', reasoningEffort: 'high', assumed: false });
    expect(groups[0]!.sources).toHaveLength(1);
    const formula = { ...DEFAULT_USAGE_FORMULA, rates: { 'deepseek-chat': 0.8 } };
    expect(usageEstimate(groups[0]!.sources, formula)).toEqual({ tokens: 1e6, cost: 0.96, unpricedTokens: 0 });
    expect(usageEstimate(rows.slice(-1), DEFAULT_USAGE_FORMULA).unpricedTokens).toBe(1e6);
    expect(rows[0]!.model).toBe('deepseek-chat');
  });
});

it('does not invent provider rates', async () => {
  const { DEFAULT_USAGE_FORMULA: formula, usageRate } = await import('../contracts/usage.js');
  for (const id of ['deepseek-chat', 'kimi-k2', 'qwen-plus', 'glm-4', 'custom-api-model']) expect(usageRate(id, formula)).toBeUndefined();
});
