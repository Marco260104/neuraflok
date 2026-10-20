import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: {
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'unknown',
  encryptStringAsync: async (value: string) => Buffer.from(value),
  decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
}, clipboard: {}, shell: {} }));

import { defaultConfig, initConfigPath, saveConfig } from '../backend/infrastructure/settings/config.js';
import { initDurableStore, flushDurable, resetDurableForTests } from '../backend/persistence/durable.js';
import {
  initSessionStore,
  getSession,
  readEvents,
  sessionWebProviderThreadPath,
  resetSessionStoreForTests
} from '../backend/domains/sessions/history/store.js';
import { enqueueInput, listInputs, resetInputForTests } from '../backend/domains/sessions/input/input.js';
import { flushRecorder } from '../backend/domains/sessions/history/recorder.js';
import { resetCorrelationRegistryForTests } from '../backend/domains/sessions/history/correlation.js';
import {
  abortWebProviderSession,
  configureBrowserChatForTests as configurePageForTests,
  resetBrowserChatForTests,
  runWebProviderInput,
  webProviderFlightTurnId
} from '../backend/domains/providers/browser-chat.js';
import {
  pendingProviderPage,
  reportProviderPageProgress,
  resetProviderPageForTests,
  requestProviderPageComplete,
  settleProviderPage
} from '../backend/domains/providers/provider-page.js';
import {
  WEB_CHAT_CORE_TOOLS,
  formatWebChatResult,
  incompleteWebChatTool,
  openaiToolParameters,
  parseWebChatTools,
  stripWebChatTools,
  usesBrowserProvider,
  usesApiProvider,
  webToolGuide
} from '../contracts/chat-protocol.js';
import { isWebProviderConversationId } from '../contracts/web-providers.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const TEST_PROVIDER_CONVERSATION = 'ds-00000000-0000-0000-0000-000000000001';

// Most executor tests focus on the task/tool loop after the separately tested setup exchange.
function configureDeepseekForTests(options: Parameters<typeof configurePageForTests>[0]): void {
  configurePageForTests({ complete: async (text, signal, pageOptions) => {
    if (pageOptions?.fresh) return { text: 'NEURAFLOK_READY' };
    return options.complete!(text, signal, pageOptions);
  } });
}

function runDeepseekInput(entry: Parameters<typeof runWebProviderInput>[0], signal?: AbortSignal): Promise<string | null> {
  return runWebProviderInput(entry, 'deepseek', signal);
}

it('does not advertise image reading when a browser session cannot pass image bytes to local tools', () => {
  expect(WEB_CHAT_CORE_TOOLS).not.toContain('view_image');
});

let directory: string;

beforeAll(async () => {
  directory = await makeTempDir('neuraflok-deepseek-');
  initConfigPath(directory);
  initDurableStore(directory);
  initSessionStore(directory);
  resetInputForTests();
  const config = defaultConfig();
  await saveConfig({
    ...config,
    roots: [{ name: 'workspace', path: directory }],
    ui: { ...config.ui, chatExecutor: 'web' }
  });
});

afterEach(async () => {
  resetBrowserChatForTests();
  resetCorrelationRegistryForTests();
  resetInputForTests();
  await flushRecorder();
});

afterAll(async () => {
  resetBrowserChatForTests();
  await flushRecorder();
  await flushDurable();
  resetInputForTests();
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(directory);
});

