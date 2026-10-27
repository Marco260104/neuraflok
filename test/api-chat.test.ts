import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('electron', () => ({ safeStorage: {
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'unknown',
  encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
}, clipboard: {}, shell: {} }));

import { defaultConfig, initConfigPath, saveConfig } from '../backend/infrastructure/settings/config.js';
import { initSecretsPath, setSecret } from '../backend/infrastructure/settings/secrets.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../backend/persistence/durable.js';
import { initSessionStore, getSession, readEvents, sessionApiThreadPath, resetSessionStoreForTests } from '../backend/domains/sessions/history/store.js';
import { recordedInputImage } from '../backend/domains/sessions/input/input-history.js';
import { enqueueInput, listInputs, resetInputForTests } from '../backend/domains/sessions/input/input.js';
import { stageInputAttachment } from '../backend/domains/sessions/input/attachments/index.js';
import { flushRecorder } from '../backend/domains/sessions/history/recorder.js';
import { resetCorrelationRegistryForTests } from '../backend/domains/sessions/history/correlation.js';
import { isApiConversationId } from '../contracts/chat-protocol.js';
import { trimApiThread } from '../backend/domains/providers/api-chat-thread-store.js';
import type { ApiMessage } from '../backend/domains/providers/api-chat-protocol.js';
import { abortApiChatSession, apiChatFlightTurnId, resetApiChatForTests, runApiProviderInput } from '../backend/domains/providers/api-chat.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let directory: string;

it('keeps the active API request and complete recent tool rounds when long runs need thread compaction', () => {
  const messages: ApiMessage[] = [
    { role: 'system', content: 'workspace instructions' },
    { role: 'user', content: 'Finish the requested project change.' }
  ];
  for (let round = 0; round < 70; round++) {
    const id = `call_${round}`;
    messages.push({ role: 'assistant', content: null, tool_calls: [{
      id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: [`/workspace/file-${round}.ts`] }) }
    }] });
    messages.push({ role: 'tool', tool_call_id: id, content: `result ${round}` });
  }
  const compacted = trimApiThread(messages);
  expect(compacted.length).toBeLessThanOrEqual(120);
  expect(compacted[0]).toMatchObject({ role: 'system' });
  expect(compacted.some(row => row.role === 'user' && row.content === 'Finish the requested project change.')).toBe(true);
  expect(compacted.some(row => typeof row.content === 'string' && row.content.includes('Earlier tool results were omitted'))).toBe(true);
  for (let index = 0; index < compacted.length; index++) {
    const row = compacted[index];
    if (!row || row.role !== 'tool') continue;
    expect(compacted.slice(0, index).some(previous => previous.role === 'assistant' &&
      previous.tool_calls?.some(call => call.id === row.tool_call_id))).toBe(true);
  }
});

beforeAll(async () => {
  directory = await makeTempDir('neuraflok-api-chat-');
  initConfigPath(directory);
  initSecretsPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  resetInputForTests();
  const config = defaultConfig();
  await saveConfig({
    ...config,
    roots: [{ name: 'workspace', path: directory }],
    ui: { ...config.ui, chatExecutor: 'api' },
    providers: { api: { kind: 'custom', baseUrl: 'http://localhost:1234/v1' } },
    goal: { ...config.goal, model: 'mock-model' }
  });
});

afterEach(async () => {
  resetApiChatForTests();
  resetCorrelationRegistryForTests();
  resetInputForTests();
  await flushRecorder();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  resetApiChatForTests();
  await flushRecorder();
  await flushDurable();
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('uses structured API tool calls, carries project files as bounded text context, and records a local session', async () => {
  await fs.writeFile(path.join(directory, 'hello.txt'), 'hello from the workspace\n', 'utf8');
  const attachment = await stageInputAttachment({ name: 'notes.md', bytes: Buffer.from('Treat the sample as UTF-8 text.') }, new Set());
  const bodies: Array<{ model: string; messages: Array<{ role: string; content?: string | null | Array<unknown> }>; tools?: unknown[] }> = [];
  const replies = [
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{
      id: 'call_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: ['/workspace/hello.txt'] }) }
    }] } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'The file says hello from the workspace.' } }] }
  ];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
    return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Read the greeting and summarize it.', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null, attachments: [attachment]
  });

  await runApiProviderInput(input);

  expect(isApiConversationId((await getSession(input.id))?.conversationId ?? '')).toBe(true);
  expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('sent');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]?.model).toBe('mock-model');
  expect(bodies[0]?.tools?.some(tool => JSON.stringify(tool).includes('read'))).toBe(true);
  expect(bodies[0]?.messages.at(-1)?.content).toContain('Treat the sample as UTF-8 text.');
  expect(bodies[1]?.messages.some(message => message.role === 'tool' && message.content?.includes('hello from the workspace'))).toBe(true);
  expect(JSON.parse(await fs.readFile(sessionApiThreadPath(input.id), 'utf8')).messages.some((row: { role: string }) => row.role === 'tool')).toBe(true);
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'user_message' && event.message.text === 'Read the greeting and summarize it.')).toBe(true);
  expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'read')).toBe(true);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('The file says hello'))).toBe(true);
  expect(events.some(event => event.kind === 'turn_end' && event.outcome === 'completed')).toBe(true);
});

