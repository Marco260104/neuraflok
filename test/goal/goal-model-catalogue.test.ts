import {
  defaultConfig,
  goal,
  saveConfig,
  setSecret,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('the model catalogue', () => {
  const listing = {
    data: [
      { id: 'old/model', name: 'Old', created: 1_000, context_length: 8_000 },
      { id: 'new/model', name: 'New', created: 9_000, context_length: 200_000 },
      { id: 'middle/model', name: 'Middle', created: 5_000 },
      { id: 42, name: 'nonsense' }
    ]
  };

  /** Sorted by release date rather than alphabetically or by popularity, because the question the picker answers is "what is new" — the reason to open it is that a better model exists than the one already chosen. */
  it('is newest first, twenty at a time, and skips entries it cannot read', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(listing), { status: 200 });
    }) as never;

    const page = await goal.listGoalModels(0, 2);
    expect(page.total).toBe(3);
    expect(page.models.map((model) => model.id)).toEqual(['new/model', 'middle/model']);
    expect(page.models[0]!.contextLength).toBe(200_000);
    // A listing that did not say when a model was released still lists it.
    expect(page.models[1]!.contextLength).toBe(0);

    const next = await goal.listGoalModels(2, 2);
    expect(next.models.map((model) => model.id)).toEqual(['old/model']);
    // The listing is small and changes daily, not by the second: the second page came out of the cache rather than off the network.
    expect(calls).toBe(1);
    expect(goal.MODEL_PAGE_SIZE).toBe(20);
  });

  it('searches the whole catalogue before paging matches', async () => {
    const entries = Array.from({ length: 45 }, (_, index) => ({
      id: `vendor/model-${index}`,
      name: `Model ${index}`,
      created: 10_000 - index
    }));
    entries[44] = { id: 'hidden/vendor-needle', name: 'Needle Model', created: 1 };
    globalThis.fetch = vi.fn(async () => Response.json({ data: entries }));

    const byName = await goal.listGoalModels(0, 20, 'needle');
    expect(byName.total).toBe(1);
    expect(byName.models.map(model => model.id)).toEqual(['hidden/vendor-needle']);

    const byId = await goal.listGoalModels(0, 20, 'VENDOR-NEEDLE');
    expect(byId.total).toBe(1);
    expect(byId.models.map(model => model.id)).toEqual(['hidden/vendor-needle']);

    const cleared = await goal.listGoalModels(0, 20, '   ');
    expect(cleared.total).toBe(45);
    expect(cleared.models).toHaveLength(20);
    expect(cleared.models[0]?.id).toBe('vendor/model-0');
  });

  it('returns catalogue reasoning metadata for the selected model even outside the requested page', async () => {
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, model: 'selected/old-model' } });
    globalThis.fetch = vi.fn(async () => Response.json({ data: [
      { id: 'new/model', name: 'New', created: 9000 },
      { id: 'selected/old-model', name: 'Selected', created: 1, reasoning: {
        supported_efforts: ['max', 'high', 'low'], default_effort: 'max', mandatory: true
      } }
    ] }));
    const page = await goal.listGoalModels(0, 1);
    expect(page.models.map(model => model.id)).toEqual(['new/model']);
    expect(page.selectedModel).toMatchObject({ id: 'selected/old-model', reasoning: {
      supportedEfforts: ['max', 'high', 'low'], defaultEffort: 'max', mandatory: true
    } });
    expect((await goal.listGoalModels(1, 1)).models[0]).toEqual(page.selectedModel);
  });

  it('does not reuse a restricted model catalogue after the OpenRouter key is replaced', async () => {
    const seenAuth: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
      seenAuth.push(authorization);
      const id = authorization.endsWith('key-b') ? 'only-for-b' : 'only-for-a';
      return new Response(JSON.stringify({ data: [{ id, name: id, created: 1 }] }), { status: 200 });
    }) as never;

    await setSecret('openRouterApiKey', 'key-a');
    expect((await goal.listGoalModels()).models.map((model) => model.id)).toEqual(['only-for-a']);
    await setSecret('openRouterApiKey', 'key-b');
    expect((await goal.listGoalModels()).models.map((model) => model.id)).toEqual(['only-for-b']);
    expect(seenAuth).toEqual(['Bearer key-a', 'Bearer key-b']);
  });

  it('says the listing failed rather than pretending the catalogue is empty', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as never;
    await expect(goal.listGoalModels(0, 20)).rejects.toThrow('HTTP 500');
  });

  it('times out a model catalogue request whose provider never answers', async () => {
    vi.useFakeTimers();
    try {
      const opened: { signal: AbortSignal | null } = { signal: null };
      let markFetchStarted: () => void = () => {};
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        opened.signal = init?.signal ?? null;
        markFetchStarted();
        return await new Promise<Response>((_resolve, reject) => {
          opened.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as never;

      // Attach the rejection observer before advancing fake time; otherwise Node correctly reports the timeout rejection as temporarily unhandled before the assertion below.
      const pending = goal.listGoalModels().then(
        () => null,
        (error: Error) => error
      );
      // Secret lookup now initializes Electron's non-blocking async safeStorage provider before the network request. Wait for the observable fetch boundary instead of assuming an exact number of internal promise turns between the API call and provider I/O.
      await fetchStarted;
      expect(opened.signal).not.toBeNull();
      await vi.advanceTimersByTimeAsync(31_000);
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a model catalogue whose declared body exceeds the bounded provider response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(listing), {
        status: 200,
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) }
      })) as never;

    await expect(goal.listGoalModels()).rejects.toThrow(/body.*too large/i);
  });

  it('bounds untrusted model fields and catalogue cardinality before caching them', async () => {
    const hugeName = 'n'.repeat(2_000);
    const entries = Array.from({ length: 5_100 }, (_, index) => ({
      id: `provider/model-${index}`,
      name: index === 0 ? hugeName : `Model ${index}`,
      created: index
    }));
    // An identifier too large to be a sane provider id is not safe to persist into config or send back as a selection, so it should be skipped rather than truncated into a different id. Display names may be truncated because they are presentation only.
    entries.push({ id: `provider/${'x'.repeat(1_000)}`, name: 'bad id', created: 99_999 });
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: entries }), { status: 200 })) as never;

    const page = await goal.listGoalModels(0, 100);
    expect(page.total).toBeLessThanOrEqual(5_000);
    expect(page.models.some((model) => model.id.length > 500)).toBe(false);
    expect(page.models.every((model) => model.name.length <= 500)).toBe(true);
  });
});