it('parses branded tool blocks, strips them from prose, and mints local conversation ids', () => {
  expect(openaiToolParameters({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] })).toEqual({
    type: 'object',
    properties: { patch: { type: 'string' } },
    required: ['patch']
  });
  const guide = webToolGuide([{ name: 'read', description: 'Read files', inputSchema: { $schema: 'x', type: 'object', properties: {} } }]);
  expect(guide).toContain('"name":"read"');
  expect(guide).toContain('```neuraflok-tool');
  expect(guide).toContain('Only these listed Core tools exist');
  expect(guide).toContain('"paths":["/workspace/example.txt"]');
  expect(guide).toContain('*** Begin Patch');
  expect(guide).toContain('read(');
  expect(guide).toContain('"name":"exec_command"');
  expect(guide).toContain('"cmd":"Get-ChildItem -Name"');
  expect(guide).toContain('"workdir":"/workspace"');
  expect(guide).toContain('Never put /workspace inside cmd');
  expect(guide).toContain('Do not pipe to head, wc, cat, or ls');
  expect(guide).toContain('Do not write PowerShell with $ in cmd');
  expect(guide).toContain('Do not run rg');
  expect(guide).toContain('On the user task, first output must be a complete neuraflok-tool fence');
  expect(guide).toContain('The handshake reply NEURAFLOK_READY is exempt');
  expect(guide).toContain('If the user asked a question, answer after tools with no fence');
  expect(guide).not.toContain('After listing a folder, the next reply must be apply_patch');
  expect(parseWebChatTools(guide).map(call => call.function.name)).toEqual(['read', 'exec_command', 'apply_patch']);
  expect(incompleteWebChatTool('```neuraflok-tool\n{"name":"read","arguments":{"paths":\n```')).toBe(true);
  expect(incompleteWebChatTool('```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}\n```')).toBe(false);
  expect(incompleteWebChatTool('```unbranded-tool\n{"name":"read","arguments":{"paths":\n```')).toBe(false);
  const rooted = webToolGuide(
    [{ name: 'read', description: 'Read files', inputSchema: { $schema: 'x', type: 'object', properties: {} } }],
    { roots: ['/c', '/skills'], project: '/c' }
  );
  expect(rooted).toContain('Approved roots: /c, /skills');
  expect(rooted).toContain('/c/hello.txt');
  expect(rooted).toContain('Selected project directory: /c');
  expect(rooted).toContain('"workdir":"/c"');
  expect(rooted).toContain('Never put /c inside cmd');
  expect(rooted).not.toContain('/workspace/hello.txt');
  const spanish = webToolGuide(
    [{ name: 'read', description: 'Read files', inputSchema: { $schema: 'x', type: 'object', properties: {} } }],
    { roots: ['/c'], project: '/c', language: 'es' }
  );
  expect(spanish).toContain('Reply in Spanish');
  const text = 'Working.\n```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}\n```\n';
  expect(parseWebChatTools(text)).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'read', arguments: '{"paths":["/workspace/a.txt"]}' }
  }]);
  expect(parseWebChatTools('```unbranded-tool\n{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}\n```')).toEqual([]);
  expect(parseWebChatTools('```json\n{"name":"apply_patch","arguments":{"patch":"x"}}\n```')).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'apply_patch', arguments: '{"patch":"x"}' }
  }]);
  expect(parseWebChatTools('<exec_command>\n{"cmd":"rg --files","workdir":"/commander"}\n</exec_command>')).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'exec_command', arguments: '{"cmd":"rg --files","workdir":"/commander"}' }
  }]);
  expect(incompleteWebChatTool('<exec_command>\n{"cmd":"rg --files"\n')).toBe(true);
  expect(incompleteWebChatTool('<exec_command>\n{"cmd":"rg --files","workdir":"/commander"}\n</exec_command>')).toBe(false);
  expect(stripWebChatTools(text)).toBe('Working.');
  expect(formatWebChatResult('read', 'ok')).toContain('neuraflok-result');
  expect(formatWebChatResult('read', 'ok')).toContain('neuraflok-result');
  expect(isWebProviderConversationId(`ds-${randomUUID()}`)).toBe(true);
  expect(isWebProviderConversationId(randomUUID())).toBe(false);
  expect(usesBrowserProvider('web')).toBe(true);
  expect(usesApiProvider('api')).toBe(true);
  expect(usesBrowserProvider(undefined)).toBe(false);
  expect(usesBrowserProvider(null)).toBe(false);
});

it('releases a page offer that outlived its wait so a later send can run', async () => {
  resetProviderPageForTests();
  vi.useFakeTimers();
  try {
    const first = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'hello');
    const rejected = expect(first).rejects.toThrow(/did not finish this reply in time/);
    await vi.advanceTimersByTimeAsync(601_000);
    await rejected;
    const second = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'again');
    const offer = pendingProviderPage();
    expect(offer?.text).toBe('again');
    expect(settleProviderPage({ id: offer!.id, provider: 'deepseek', conversationId: TEST_PROVIDER_CONVERSATION, text: 'ok' })).toBe(true);
    await expect(second).resolves.toEqual({ text: 'ok' });
  } finally {
    vi.useRealTimers();
    resetProviderPageForTests();
  }
});