it('continues an older API chat from the recorded history summary when its provider thread is unavailable', async () => {
  const bodies: Array<{ messages: Array<{ role: string; content?: string | null | Array<unknown> }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
    const content = bodies.length === 1
      ? 'I recorded the project marker NF_API_HISTORY_42.'
      : 'I continued from the recorded marker.';
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
  }));
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Remember marker NF_API_HISTORY_42 for the next step.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runApiProviderInput(first);
  await flushRecorder();
  await fs.rm(sessionApiThreadPath(first.id), { force: true });

  const followup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'Continue using the earlier marker.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runApiProviderInput(followup);

  const current = String(bodies[1]?.messages.at(-1)?.content ?? '');
  expect(current).toContain('RECENT CONVERSATION SUMMARY');
  expect(current).toContain('NF_API_HISTORY_42');
  expect(current).toContain('Default workspace folder for ordinary chats');
  expect(current).not.toContain('PROJECT FILE TREE');
  expect(bodies[1]?.messages.some(message => String(message.content ?? '').includes('Remember marker NF_API_HISTORY_42'))).toBe(true);
});

it('stops the exact API generation through its request signal', async () => {
  let signal: AbortSignal | null | undefined;
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url));
    signal = init?.signal;
    if (!signal) throw new Error('The API request did not include its cancellation signal.');
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  }));
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Stop this API request.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  const running = runApiProviderInput(input);
  await vi.waitFor(() => expect(signal).toBeDefined());
  const turnId = apiChatFlightTurnId(input.id);
  expect(turnId).toBeTruthy();
  expect(abortApiChatSession(input.id, 'stale-turn')).toBe(false);
  expect(abortApiChatSession(input.id, turnId!)).toBe(true);
  await expect(running).resolves.toBeNull();
  expect(signal?.aborted).toBe(true);
  expect(urls).toEqual(['http://localhost:1234/v1/chat/completions']);
  await flushRecorder();
  expect((await readEvents(input.id)).some(event => event.kind === 'turn_end' && event.outcome === 'stopped')).toBe(true);
});

it('records provider failures after local acceptance without replaying the user message', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'temporary provider failure' } }), {
    status: 503, headers: { 'content-type': 'application/json' }
  })));
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Please answer.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runApiProviderInput(input);
  expect((await listInputs()).find(row => row.id === input.id)?.state).toBe('sent');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'chat_error' && event.message.text.includes('temporary provider failure'))).toBe(true);
  expect(events.some(event => event.kind === 'turn_end' && event.outcome === 'failed')).toBe(true);
});

it('rejects duplicate API tool-call ids before any local tool is invoked', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [
      { id: 'duplicate', type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: ['/workspace/hello.txt'] }) } },
      { id: 'duplicate', type: 'function', function: { name: 'read', arguments: JSON.stringify({ paths: ['/workspace/hello.txt'] }) } }
    ]
  } }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Read the file.', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null
  });

  await runApiProviderInput(input);

  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'read')).toBe(false);
  expect(events.some(event => event.kind === 'chat_error' && event.message.text.includes('duplicate tool call ids'))).toBe(true);
  expect(events.filter(event => event.kind === 'user_message')).toHaveLength(1);
});

it('records the exact image payload in the local conversation history', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#88aacc' } }).webp().toBuffer();
  const dataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
  const bodies: Array<{ messages: Array<{ content?: string | null | Array<unknown> }> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'I can see the sample.' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }));
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Describe this image.', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null, images: [{ name: 'sample.webp', dataUrl }]
  });

  await runApiProviderInput(input);

  expect(JSON.stringify(bodies[0]?.messages.at(-1)?.content)).toContain('image_url');
  await flushRecorder();
  const userMessage = (await readEvents(input.id)).find(event => event.kind === 'user_message');
  expect(userMessage?.kind).toBe('user_message');
  if (userMessage?.kind !== 'user_message') throw new Error('API user image was not recorded');
  expect(userMessage.assets).toHaveLength(1);
  expect(await recordedInputImage(input.id, userMessage.assets![0]!.id)).toBe(dataUrl);
});

it('sends a selected OpenAI model to its direct chat-completions endpoint', async () => {
  const config = defaultConfig();
  await saveConfig({
    ...config,
    ui: { ...config.ui, chatExecutor: 'api' },
    providers: { api: { kind: 'openai', baseUrl: '' } },
    goal: { ...config.goal, model: 'gpt-4.1-mini' }
  });
  await setSecret('openaiChatApiKey', 'sk-proj-direct-test');
  const requests: Array<{ url: string; auth: string; model: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      auth: new Headers(init?.headers).get('authorization') ?? '',
      model: (JSON.parse(String(init?.body)) as { model: string }).model
    });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ready.' } }] });
  }));
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Say ready.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runApiProviderInput(input);
  expect(requests[0]).toEqual({ url: 'https://api.openai.com/v1/chat/completions', auth: 'Bearer sk-proj-direct-test', model: 'gpt-4.1-mini' });
  expect(await getSession(input.id)).toMatchObject({ selectedModel: { model: 'gpt-4.1-mini', apiProvider: { kind: 'openai' } } });

  const nextConfig = defaultConfig();
  await saveConfig({
    ...nextConfig,
    ui: { ...nextConfig.ui, chatExecutor: 'api' },
    providers: { api: { kind: 'custom', baseUrl: 'http://localhost:1234/v1' } },
    goal: { ...nextConfig.goal, model: 'changed-model' }
  });
  const followUp = await enqueueInput({
    id: randomUUID(), sessionId: input.id, text: 'Continue with the same model.', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null
  });
  await runApiProviderInput(followUp);
  expect(requests[1]).toEqual(requests[0]);
});
