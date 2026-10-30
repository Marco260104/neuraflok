import {
  apiSettings,
  appendEvent,
  createSession,
  decision,
  defaultConfig,
  goal,
  saveConfig,
  setSecret,
  settled,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';
import { resetGoalModelCatalogCache } from '../../backend/domains/automation/goal-model-catalog.js';

describe('a custom OpenAI-compatible provider', () => {
  async function useCustom(over: Record<string, unknown> = {}): Promise<void> {
    await saveConfig({
      ...defaultConfig(),
      providers: { api: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } },
      goal: {
        ...defaultConfig().goal,
        enabled: true,
        // The api backend is the only one that fetches; the other backends never read the provider block.
        backend: 'api',
        loopBackend: 'api',
        model: 'llama3.1',
        reasoning: 'default',
        ...over
      }
    });
    // Keyless unless the test stores one: a local server usually needs no secret, and the OpenRouter key from the outer beforeEach must never leak into a custom request.
    await setSecret('customProviderApiKey', '');
  }

  async function userSession(conversationId: string): Promise<{ id: string }> {
    const session = await createSession({ title: 'goal', conversationId });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'build the parser', truncated: false, chars: 16 }
    });
    return session;
  }

  it('posts plain chat completions with no vendor fields and no key when keyless', async () => {
    await useCustom();
    const session = await userSession('c-custom-1');
    let sent: any = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return decision('continue', 'check the tokenizer first');
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-custom-1', turnId: 'g-1' });
    const view = await settled('c-custom-1');

    expect(view.stage).toBe('ready');
    expect(sent.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(sent.headers).not.toHaveProperty('authorization');
    expect(sent.headers).not.toHaveProperty('HTTP-Referer');
    expect(sent.headers).not.toHaveProperty('X-Title');
    expect(sent.body.model).toBe('llama3.1');
    // run() always streams to the panel consumer on this base; the bounded parse is unchanged.
    expect(sent.body.stream).toBe(true);
    expect(sent.body).not.toHaveProperty('plugins');
    expect(sent.body).not.toHaveProperty('provider');
    expect(sent.body).not.toHaveProperty('reasoning');
    expect(sent.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'goal_decision', strict: true }
    });
  });

  it('sends the custom key and the bare reasoning effort when both are configured', async () => {
    await useCustom({ reasoning: 'high' });
    await setSecret('customProviderApiKey', 'sk-custom-test');
    const session = await userSession('c-custom-2');
    let sent: any = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, headers: init.headers, body: JSON.parse(String(init.body)) };
      return decision('stop');
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-custom-2', turnId: 'g-1' });
    const view = await settled('c-custom-2');

    expect(view.stage).toBe('no-reply');
    expect((sent.headers as Record<string, string>).authorization).toBe('Bearer sk-custom-test');
    // `exclude` is OpenRouter vocabulary; a custom endpoint gets the effort alone.
    expect(sent.body.reasoning_effort).toBe('high');
    expect(sent.body).not.toHaveProperty('reasoning');
  });

  it('sends Anthropic Messages requests with Anthropic auth and normalizes its forced decision tool', async () => {
    await useCustom();
    const config = defaultConfig();
    await saveConfig({
      ...config,
      providers: { api: { kind: 'custom', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages' } },
      goal: { ...config.goal, enabled: true, backend: 'api', loopBackend: 'api', model: 'claude-test', reasoning: 'default' }
    });
    await setSecret('customProviderApiKey', 'anthropic-test-key');
    const session = await userSession('c-anthropic-1');
    const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return Response.json({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_decision', name: 'neuroflok_goal_decision', input: { action: 'continue', reply: 'inspect the parser' } }],
        stop_reason: 'tool_use'
      });
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-anthropic-1', turnId: 'g-1' });
    const view = await settled('c-anthropic-1');

    expect(view.stage).toBe('ready');
    expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent[0]?.headers).toMatchObject({ 'x-api-key': 'anthropic-test-key', 'anthropic-version': expect.any(String) });
    expect(sent[0]?.body.model).toBe('claude-test');
    expect(sent[0]?.body.tool_choice).toEqual({ type: 'tool', name: 'neuroflok_goal_decision' });
    expect(sent[0]?.body.tools[0].input_schema.required).toEqual(['action', 'reply']);
    expect(JSON.stringify(sent[0]?.body)).not.toContain('response_format');
  });

  it('fails settled on an invalid base URL instead of retrying forever', async () => {
    await useCustom();
    await saveConfig({
      ...defaultConfig(),
      providers: { api: { kind: 'custom', baseUrl: 'nota url' } },
      goal: {
        ...defaultConfig().goal,
        enabled: true,
        backend: 'api',
        model: 'llama3.1'
      }
    });
    const session = await userSession('c-custom-3');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return decision('continue', 'never reached');
    }) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-custom-3', turnId: 'g-1' });
    const view = await settled('c-custom-3');

    expect(view.stage).toBe('failed');
    expect(view.error).toMatch(/^invalid_provider/);
    expect(view.retryable).toBe(false);
    expect(calls).toBe(0);
  });

  it('keeps a reserved draft endpoint, credential, model and reasoning together after settings change', async () => {
    await useCustom({ reasoning: 'high' });
    await setSecret('customProviderApiKey', 'sk-custom-reserved');
    const session = await userSession('reserved-settings');
    const draft = goal.startGoalDraft({ sessionId: session.id, conversationId: 'reserved-settings', turnId: 'g-1', deferStart: true });
    await saveConfig({ ...defaultConfig(), goal: { ...defaultConfig().goal, enabled: true, backend: 'api', model: 'different-model', reasoning: 'low' } });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return decision('stop');
    }) as never;
    expect(goal.beginGoalDraft('reserved-settings', draft.token)).toBe(true);
    expect((await settled('reserved-settings')).stage).toBe('no-reply');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(requests[0]?.init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer sk-custom-reserved' } });
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({ model: 'llama3.1', reasoning_effort: 'high' });
  });

  it('keeps a planner endpoint, credential and model together across an awaited settings change', async () => {
    await useCustom();
    await setSecret('customProviderApiKey', 'sk-custom-snapshot');
    const secrets = await import('../../backend/infrastructure/settings/secrets.js');
    const readKey = secrets.getSecret;
    const lookup = vi.spyOn(secrets, 'getSecret').mockImplementationOnce(async key => {
      const value = await readKey(key);
      const changed = defaultConfig();
      await saveConfig({ ...changed, goal: { ...changed.goal, backend: 'api', model: 'different-model' }, providers: { api: { kind: 'custom', baseUrl: 'https://new-endpoint.example/v1' } } });
      return value;
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return decision('continue', JSON.stringify({ stages: ['Implement the parser', 'Verify the parser'] }));
    }) as never;
    try {
      expect(await goal.draftTaskPlan('Implement a parser', 'api')).toHaveLength(2);
      expect(lookup).toHaveBeenCalledWith('customProviderApiKey');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
      expect(requests[0]?.init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer sk-custom-snapshot' } });
      expect(JSON.parse(String(requests[0]?.init.body)).model).toBe('llama3.1');
    } finally { lookup.mockRestore(); }
  });

  it('reads a vanilla OpenAI model list, and an empty one when unreachable', async () => {
    await useCustom();
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toBe('http://localhost:11434/v1/models');
      return Response.json({ data: [{ id: 'llama3.1' }, { id: 'qwen3:8b', created: 1_700_000_000 }] });
    }) as never;
    const page = await goal.listGoalModels(0, 20);
    expect(page.models.map((model) => model.id).sort()).toEqual(['llama3.1', 'qwen3:8b']);
    expect(page.models.find((model) => model.id === 'llama3.1')?.name).toBe('llama3.1');

    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as never;
    // A different endpoint is a different cache scope, so this really exercises the failure path rather than the five-minute catalogue cache from the fetch above.
    await saveConfig({
      ...defaultConfig(),
      providers: { api: { kind: 'custom', baseUrl: 'http://localhost:11435/v1' } },
      goal: {
        ...defaultConfig().goal,
        enabled: true,
        model: 'llama3.1'
      }
    });
    const empty = await goal.listGoalModels(0, 20);
    expect(empty).toEqual({ models: [], total: 0 });
  });

  it('loads the Anthropic model catalog across cursor pages', async () => {
    const config = defaultConfig();
    await saveConfig({
      ...config,
      providers: { api: { kind: 'custom', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages' } },
      goal: { ...config.goal, enabled: true, backend: 'api', model: 'claude-a' }
    });
    await setSecret('customProviderApiKey', 'anthropic-catalog-test-key');
    resetGoalModelCatalogCache();
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      if (urls.length === 1) return Response.json({
        data: [{ id: 'claude-a', display_name: 'Claude A', max_input_tokens: 1000 }],
        has_more: true,
        last_id: 'claude-a'
      });
      return Response.json({
        data: [{ id: 'claude-b', display_name: 'Claude B', max_input_tokens: 2000 }],
        has_more: false,
        last_id: 'claude-b'
      });
    }) as never;

    const page = await goal.listGoalModels(0, 20);

    expect(urls).toEqual([
      'https://api.anthropic.com/v1/models?limit=1000',
      'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a'
    ]);
    expect(page.models.map(model => model.id).sort()).toEqual(['claude-a', 'claude-b']);
    expect(page.models.find(model => model.id === 'claude-a')).toMatchObject({ name: 'Claude A', contextLength: 1000 });
    resetGoalModelCatalogCache();
  });

  it('requires a key for OpenRouter but not for a custom endpoint', async () => {
    await saveConfig({
      ...defaultConfig(),
      providers: { api: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } },
      goal: {
        ...defaultConfig().goal,
        backend: 'api'
      }
    });
    await setSecret('openRouterApiKey', '');
    await setSecret('customProviderApiKey', '');
    expect(await goal.goalKeyPresent()).toBe(true);

    await saveConfig({
      ...defaultConfig(),
      goal: { ...defaultConfig().goal, backend: 'api' },
      providers: { api: { kind: 'openrouter', baseUrl: '' } }
    });
    expect(await goal.goalKeyPresent()).toBe(false);
    await setSecret('openRouterApiKey', 'sk-or-test');
    expect(await goal.goalKeyPresent()).toBe(true);
  });

  it('connects directly to OpenAI with its own key and model catalogue', async () => {
    await saveConfig({
      ...defaultConfig(),
      providers: { api: { kind: 'openai', baseUrl: '' } },
      goal: {
        ...defaultConfig().goal,
        backend: 'api',
        model: 'gpt-4.1'
      }
    });
    await setSecret('openRouterApiKey', '');
    await setSecret('openaiChatApiKey', '');
    expect(await goal.goalKeyPresent()).toBe(false);
    await setSecret('openaiChatApiKey', 'sk-proj-model-test');
    expect(await goal.goalKeyPresent()).toBe(true);
    expect(apiSettings.resolveApiBaseUrl({ kind: 'openai', baseUrl: '' })).toBe('https://api.openai.com/v1');

    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/models');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-proj-model-test');
      return Response.json({ data: [
        { id: 'gpt-4.1', created: 1_750_000_000 },
        { id: 'gpt-4.1-mini', created: 1_749_000_000 }
      ] });
    }) as never;
    const page = await goal.listGoalModels(0, 20, 'gpt-4.1');
    expect(page.models.map(model => model.id)).toEqual(['gpt-4.1', 'gpt-4.1-mini']);
  });

  it('accepts https and loopback http base URLs and refuses the rest', () => {
    const open = (baseUrl: string) => apiSettings.resolveApiBaseUrl({ kind: 'custom', baseUrl });
    expect(open('https://llm.example.com/v1/')).toBe('https://llm.example.com/v1');
    expect(open('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(open('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(open('http://[::1]:11434/v1')).toBe('http://[::1]:11434/v1');
    for (const bad of ['notaurl', '', 'http://llm.example.com/v1', 'https://user:pass@llm.example.com/v1', 'ftp://llm.example.com', 'https://llm.example/v1?secret=value', 'https://llm.example/v1#route']) {
      expect(() => open(bad), bad).toThrow(/^invalid_provider/);
    }
    expect(apiSettings.resolveApiBaseUrl({ kind: 'openrouter', baseUrl: '' })).toBe('https://openrouter.ai/api/v1');
  });

  it('builds configurable relative routes and custom authentication headers without exposing saved extras', async () => {
    await useCustom();
    const endpoint = {
      kind: 'custom' as const,
      baseUrl: 'http://localhost:11434/v1',
      name: 'Team gateway',
      chatPath: 'tenant/chat/completions',
      modelsPath: 'tenant/models',
      authHeader: 'x-api-key',
      authPrefix: ''
    };
    await setSecret('customProviderApiKey', 'synthetic-provider-key');
    await setSecret('customProviderHeaders', '{"x-tenant-id":"synthetic-team"}');
    expect(apiSettings.apiRequestUrl(endpoint, 'chat')).toBe('http://localhost:11434/v1/tenant/chat/completions');
    expect(apiSettings.apiRequestUrl(endpoint, 'models')).toBe('http://localhost:11434/v1/tenant/models');
    expect(apiSettings.apiRequestUrl({ ...endpoint, modelsPath: '' }, 'models')).toBeNull();
    const headers = await apiSettings.apiRequestHeaders(endpoint, 'synthetic-provider-key');
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'x-api-key': 'synthetic-provider-key',
      'x-tenant-id': 'synthetic-team'
    });
    expect(headers['x-tenant-id']).not.toContain('synthetic-provider-key');
    expect(() => apiSettings.apiRequestUrl({ ...endpoint, chatPath: 'https://evil.example/chat' }, 'chat')).toThrow(/relative path/i);
    await setSecret('customProviderHeaders', '');
  });
});