it('refreshes the page wait while the provider is still generating', async () => {
  resetProviderPageForTests();
  vi.useFakeTimers();
  try {
    const pending = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'hello');
    await vi.advanceTimersByTimeAsync(500_000);
    const offer = pendingProviderPage();
    expect(reportProviderPageProgress({
      id: offer!.id, provider: 'deepseek', conversationId: TEST_PROVIDER_CONVERSATION, text: 'still working', generating: true
    })).toBe(true);
    await vi.advanceTimersByTimeAsync(500_000);
    expect(pendingProviderPage()?.id).toBe(offer!.id);
    expect(settleProviderPage({
      id: offer!.id, provider: 'deepseek', conversationId: TEST_PROVIDER_CONVERSATION, text: 'done'
    })).toBe(true);
    await expect(pending).resolves.toEqual({ text: 'done' });
  } finally {
    vi.useRealTimers();
    resetProviderPageForTests();
  }
});

it('settles a page wait that still carries the grown DeepSeek reply', async () => {
  resetProviderPageForTests();
  const pending = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'hello from the app');
  const offer = pendingProviderPage();
  expect(settleProviderPage({
    id: offer!.id,
    provider: 'deepseek',
    conversationId: TEST_PROVIDER_CONVERSATION,
    error: 'DeepSeek did not finish this reply in time. Sign in at chat.deepseek.com in the same browser as this app, then send again.',
    text: 'ArbolBinario.h and main.cpp are ready.'
  })).toBe(true);
  await expect(pending).resolves.toEqual({ text: 'ArbolBinario.h and main.cpp are ready.' });
});

it('publishes one page offer and settles it by id', async () => {
  resetProviderPageForTests();
  const pending = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'hello from the app');
  const offer = pendingProviderPage();
  expect(offer?.text).toBe('hello from the app');
  expect(offer?.provider).toBe('deepseek');
  expect(offer?.stop).toBe(false);
  expect(offer?.fresh).toBe(false);
  expect(settleProviderPage({ id: 'other', provider: 'deepseek', conversationId: TEST_PROVIDER_CONVERSATION, text: 'nope' })).toBe(false);
  expect(settleProviderPage({ id: offer!.id, provider: 'deepseek', conversationId: TEST_PROVIDER_CONVERSATION, text: 'reply from the page' })).toBe(true);
  await expect(pending).resolves.toEqual({ text: 'reply from the page' });
  expect(pendingProviderPage()).toBeNull();
});

it('publishes a fresh flag on an opening page offer', async () => {
  resetProviderPageForTests();
  const pending = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'hello from the app', undefined, { fresh: true });
  const offer = pendingProviderPage();
  expect(offer?.fresh).toBe(true);
  expect(settleProviderPage({ id: offer!.id, provider: 'deepseek', conversationId: TEST_PROVIDER_CONVERSATION, text: 'ok' })).toBe(true);
  await expect(pending).resolves.toEqual({ text: 'ok' });
});

it('stops only the exact active web-provider turn and marks its page offer', async () => {
  configureDeepseekForTests({ complete: async () => ({ text: 'First reply.' }) });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Open a provider session.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const conversationId = (await getSession(first.id))?.conversationId;
  expect(conversationId).toMatch(/^ds-/);
  resetBrowserChatForTests();

  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'Continue the provider session.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  const running = runDeepseekInput(second);
  await vi.waitFor(() => expect(pendingProviderPage()).not.toBeNull());
  const turnId = webProviderFlightTurnId(first.id);
  expect(turnId).toBeTruthy();
  expect(abortWebProviderSession(first.id, 'stale-turn')).toBe(false);
  expect(abortWebProviderSession(first.id, turnId!)).toBe(true);
  await expect(running).resolves.toBeNull();
  expect(pendingProviderPage()).toMatchObject({ stop: true, conversationId });
  await flushRecorder();
  expect((await readEvents(first.id)).some(event => event.kind === 'turn_end' && event.outcome === 'stopped')).toBe(true);
});

it('invokes real Core apply_patch from a mocked DeepSeek web turn and records the turn', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/hello.txt\n+hello from deepseek\n*** End Patch';
  const pages: string[] = [];
  let round = 0;
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      if (round++ === 0) {
        return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\`` };
      }
      return { text: 'Created /workspace/hello.txt.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Add hello.txt with that greeting.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  expect(await fs.readFile(path.join(directory, 'hello.txt'), 'utf8')).toBe('hello from deepseek\n');
  const row = (await listInputs()).find(entry => entry.id === input.id);
  expect(row?.state).toBe('sent');
  expect(row?.owner).toBeNull();
  expect(isWebProviderConversationId(row?.conversationId ?? '')).toBe(true);
  const session = await getSession(input.id);
  expect(session?.conversationId).toBe(row?.conversationId);
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'user_message')).toBe(true);
  expect(events.some(event => event.kind === 'turn_start')).toBe(true);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch')).toHaveLength(1);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('hello.txt'))).toBe(true);
  expect(events.some(event => event.kind === 'turn_end' && event.outcome === 'completed')).toBe(true);
  expect(pages[0]).not.toContain('Available tools');
  expect(pages[0]).toContain('apply_patch');
  expect(pages[0]).not.toContain('"name":"agents"');
  expect(pages[0]).not.toContain('"name":"session_finish"');
  expect(pages[0]).toContain('Add hello.txt with that greeting.');
  expect(pages[1]).toContain('neuraflok-result');
  expect(pages[1]).toContain('apply_patch');
  expect(pages[1]).toContain('Pasting source in the chat does not write files');
  const thread = JSON.parse(await fs.readFile(sessionWebProviderThreadPath(input.id, 'deepseek'), 'utf8')) as { messages: Array<{ role: string }> };
  expect(thread.messages[0]?.role).toBe('system');
  expect(thread.messages.some(message => message.role === 'tool')).toBe(true);
});

it('retries an incomplete branded tool fence and then apply_patch writes the file', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/after-repair.txt\n+repaired\n*** End Patch';
  const pages: string[] = [];
  let round = 0;
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      const n = round++;
      if (n === 0) return { text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":\n```' };
      if (n === 1) return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\`` };
      return { text: 'Created after-repair.txt.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Write after-repair.txt', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  expect(pages[1]).toContain('INCOMPLETE_TOOL');
  expect(await fs.readFile(path.join(directory, 'after-repair.txt'), 'utf8')).toBe('repaired\n');
});

it('invokes apply_patch from a DeepSeek tool banner without backticks', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/from-banner.txt\n+banner\n*** End Patch';
  let round = 0;
  configureDeepseekForTests({
    complete: async () => {
      if (round++ === 0) {
        return { text: `neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n` };
      }
      return { text: 'Created from-banner.txt.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Write from-banner.txt', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  expect(await fs.readFile(path.join(directory, 'from-banner.txt'), 'utf8')).toBe('banner\n');
});

it('sends only new user text on a follow-up because the DeepSeek page keeps history', async () => {
  const pages: string[] = [];
  const fresh: boolean[] = [];
  configureDeepseekForTests({
    complete: async (text, _signal, options) => {
      pages.push(text);
      fresh.push(options?.fresh === true);
      return { text: 'noted' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'first job', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'second job', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  expect(pages[0]).not.toContain('Available tools');
  expect(pages[0]).toContain('first job');
  expect(pages[1]).toContain('second job');
  expect(pages[1]).toContain('apply_patch');
  expect(pages[1]).not.toContain('Available tools');
  expect(fresh).toEqual([false, false]);
});

it('sends setup once, waits for its acknowledgement, then sends authored messages separately', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  let acknowledge!: (value: { text: string }) => void;
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return new Promise(resolve => { acknowledge = resolve; });
    return { text: 'Task received.' };
  } });
  const first = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'MY_ACTUAL_REQUEST', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  const running = runDeepseekInput(first);
  await vi.waitFor(() => expect(pages).toHaveLength(1));
  expect(pages[0]!.fresh).toBe(true);
  expect(pages[0]!.text).toContain('Available tools');
  expect(pages[0]!.text).toContain('Do not run tools or execute examples');
  expect(pages[0]!.text).not.toContain('MY_ACTUAL_REQUEST');
  acknowledge({ text: 'NEURAFLOK_READY' });
  await running;
  expect(pages[1]).toMatchObject({ fresh: false, text: expect.stringContaining('MY_ACTUAL_REQUEST') });
  expect(pages[1]!.text).toContain('WORKSPACE_CONTEXT');
  const second = await enqueueInput({ id: randomUUID(), sessionId: first.id, text: 'MY_FOLLOWUP', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  await runDeepseekInput(second);
  expect(pages).toHaveLength(3);
  expect(pages[2]).toMatchObject({ fresh: false, text: expect.stringContaining('MY_FOLLOWUP') });
  expect(pages[2]!.text).not.toContain('Available tools');
});

it('does not execute tool examples or send the user task when setup is not acknowledged', async () => {
  const complete = vi.fn(async () => ({ text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace"]}}\n```' }));
  configurePageForTests({ complete });
  const entry = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Do my task', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  expect(await runDeepseekInput(entry)).toBeNull();
  expect(complete).toHaveBeenCalledTimes(1);
  await flushRecorder();
  const events = await readEvents(entry.id);
  expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(0);
  expect(events.some(event => event.kind === 'chat_error')).toBe(true);
});

it('records a simple greeting reply without calling a Core tool', async () => {
  configureDeepseekForTests({
    complete: async (text) => {
      expect(text).toContain('Hola');
      return { text: 'Hola. Estoy listo.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Hola', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  const row = (await listInputs()).find(entry => entry.id === input.id);
  expect(row?.state).toBe('sent');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'user_message' && event.message.text === 'Hola')).toBe(true);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'Hola. Estoy listo.')).toBe(true);
  expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(0);
});

it('records a chat_error after accept when the page refuses, without replaying the send', async () => {
  configureDeepseekForTests({
    complete: async () => {
      throw new Error('Sign in to DeepSeek at chat.deepseek.com in the same browser as this app, then send again.');
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'hello', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  const row = (await listInputs()).find(entry => entry.id === input.id);
  expect(row?.state).toBe('sent');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'chat_error' && event.message.text.includes('Sign in to DeepSeek'))).toBe(true);
  expect(events.some(event => event.kind === 'turn_end' && event.outcome === 'failed')).toBe(true);
});

it('returns unknown-tool text to the model instead of invoking a non-allowlisted name', async () => {
  const pages: string[] = [];
  let round = 0;
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      if (round++ === 0) {
        return { text: '```neuraflok-tool\n{"name":"unsupported_local_tool","arguments":{}}\n```' };
      }
      return { text: 'I will stay on Core tools.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'spawn a worker', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  expect(pages[1]).toContain('UNKNOWN_TOOL');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(0);
});

it('delivers a queued message to nextAfterTurnLocalInput after the initial turn completes', async () => {
  let input2: Awaited<ReturnType<typeof enqueueInput>>;
  let owner = '';
  configureDeepseekForTests({
    complete: async () => {
      input2 = await enqueueInput({ id: randomUUID(), sessionId: owner, text: 'Follow-up queued message', mode: 'after-turn', dueAt: 0, model: null, reasoningEffort: null });
      return { text: 'First response from DeepSeek' };
    }
  });
  const input1 = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Initial prompt with project', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  owner = input1.id;
  const completedTurnId = await runDeepseekInput(input1);
  expect(completedTurnId).toBeTruthy();

  const session = await getSession(input1.id);
  expect(session?.conversationId).toBeTruthy();

  const { nextAfterTurnLocalInput } = await import('../backend/domains/sessions/input/input.js');
  const next = await nextAfterTurnLocalInput(input1.id, session!.conversationId!, completedTurnId!);
  expect(next).not.toBeNull();
  expect(next?.id).toBe(input2!.id);
  expect(next?.text).toBe('Follow-up queued message');
});

it('retains a second message during an exact local opening reservation, before provider binding', async () => {
  const first = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'First task', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null }, undefined, 'deepseek');
  const followup = { id: randomUUID(), sessionId: first.sessionId, text: 'Second task', mode: 'after-turn' as const,
    dueAt: 0, model: null, reasoningEffort: null };
  await expect(enqueueInput(followup, undefined, 'api')).rejects.toThrow(/no provider conversation/);
  const second = await enqueueInput(followup, undefined, 'deepseek');
  expect(second).toMatchObject({ state: 'queued', conversationId: null, sessionId: first.sessionId });
  configureDeepseekForTests({ complete: async () => ({ text: 'Finished first task.' }) });
  const turnId = await runDeepseekInput(first);
  const session = (await getSession(first.sessionId!))!;
  const { nextAfterTurnLocalInput } = await import('../backend/domains/sessions/input/input.js');
  expect(await nextAfterTurnLocalInput(session.id, session.conversationId!, turnId!)).toMatchObject({ id: second.id });
});
