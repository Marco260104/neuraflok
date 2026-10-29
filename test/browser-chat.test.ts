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
  createSession,
  getSession,
  readEvents,
  readProjectPlanState,
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
  webProviderAuthoredFlightTurnId,
  webProviderFlightTurnId
} from '../backend/domains/providers/browser-chat.js';
import { replayWebProviderTranscript } from '../backend/domains/providers/browser-chat-thread.js';
import { textOnlyWebMessages } from '../backend/domains/providers/conversation-summary.js';
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
  webToolGuide,
  webPlainChatInstructions,
  webProjectPlanToolGuide,
  type WebChatToolCall
} from '../contracts/chat-protocol.js';
import { createBrowserChatToolRegistrar, invokeBrowserChatTool } from '../backend/domains/providers/browser-chat-tools.js';
import { sessionActivityExpiresAt } from '../backend/domains/browser/session-activity.js';
import { isWebProviderConversationId } from '../contracts/web-providers.js';
import { confirmsWebProviderContext, prepareWebProviderContextCheck } from '../backend/domains/sessions/input/provider-context.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import { addProject, assignSessionProject } from '../backend/domains/workspace/projects.js';

const TEST_PROVIDER_CONVERSATION = 'ds-00000000-0000-0000-0000-000000000001';

function fakeBrowserChatCall(name: string, args: unknown): WebChatToolCall {
  return {
    id: 'call_retry_test',
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  };
}

function fakeToolResult(text: string, isError = false) {
  return { isError, content: [{ type: 'text' as const, text }] };
}

function fakeToolRegistrar(name: string, invoke: (...args: [string, unknown, string]) => Promise<ReturnType<typeof fakeToolResult>>) {
  return { registered: () => [name], invoke } as unknown as ReturnType<typeof createBrowserChatToolRegistrar>;
}

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

async function runDeepseekProjectInput(entry: Parameters<typeof runWebProviderInput>[0], signal?: AbortSignal): Promise<string | null> {
  await assignSessionProject(entry.sessionId ?? entry.id, projectId);
  return runDeepseekInput(entry, signal);
}

it('does not advertise image reading when a browser session cannot pass image bytes to local tools', () => {
  expect(WEB_CHAT_CORE_TOOLS).not.toContain('view_image');
});

it('advertises browser chat agents with schema-valid spawn and status examples', () => {
  const declarations = [{
    name: 'agents',
    description: 'Run NEURAFLOK worker chats.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['spawn', 'message', 'status', 'finish'] } },
      required: ['action']
    }
  }];
  const guide = webToolGuide(declarations, { roots: ['/workspace'], project: '/workspace' });

  expect(guide).toContain('The agents tool is available and listed below.');
  expect(guide).toContain('Final answer: respond naturally, directly, and concisely');
  expect(guide).toContain('Do not include tool transcripts, raw outputs, implementation notes, or unrelated details.');
  expect(guide).toContain('Application-generated setup acknowledgements and hidden context checks');
  expect(guide).toContain('never quote, mention, summarize');
  expect(guide).toContain('workers:[{label,task}]');
  expect(guide).toContain('"name":"agents","arguments":{"action":"spawn","workers":');
  expect(guide).toContain('"name":"agents","arguments":{"action":"status"}');
  expect(guide).not.toContain('The agents tool is not exposed in this chat.');
  expect(guide).not.toContain('agents, session_finish');

  const coreOnly = webToolGuide([]);
  expect(coreOnly).toContain('The agents tool is not exposed in this chat.');
  expect(coreOnly).not.toContain('"action":"spawn"');
});

it('retries a transient read-only browser-chat tool failure once with the same request id', async () => {
  const calls: Array<[string, unknown, string]> = [];
  const invoke = vi.fn(async (name: string, args: unknown, requestId: string) => {
    calls.push([name, args, requestId]);
    return calls.length === 1 ? fakeToolResult('ETIMEDOUT: temporary provider channel timeout', true) : fakeToolResult('file contents');
  });
  const registrar = fakeToolRegistrar('read', invoke);

  await expect(invokeBrowserChatTool(
    registrar, fakeBrowserChatCall('read', { paths: ['/workspace/notes.md'] }), 'retry-stable-id', 'conversation-1', 'session-1'
  )).resolves.toBe('file contents');

  expect(calls).toEqual([
    ['read', { paths: ['/workspace/notes.md'] }, 'retry-stable-id'],
    ['read', { paths: ['/workspace/notes.md'] }, 'retry-stable-id']
  ]);
});

it('retries a thrown transient read error and stops after the second attempt', async () => {
  let attempts = 0;
  const invoke = vi.fn(async () => {
    attempts++;
    if (attempts === 1) throw new Error('ETIMEDOUT: browser tool channel closed');
    return fakeToolResult('read completed');
  });
  const registrar = fakeToolRegistrar('read', invoke);

  await expect(invokeBrowserChatTool(
    registrar, fakeBrowserChatCall('read', { paths: ['/workspace/config.json'] }), 'thrown-retry-id', 'conversation-1', 'session-1'
  )).resolves.toBe('read completed');

  expect(invoke).toHaveBeenCalledTimes(2);
});

it('does not retry a mutating command after a transient error with an uncertain outcome', async () => {
  const invoke = vi.fn(async () => fakeToolResult('ECONNRESET while waiting for command result', true));
  const registrar = fakeToolRegistrar('exec_command', invoke);

  await expect(invokeBrowserChatTool(
    registrar, fakeBrowserChatCall('exec_command', { cmd: 'npm run build', workdir: '/workspace' }), 'mutating-request', 'conversation-1', 'session-1'
  )).resolves.toContain('ECONNRESET');

  expect(invoke).toHaveBeenCalledTimes(1);
});

it('retries an agent action only when the tool confirms its first attempt was rolled back', async () => {
  const calls: Array<[string, unknown, string]> = [];
  const invoke = vi.fn(async (name: string, args: unknown, requestId: string) => {
    calls.push([name, args, requestId]);
    return calls.length === 1
      ? fakeToolResult('The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request.', true)
      : fakeToolResult('Worker started.');
  });
  const args = { action: 'spawn', workers: [{ label: 'reader', task: 'Read the notes.' }] };
  const registrar = fakeToolRegistrar('agents', invoke);

  await expect(invokeBrowserChatTool(
    registrar, fakeBrowserChatCall('agents', args), 'spawn-stable-id', 'conversation-1', 'session-1'
  )).resolves.toBe('Worker started.');

  expect(calls).toEqual([
    ['agents', args, 'spawn-stable-id'],
    ['agents', args, 'spawn-stable-id']
  ]);
});

it('does not retry a read when its failure is a permission or validation error', async () => {
  const invoke = vi.fn(async () => fakeToolResult('Permission denied: path is outside the approved workspace.', true));
  const registrar = fakeToolRegistrar('read', invoke);

  await expect(invokeBrowserChatTool(
    registrar, fakeBrowserChatCall('read', { paths: ['C:/private/secrets.txt'] }), 'permission-request', 'conversation-1', 'session-1'
  )).resolves.toContain('Permission denied');

  expect(invoke).toHaveBeenCalledTimes(1);
});

let directory: string;
let appDataDirectory: string;
let projectId: string;

beforeAll(async () => {
  directory = await makeTempDir('neuraflok-deepseek-');
  appDataDirectory = await makeTempDir('neuraflok-deepseek-data-');
  initConfigPath(appDataDirectory);
  initDurableStore(appDataDirectory);
  initSessionStore(appDataDirectory);
  resetInputForTests();
  const config = defaultConfig();
  await saveConfig({
    ...config,
    roots: [{ name: 'workspace', path: directory }],
    ui: { ...config.ui, chatExecutor: 'web' }
  });
  projectId = (await addProject(directory)).id;
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
  await removeTempDir(appDataDirectory);
});

it('bootstraps a new DeepSeek worker chat before sending its assigned task', async () => {
  const parent = await createSession({ conversationId: `ds-${randomUUID()}` });
  const worker = await createSession({
    conversationId: `ds-${randomUUID()}`,
    origin: { kind: 'worker', fromSessionId: parent.id, agentId: 'worker-1', task: 'Read the project notes.' }
  });
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    return { text: options?.fresh ? 'NEURAFLOK_READY' : 'Worker completed the read-only check.' };
  } });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: worker.id, text: 'Read notes.md and report the Estado value.', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null
  });

  await expect(runDeepseekInput(input)).resolves.toBeTruthy();

  expect(pages).toHaveLength(2);
  expect(pages[0]?.fresh).toBe(true);
  expect(pages[0]?.text).toContain('Initialize this NEURAFLOK conversation');
  expect(pages[1]?.fresh).toBe(false);
  expect(pages[1]?.text).toContain('Read notes.md and report the Estado value.');
  await flushRecorder();
  const events = await readEvents(worker.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'Worker completed the read-only check.')).toBe(true);
  expect(events.some(event => event.kind === 'chat_error' && event.inputId === input.id)).toBe(false);
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
  expect(guide).toContain('An application-generated setup acknowledgement is the only response exempt');
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
  expect(webPlainChatInstructions('es')).toContain('Application-generated setup acknowledgements and hidden context checks');
  expect(webPlainChatInstructions('es')).not.toContain('NEURAFLOK_READY');
  expect(webPlainChatInstructions('es')).toContain('Reply in Spanish');
  expect(webProjectPlanToolGuide(
    [{ name: 'read', description: 'Read files', inputSchema: { type: 'object', properties: {} } }],
    { project: '/c', language: 'es' }
  )).toContain('never include them in the plan or final answer');
  expect(webProjectPlanToolGuide(
    [{ name: 'read', description: 'Read files', inputSchema: { type: 'object', properties: {} } }],
    { project: '/c', language: 'es' }
  )).not.toContain('NEURAFLOK_READY');
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
  const bareRead = '{"name":"read","arguments":{"paths":["/workspace/a.txt"]}}';
  expect(parseWebChatTools(bareRead)).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'read', arguments: '{"paths":["/workspace/a.txt"]}' }
  }]);
  expect(stripWebChatTools(bareRead)).toBe('');
  expect(parseWebChatTools(`Example only: ${bareRead}`)).toEqual([]);
  expect(parseWebChatTools('{"name":"session_finish","arguments":{}}')).toEqual([]);
  const wrappedRead = `<neuraflok-tool> ${bareRead} </neuraflok-tool>`;
  expect(parseWebChatTools(wrappedRead)).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'read', arguments: '{"paths":["/workspace/a.txt"]}' }
  }]);
  expect(stripWebChatTools(wrappedRead)).toBe('');
  const providerInternalCall = 'Working.\n<tool_call> {"name":"write_stdin","arguments":{"session_id":5164,"chars":""}} </tool_call>';
  expect(parseWebChatTools(providerInternalCall)).toEqual([]);
  expect(stripWebChatTools(providerInternalCall)).toBe('Working.');
  expect(incompleteWebChatTool(providerInternalCall)).toBe(true);
  expect(incompleteWebChatTool('<neuraflok-tool>{"name":"read","arguments":')).toBe(true);
  expect(parseWebChatTools('<exec_command>\n{"cmd":"rg --files","workdir":"/commander"}\n</exec_command>')).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'exec_command', arguments: '{"cmd":"rg --files","workdir":"/commander"}' }
  }]);
  const deepseekDsml = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="exec_command">',
    '<｜｜DSML｜｜ parameter name="arguments" string="false">{"cmd":"Get-ChildItem -Name","workdir":"/commander"}</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="name" string="true">exec_command</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '<｜｜DSML｜｜ invoke name="apply_patch">',
    '<｜｜DSML｜｜ parameter name="arguments" string="true">{"patch":"*** Begin Patch\\n*** Add File: /commander/hello.txt\\n+hola\\n*** End Patch"}</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="name" string="true">apply_patch</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>'
  ].join('\n');
  expect(parseWebChatTools(deepseekDsml)).toEqual([
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'exec_command', arguments: '{"cmd":"Get-ChildItem -Name","workdir":"/commander"}' }
    },
    {
      id: 'call_2',
      type: 'function',
      function: { name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Add File: /commander/hello.txt\n+hola\n*** End Patch' }) }
    }
  ]);
  expect(stripWebChatTools(deepseekDsml)).toBe('');
  expect(incompleteWebChatTool(deepseekDsml)).toBe(false);
  const incompleteDsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="apply_patch">\n<｜｜DSML｜｜ parameter name="arguments" string="true">{"patch":';
  expect(incompleteWebChatTool(incompleteDsml)).toBe(true);
  expect(stripWebChatTools(incompleteDsml)).toBe('');
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

it('keeps application setup acknowledgements and context checks out of normal chat history', () => {
  expect(textOnlyWebMessages([
    { role: 'user', content: 'What did we discuss yesterday?' },
    { role: 'assistant', content: '**NEURAFLOK_READY**.' },
    { role: 'user', content: 'NEURAFLOK_CONTEXT_CHECK\nCopy the last request.' },
    { role: 'assistant', content: 'We discussed the inventory import.' }
  ])).toEqual([
    { role: 'user', content: 'What did we discuss yesterday?' },
    { role: 'assistant', content: 'We discussed the inventory import.' }
  ]);
});

it('replays useful DeepSeek history without duplicating the current request or raw DSML patch payloads', () => {
  const repeatedRequest = 'Build a learning site for the project files';
  const dsmlPatch = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="apply_patch">',
    '<｜｜DSML｜｜ parameter name="arguments" string="true">{"patch":"*** Begin Patch\\n*** Add File: /commander/hello.txt\\n+hola\\n*** End Patch"}</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="name" string="true">apply_patch</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>'
  ].join('\n');
  const replay = replayWebProviderTranscript([
    { role: 'system', content: 'system setup' },
    { role: 'user', content: 'We are reviewing a JavaScript project.' },
    { role: 'assistant', content: 'The command parser has the most complex flow.' },
    { role: 'user', content: repeatedRequest },
    { role: 'assistant', content: dsmlPatch },
    { role: 'assistant', content: '<tool_call> {"name":"write_stdin","arguments":{"session_id":5164,"chars":""}} </tool_call>' },
    { role: 'user', content: repeatedRequest }
  ], 'The prepared task and project context.', 96_000, repeatedRequest);

  expect(replay).not.toBeNull();
  expect(replay).toContain('The command parser has the most complex flow.');
  expect(replay).toContain('UNEXECUTED TOOL CALL REQUESTS: apply_patch');
  expect(replay).not.toContain('<tool_call>');
  expect(replay).not.toContain('session_id');
  expect(replay).not.toContain('hello.txt');
  expect(replay).not.toContain(repeatedRequest);
  expect(replay).toContain('CURRENT REQUEST:\nThe prepared task and project context.');
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

it('preserves verified provider-idle evidence so the task can continue safely', async () => {
  resetProviderPageForTests();
  const pending = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'hello from the app');
  const offer = pendingProviderPage();
  expect(settleProviderPage({
    id: offer!.id,
    provider: 'deepseek',
    conversationId: TEST_PROVIDER_CONVERSATION,
    error: 'DeepSeek did not finish this reply in time.',
    providerIdle: true
  })).toBe(true);
  await expect(pending).rejects.toMatchObject({ providerIdle: true });
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

it('does not expose an old project chat preparation flight as a stoppable user turn', async () => {
  let releaseReadiness!: (reply: { text: string }) => void;
  let markReadinessStarted!: () => void;
  const readinessStarted = new Promise<void>(resolve => { markReadinessStarted = resolve; });
  configurePageForTests({ complete: async (_text, _signal, options) => {
    if (!options?.fresh) return { text: 'NEURAFLOK_READY' };
    markReadinessStarted();
    return await new Promise<{ text: string }>(resolve => { releaseReadiness = resolve; });
  } });
  const session = await createSession({ conversationId: `ds-${randomUUID()}` });
  await assignSessionProject(session.id, projectId);
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: session.id, projectId, text: 'NEURAFLOK_WARMUP', warmup: true,
    authoredSource: 'none', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null
  });

  const preparing = runDeepseekInput(warmup);
  await readinessStarted;
  await flushRecorder();

  expect(webProviderFlightTurnId(session.id)).toBeTruthy();
  expect(webProviderAuthoredFlightTurnId(session.id)).toBeUndefined();
  const activeSession = await getSession(session.id);
  expect(activeSession?.activeTurnId).toBeTruthy();
  expect(sessionActivityExpiresAt(activeSession!)).toBeNull();

  releaseReadiness({ text: 'NEURAFLOK_READY' });
  await expect(preparing).resolves.toBeTruthy();
  await flushRecorder();
  expect((await getSession(session.id))?.activeTurnId).toBeNull();
  expect(webProviderAuthoredFlightTurnId(session.id)).toBeUndefined();
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
  await runDeepseekProjectInput(input);
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
  expect(pages[1]).toContain('ACTIVE REQUEST: Add hello.txt with that greeting.');
  const thread = JSON.parse(await fs.readFile(sessionWebProviderThreadPath(input.id, 'deepseek'), 'utf8')) as { messages: Array<{ role: string }> };
  expect(thread.messages[0]?.role).toBe('system');
  expect(thread.messages.some(message => message.role === 'tool')).toBe(true);
});

it('reviews tool-assisted work and keeps going when the requested project is still incomplete', async () => {
  const pages: string[] = [];
  const corePatch = '*** Begin Patch\n*** Add File: /workspace/core.js\n+export const ready = true;\n*** End Patch';
  const appPatch = '*** Begin Patch\n*** Add File: /workspace/app.js\n+import { ready } from "./core.js";\n+export const appReady = ready;\n*** End Patch';
  const request = 'Build the project with core.js and app.js, then verify both files.';
  let reply = 0;
  configureDeepseekForTests({ complete: async (text) => {
    pages.push(text);
    switch (reply++) {
      case 0:
        return { text: `<neuraflok-tool> ${JSON.stringify({ name: 'apply_patch', arguments: { patch: corePatch } })} </neuraflok-tool>` };
      case 1:
        return { text: 'core.js is ready. The project is complete.' };
      case 2:
        expect(text).toContain('COMPLETION REVIEW');
        expect(text).toContain(request);
        return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch: appPatch } })}\n\`\`\`` };
      case 3:
        return { text: 'app.js is ready too.' };
      case 4:
        expect(text).toContain('COMPLETION REVIEW');
        expect(text).toContain('natural, direct final response that answers only the user’s request');
        expect(text).toContain('Include concrete verification evidence only when it directly answers the request.');
        return { text: 'Both requested files are present and app.js imports the completed core.js.' };
      default:
        throw new Error('The completion review requested an unexpected provider turn.');
    }
  } });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: request, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });

  const turnId = await runDeepseekProjectInput(input);

  if (!turnId) {
    await flushRecorder();
    const errors = (await readEvents(input.id)).filter(event => event.kind === 'chat_error');
    throw new Error(`Tool-assisted completion review failed: ${errors.map(event => event.kind === 'chat_error' ? event.message.text : '').join('; ')}`);
  }
  expect(pages).toHaveLength(5);
  expect(pages[1]).toContain('neuraflok-result');
  expect(pages[1]).toContain('ACTIVE REQUEST: ' + request);
  expect(pages[3]).toContain('neuraflok-result');
  expect(pages[3]).toContain('ACTIVE REQUEST: ' + request);
  expect(await fs.readFile(path.join(directory, 'core.js'), 'utf8')).toBe('export const ready = true;\n');
  expect(await fs.readFile(path.join(directory, 'app.js'), 'utf8')).toBe('import { ready } from "./core.js";\nexport const appReady = ready;\n');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch')).toHaveLength(2);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('Both requested files are present'))).toBe(true);
});

it('keeps later tool results and the original request when earlier output must be shortened', async () => {
  await fs.writeFile(path.join(directory, 'large-quotes.txt'), '"'.repeat(39_000));
  await fs.writeFile(path.join(directory, 'large-second.txt'), `SECOND_RESULT_MARKER:${'b'.repeat(39_000)}`);
  const pages: string[] = [];
  let round = 0;
  configureDeepseekForTests({ complete: async (text) => {
    pages.push(text);
    if (round++ === 0) return { text: [
      '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/large-quotes.txt"]}}\n```',
      '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/large-second.txt"]}}\n```'
    ].join('\n') };
    return { text: 'Both files were inspected.' };
  } });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Inspect both files and compare them.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });

  await runDeepseekProjectInput(input);

  expect(pages[1]!).toContain('SECOND_RESULT_MARKER');
  expect(pages[1]!).toContain('ACTIVE REQUEST: Inspect both files and compare them.');
  expect(pages[1]!).toContain('Some tool output was shortened or omitted');
  expect(pages[1]!.length).toBeLessThan(96_000);
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
  await runDeepseekProjectInput(input);
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
  await runDeepseekProjectInput(input);
  expect(await fs.readFile(path.join(directory, 'from-banner.txt'), 'utf8')).toBe('banner\n');
});

it('sends instructions and a bounded prior-history summary on a DeepSeek follow-up', async () => {
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
  expect(pages[1]).toContain('RECENT CONVERSATION SUMMARY');
  expect(pages[1]).toContain('first job');
  expect(pages[1]).toContain('noted');
  expect(pages[1]).toContain('Answer the user naturally and directly');
  expect(pages[1]).not.toContain('Default workspace folder for ordinary chats');
  expect(pages[1]).not.toContain('apply_patch');
  expect(pages[1]).not.toContain('/workspace');
  expect(pages[1]).not.toContain('Available tools');
  expect(pages[1]!.match(/USER MESSAGE:\nsecond job/g)).toHaveLength(1);
  expect(fresh).toEqual([false, false]);
});

it('continues a task in the same DeepSeek chat through repeated verified idle failures', async () => {
  const pages: string[] = [];
  let call = 0;
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      if (call++ < 2) throw Object.assign(new Error('DeepSeek did not finish this reply in time.'), { providerIdle: true });
      return { text: 'Continued the existing work and completed the request.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Finish the project changes and verify them.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });

  const turnId = await runDeepseekInput(input);

  expect(turnId).toBeTruthy();
  expect(pages).toHaveLength(3);
  expect(pages[1]).toContain('Original user request still in progress');
  expect(pages[1]).toContain(input.text);
  expect(pages[2]).toContain('Original user request still in progress');
  expect(pages[2]).toContain(input.text);
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.filter(event => event.kind === 'user_message' && event.inputId === input.id)).toHaveLength(1);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('completed the request'))).toBe(true);
  expect(events.some(event => event.kind === 'turn_end' && event.outcome === 'completed')).toBe(true);
});

it('rebuilds a lost DeepSeek page from the saved local transcript', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  let loseNextFollowup = false;
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    if (loseNextFollowup) {
      loseNextFollowup = false;
      throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE: saved DeepSeek page is unavailable');
    }
    return { text: 'Continued with the restored context.' };
  } });

  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Yesterday I was implementing the import flow.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekProjectInput(first);
  loseNextFollowup = true;
  const followup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'Continue from where we left off.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekProjectInput(followup);

  expect(pages.map(page => page.fresh)).toEqual([true, false, false, true, false]);
  expect(pages[2]!.text).toContain('RECENT CONVERSATION SUMMARY');
  expect(pages[2]!.text).toContain('Yesterday I was implementing the import flow.');
  expect(pages[3]!.text).toContain('Available tools');
  expect(pages[4]!.text).toContain('Yesterday I was implementing the import flow.');
  expect(pages[4]!.text).toContain('Continued with the restored context.');
  expect(pages[4]!.text).toContain('Continue from where we left off.');
  expect(pages[4]!.text.length).toBeLessThanOrEqual(96_000);
});

it('does not reopen an existing provider chat when its local transcript is unavailable', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  const configure = () => configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    if (text.includes('NEURAFLOK_CONTEXT_CHECK')) return { text: 'NEURAFLOK_READY\nfirst job' };
    return { text: 'continued' };
  } });
  configure();
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'first job', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const originalConversation = (await getSession(first.id))?.conversationId;
  expect(originalConversation).toMatch(/^ds-/);

  await fs.rm(sessionWebProviderThreadPath(first.id, 'deepseek'), { force: true });
  resetBrowserChatForTests();
  configure();
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'continue the same task', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);

  expect((await getSession(first.id))?.conversationId).toBe(originalConversation);
  expect(pages).toHaveLength(4);
  expect(pages[2]).toMatchObject({ fresh: false, text: expect.stringContaining('NEURAFLOK_CONTEXT_CHECK') });
  expect(pages[3]).toMatchObject({ fresh: false, text: expect.stringContaining('continue the same task') });
  expect(pages[3]!.text).toContain('RECENT CONVERSATION SUMMARY');
  expect(pages[3]!.text).toContain('first job');
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
  expect(pages[0]!.text).toContain('Answer naturally and directly');
  expect(pages[0]!.text).not.toContain('Available tools');
  expect(pages[0]!.text).toContain('Do not run tools or execute examples');
  expect(pages[0]!.text).not.toContain('MY_ACTUAL_REQUEST');
  acknowledge({ text: 'NEURAFLOK_READY' });
  await running;
  expect(pages[1]).toMatchObject({ fresh: false, text: expect.stringContaining('MY_ACTUAL_REQUEST') });
  expect(pages[1]!.text).toContain('ASSISTANT_INSTRUCTIONS');
  expect(pages[1]!.text).not.toContain('PROJECT FILE TREE');
  const second = await enqueueInput({ id: randomUUID(), sessionId: first.id, text: 'MY_FOLLOWUP', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  await runDeepseekInput(second);
  expect(pages).toHaveLength(3);
  expect(pages[2]).toMatchObject({ fresh: false, text: expect.stringContaining('MY_FOLLOWUP') });
  expect(pages[2]!.text).not.toContain('Available tools');
});

it('holds the first user message until a stalled new-chat setup is resumed and confirmed', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (pages.length === 1)
      throw Object.assign(new Error('DeepSeek stopped before confirming setup.'), { providerIdle: true });
    if (text.includes('Continue the preparation request already present')) return { text: 'NEURAFLOK_READY' };
    return { text: 'The user task is complete.' };
  } });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'MY_QUEUED_REQUEST', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null
  });

  await expect(runDeepseekInput(input)).resolves.toBeTruthy();

  expect(pages).toHaveLength(3);
  expect(pages[0]).toMatchObject({ fresh: true });
  expect(pages[0]!.text).not.toContain('MY_QUEUED_REQUEST');
  expect(pages[1]).toMatchObject({ fresh: false });
  expect(pages[1]!.text).not.toContain('MY_QUEUED_REQUEST');
  expect(pages[2]).toMatchObject({ fresh: false, text: expect.stringContaining('MY_QUEUED_REQUEST') });
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.filter(event => event.kind === 'user_message' && event.inputId === input.id)).toHaveLength(1);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('user task is complete'))).toBe(true);
});

it('warms a new web chat with setup only, then sends the first user task as a follow-up', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    return { text: 'Task received.' };
  } });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(warmup);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatchObject({ fresh: true });
  expect(pages[0]!.text).toContain('Do not run tools or execute examples');
  expect(pages[0]!.text).not.toContain('NEURAFLOK_WARMUP');
  await flushRecorder();
  const warmed = await readEvents(warmup.id);
  expect(warmed.some(event => event.kind === 'user_message')).toBe(false);
  expect(warmed.some(event => event.kind === 'assistant_message' && event.message.text === 'NEURAFLOK_READY')).toBe(true);
  const first = await enqueueInput({
    id: randomUUID(), sessionId: warmup.id, text: 'MY_ACTUAL_REQUEST', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  expect(pages).toHaveLength(2);
  expect(pages[1]).toMatchObject({ fresh: false, text: expect.stringContaining('MY_ACTUAL_REQUEST') });
  expect(pages[1]!.text).not.toContain('Available tools');
  await flushRecorder();
  const events = await readEvents(warmup.id);
  expect(events.some(event => event.kind === 'user_message' && event.message.text === 'MY_ACTUAL_REQUEST')).toBe(true);
});

it('sends the first authored request after an aged warmup without repeating readiness or setup', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    return { text: 'The first request is complete.' };
  } });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(warmup);

  const originalNow = Date.now();
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(originalNow + 3 * 60_000);
  try {
    const first = await enqueueInput({
      id: randomUUID(), sessionId: warmup.id, text: 'DELAYED_FIRST_REQUEST', mode: 'auto', dueAt: 0,
      model: null, reasoningEffort: null
    });
    await expect(runDeepseekInput(first)).resolves.toBeTruthy();

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ fresh: true });
    expect(pages[1]).toMatchObject({ fresh: false, text: expect.stringContaining('DELAYED_FIRST_REQUEST') });
    expect(pages[1]!.text).not.toContain('NEURAFLOK_CONTEXT_CHECK');
    expect(pages[1]!.text).not.toContain('Initialize this NEURAFLOK conversation');
  } finally {
    dateNow.mockRestore();
  }
});

it('bootstraps a new project chat even when its local session already reserved a provider id', async () => {
  const projectChat = await createSession({ conversationId: `ds-${randomUUID()}` });
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    return options?.fresh
      ? { text: 'NEURAFLOK_READY' }
      : { text: 'CONTEXT_MISSING' };
  } });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: projectChat.id, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });

  await expect(runDeepseekInput(warmup)).resolves.toBeTruthy();

  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatchObject({ fresh: true });
  expect(pages[0]!.text).toContain('Initialize this NEURAFLOK conversation');
  await flushRecorder();
  const first = await enqueueInput({
    id: randomUUID(), sessionId: projectChat.id, text: 'PROJECT_FIRST_REQUEST', mode: 'auto', dueAt: 0,
    model: null, reasoningEffort: null
  });
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    return { text: 'Project request completed.' };
  } });
  await expect(runDeepseekInput(first)).resolves.toBeTruthy();

  expect(pages).toHaveLength(2);
  expect(pages[1]).toMatchObject({ fresh: false, text: expect.stringContaining('PROJECT_FIRST_REQUEST') });
  await flushRecorder();
  const events = await readEvents(projectChat.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.inputId === warmup.id &&
    event.message.text === 'NEURAFLOK_READY')).toBe(true);
  expect(events.some(event => event.kind === 'chat_error' && event.inputId === warmup.id)).toBe(false);
});

it('resumes project preparation in the same provider chat after a confirmed idle stop', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (pages.length === 1) throw Object.assign(new Error('DeepSeek stopped before confirming readiness.'), { providerIdle: true });
    return { text: 'NEURAFLOK_READY' };
  } });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });

  await expect(runDeepseekInput(warmup)).resolves.toBeTruthy();

  expect(pages).toHaveLength(2);
  expect(pages[0]).toMatchObject({ fresh: true });
  expect(pages[1]).toMatchObject({ fresh: false });
  expect(pages[1]!.text).toContain('Continue the preparation request already present in this exact chat');
  expect(pages[1]!.text).toContain('Do not start the user’s queued request yet');
  await flushRecorder();
  const events = await readEvents(warmup.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'NEURAFLOK_READY')).toBe(true);
  expect(events.some(event => event.kind === 'user_message')).toBe(false);
});

it('releases a message queued during project preparation after the model confirms readiness', async () => {
  let releaseReadiness!: (reply: { text: string }) => void;
  let noteStarted!: () => void;
  const readinessStarted = new Promise<void>(resolve => { noteStarted = resolve; });
  configurePageForTests({ complete: async () => {
    noteStarted();
    return await new Promise<{ text: string }>(resolve => { releaseReadiness = resolve; });
  } });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  const preparing = runDeepseekInput(warmup);
  await readinessStarted;
  await vi.waitFor(async () => {
    await flushRecorder();
    const events = await readEvents(warmup.id);
    expect(events.some(event => event.kind === 'turn_start')).toBe(true);
  });
  const activeEvents = await readEvents(warmup.id);
  const turnStart = activeEvents.find(event => event.kind === 'turn_start');
  if (!turnStart || turnStart.kind !== 'turn_start') throw new Error('Project preparation did not start a turn.');
  const queued = await enqueueInput({
    id: randomUUID(), sessionId: warmup.id, text: 'MY_QUEUED_REQUEST', mode: 'after-turn', dueAt: Date.now(),
    model: null, reasoningEffort: null
  });

  releaseReadiness({ text: 'NEURAFLOK_READY' });
  const completedTurn = await preparing;
  expect(completedTurn).toBe(turnStart.turnId);
  await flushRecorder();
  const session = await getSession(warmup.id);
  expect(session?.activeTurnId).toBeNull();
  const { nextAfterTurnLocalInput } = await import('../backend/domains/sessions/input/input.js');
  const next = await nextAfterTurnLocalInput(warmup.id, session!.conversationId!, completedTurn!);
  expect(next).toMatchObject({ id: queued.id, text: 'MY_QUEUED_REQUEST' });
});

it('continues an older project chat after context preparation and answers its hidden queued message', async () => {
  const pages: string[] = [];
  let releaseReadiness!: (reply: { text: string }) => void;
  let noteStarted!: () => void;
  const readinessStarted = new Promise<void>(resolve => { noteStarted = resolve; });
  const previousRequest = 'Yesterday I finished the catalog import flow.';
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push(text);
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    if (text.includes('NEURAFLOK_CONTEXT_CHECK')) {
      noteStarted();
      return await new Promise<{ text: string }>(resolve => { releaseReadiness = resolve; });
    }
    return { text: 'I continued the catalog import flow.' };
  } });

  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId, text: previousRequest,
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekProjectInput(first);
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, projectId, text: 'NEURAFLOK_WARMUP', warmup: true,
    authoredSource: 'none', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null
  });
  const preparing = runDeepseekInput(warmup);
  await readinessStarted;
  await vi.waitFor(async () => {
    await flushRecorder();
    expect((await getSession(first.id))?.activeTurnId).toBeTruthy();
  });
  const queued = await enqueueInput({
    id: randomUUID(), sessionId: first.id, projectId, text: 'Continue the catalog import flow.',
    mode: 'after-turn', dueAt: Date.now(), model: null, reasoningEffort: null,
    warmupDeferred: { selectionGeneration: 11 }
  });

  releaseReadiness({ text: `NEURAFLOK_READY\n${previousRequest}` });
  const completedTurn = await preparing;
  expect(completedTurn).toBeTruthy();
  const { nextAfterTurnLocalInput } = await import('../backend/domains/sessions/input/input.js');
  const conversationId = (await getSession(first.id))?.conversationId;
  expect(conversationId).toBeTruthy();
  const released = await nextAfterTurnLocalInput(first.id, conversationId!, completedTurn!);
  expect(released).toMatchObject({ id: queued.id, text: queued.text, projectId, mode: 'after-turn' });

  await runDeepseekProjectInput(released!);
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(pages.some(page => page.includes('NEURAFLOK_CONTEXT_CHECK'))).toBe(true);
  expect(events.filter(event => event.kind === 'user_message' && event.inputId === queued.id)).toHaveLength(1);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('continued the catalog import flow'))).toBe(true);
  expect(pages.at(-1)).toContain('Continue the catalog import flow.');
});

it('confirms the previous authored request before marking an existing DeepSeek chat ready', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  const previousRequest = 'Yesterday I was implementing the import flow.';
  const check = prepareWebProviderContextCheck(previousRequest);
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    if (text.includes('NEURAFLOK_CONTEXT_CHECK'))
      return { text: `NEURAFLOK_READY\n${previousRequest}` };
    return { text: 'The import flow is ready to continue.' };
  } });

  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: previousRequest, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(warmup);

  expect(check.expectedWords).toEqual(['yesterday', 'i', 'was', 'implementing', 'the', 'import', 'flow']);
  expect(pages.map(page => page.fresh)).toEqual([true, false, false]);
  expect(pages[2]!.text).toContain('NEURAFLOK_CONTEXT_CHECK');
  expect(pages[2]!.text).toContain('copy the final 7 words');
  expect(pages[2]!.text).not.toContain('Available tools');
  expect(pages[2]!.text).not.toContain('WORKSPACE_CONTEXT');
  expect(pages[2]!.text.length).toBeLessThan(1_500);
  expect(pages[2]!.text).not.toContain(previousRequest);
  expect(confirmsWebProviderContext(`NEURAFLOK_READY\n${previousRequest}`, check.expectedWords)).toBe(true);
  expect(confirmsWebProviderContext('NEURAFLOK_READY\nA different request', check.expectedWords)).toBe(false);
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.inputId === warmup.id &&
    event.message.text === 'NEURAFLOK_READY')).toBe(true);
  expect(events.some(event => event.kind === 'user_message' && event.inputId === warmup.id)).toBe(false);
});

it('checks an aged existing chat for prior context before sending a follow-up', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  const previousRequest = 'We finished the invoice import flow yesterday.';
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    if (text.includes('NEURAFLOK_CONTEXT_CHECK')) return { text: `NEURAFLOK_READY\n${previousRequest}` };
    return { text: 'The follow-up is complete with the earlier context.' };
  } });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: previousRequest, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);

  const originalNow = Date.now();
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(originalNow + 3 * 60_000);
  try {
    const followup = await enqueueInput({
      id: randomUUID(), sessionId: first.id, text: 'Continue from the invoice import flow.', mode: 'auto', dueAt: 0,
      model: null, reasoningEffort: null
    });
    await expect(runDeepseekInput(followup)).resolves.toBeTruthy();

    expect(pages).toHaveLength(4);
    expect(pages[2]).toMatchObject({ fresh: false, text: expect.stringContaining('NEURAFLOK_CONTEXT_CHECK') });
    expect(pages[3]).toMatchObject({ fresh: false, text: expect.stringContaining('Continue from the invoice import flow.') });
    expect(pages[3]!.text).toContain('RECENT CONVERSATION SUMMARY');
    expect(pages[3]!.text).toContain(previousRequest);
  } finally {
    dateNow.mockRestore();
  }
});

it('times out a stalled readiness check and aborts its provider request', async () => {
  configurePageForTests({ complete: async (_text, _signal, options) => {
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    return { text: 'Yesterday I fixed the project setup.' };
  } });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Yesterday I fixed the project setup.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);

  let checkSignal: AbortSignal | undefined;
  configurePageForTests({
    readinessTimeoutMs: 25,
    complete: async (_text, signal) => {
      checkSignal = signal;
      return await new Promise<never>(() => undefined);
    }
  });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });

  await expect(runDeepseekInput(warmup)).resolves.toBeNull();
  expect(checkSignal?.aborted).toBe(true);
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(events.some(event => event.kind === 'chat_error' && event.message.text.includes('too long to prepare'))).toBe(true);
});

it('keeps DeepSeek context preparation alive while the provider reports generation progress', async () => {
  const previousRequest = 'Yesterday I fixed the project setup.';
  configureDeepseekForTests({ complete: async () => ({ text: 'The project setup is ready.' }) });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: previousRequest, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const conversationId = (await getSession(first.id))?.conversationId;
  expect(conversationId).toBeTruthy();

  // Use the real provider-page wait so the test drives the same progress signal
  // that the browser extension sends while DeepSeek is still reasoning.
  resetBrowserChatForTests();
  configurePageForTests({ readinessTimeoutMs: 300, readinessMaxDurationMs: 1_200 });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  const preparing = runDeepseekInput(warmup);
  await vi.waitFor(() => expect(pendingProviderPage()).not.toBeNull());
  const offer = pendingProviderPage()!;

  await new Promise(resolve => setTimeout(resolve, 200));
  expect(reportProviderPageProgress({
    id: offer.id, provider: 'deepseek', conversationId, text: '', generating: true
  })).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(pendingProviderPage()?.id).toBe(offer.id);
  expect(settleProviderPage({
    id: offer.id, provider: 'deepseek', conversationId, text: `NEURAFLOK_READY\n${previousRequest}`
  })).toBe(true);
  await expect(preparing).resolves.toBeTruthy();

  await flushRecorder();
  const events = await readEvents(first.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.inputId === warmup.id &&
    event.message.text === 'NEURAFLOK_READY')).toBe(true);
  expect(events.some(event => event.kind === 'chat_error' && event.inputId === warmup.id)).toBe(false);
});

it('restores an old DeepSeek transcript before it lets the chat pass readiness', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  let loseContext = false;
  let replayedContext = false;
  let setupAcks = 0;
  const previousRequest = 'Yesterday we fixed the broken branch names for NF-15.';
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: ++setupAcks === 1 ? 'NEURAFLOK_READY' : '**NEURAFLOK_READY**.' };
    if (loseContext && text.includes('NEURAFLOK_CONTEXT_CHECK')) {
      loseContext = false;
      throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE: saved DeepSeek page is unavailable');
    }
    if (text.startsWith('The original provider page')) {
      replayedContext = true;
      return { text: '<tool_call> {"name":"write_stdin","arguments":{"session_id":5164,"chars":""}} </tool_call>' };
    }
    if (replayedContext && text.includes('RECOVERY HANDSHAKE RETRY'))
      return { text: `NEURAFLOK_READY\n${previousRequest}` };
    return { text: 'The branches are ready.' };
  } });

  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: previousRequest, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekProjectInput(first);
  loseContext = true;
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekProjectInput(warmup);

  expect(pages.map(page => page.fresh)).toEqual([true, false, false, true, false, false]);
  expect(setupAcks).toBe(2);
  expect(pages[3]!.text).toContain('Available tools');
  expect(pages[4]!.text).toContain(previousRequest);
  expect(pages[4]!.text).toContain('NEURAFLOK_CONTEXT_CHECK');
  expect(pages[5]!.text).toContain('RECOVERY HANDSHAKE RETRY');
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.inputId === warmup.id &&
    event.message.text === 'NEURAFLOK_READY')).toBe(true);
  expect(events.some(event => event.kind === 'chat_error' && event.inputId === warmup.id)).toBe(false);
  expect(events.some(event => event.kind === 'assistant_message' && event.inputId === warmup.id &&
    event.message.text.includes('session_id'))).toBe(false);
  expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'write_stdin')).toBe(false);
});

it('keeps failed old-project context recovery errors internal to the warmup turn', async () => {
  let freshCalls = 0;
  const previousRequest = 'Yesterday I completed the inventory search in this project.';
  configurePageForTests({ complete: async (text, _signal, options) => {
    if (options?.fresh) {
      freshCalls++;
      return { text: freshCalls === 1
        ? 'NEURAFLOK_READY'
        : 'Could not verify the prepared DEEPSEEK new-chat control through the browser companion.' };
    }
    if (text.includes('NEURAFLOK_CONTEXT_CHECK'))
      throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE: saved DeepSeek page is unavailable');
    return { text: 'The inventory search was recorded.' };
  } });

  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId, text: previousRequest,
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekProjectInput(first);
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: first.id, projectId, text: 'NEURAFLOK_WARMUP', warmup: true,
    authoredSource: 'none', mode: 'auto', dueAt: Date.now(), model: null, reasoningEffort: null
  });

  await expect(runDeepseekProjectInput(warmup)).resolves.toBeNull();
  await flushRecorder();
  const events = await readEvents(first.id);
  const failure = events.find(event => event.kind === 'chat_error' && event.inputId === warmup.id);

  expect(failure).toMatchObject({ internalWarmup: true });
  expect(events.some(event => event.kind === 'turn_end' && event.turnId === failure?.turnId &&
    event.outcome === 'failed' && event.internalWarmup === true)).toBe(true);
  expect(events.some(event => event.kind === 'user_message' && event.inputId === warmup.id)).toBe(false);
  expect(events.some(event => event.kind === 'assistant_message' &&
    event.message.text.includes('inventory search was recorded'))).toBe(true);
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

it('delivers a very long ordinary question once without adding project context or tool instructions', async () => {
  const pages: string[] = [];
  const request = `NF_LONG_START ${'synthetic ordinary chat text '.repeat(900)} NF_LONG_END`;
  configureDeepseekForTests({ complete: async text => {
    pages.push(text);
    return { text: 'I received the complete long question.' };
  } });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: request, mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);

  expect(pages).toHaveLength(1);
  expect(pages[0]).toContain('NF_LONG_START');
  expect(pages[0]).toContain('NF_LONG_END');
  expect(pages[0]!.match(/USER MESSAGE:\n/g)).toHaveLength(1);
  expect(pages[0]).not.toContain('PROJECT FILE TREE');
  expect(pages[0]).not.toContain('Available tools');
  expect(pages[0]).not.toContain('/workspace');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'I received the complete long question.')).toBe(true);
  expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(0);
});

it('keeps a normal DeepSeek chat plain when the provider attempts a local tool call', async () => {
  const pages: string[] = [];
  let answer = 0;
  configureDeepseekForTests({ complete: async text => {
    pages.push(text);
    if (answer++ === 0) return { text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/hello.txt"]}}\n```' };
    return { text: 'La respuesta breve es 42.' };
  } });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: '¿Cuánto es seis por siete?',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);

  expect(pages[0]).toContain('Answer the user naturally and directly');
  expect(pages[0]).not.toContain('Available tools');
  expect(pages[0]).not.toContain('/workspace');
  expect(pages[1]).toContain('normal chat with no file or command tools');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(0);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'La respuesta breve es 42.')).toBe(true);
});

it('reads files in Plan mode, blocks edits before approval, and executes after explicit approval', async () => {
  const target = path.join(directory, 'plan-target.txt');
  await fs.writeFile(target, 'before\n', 'utf8');
  const pages: Array<{ text: string; fresh: boolean }> = [];
  let reply = 0;
  const patch = '*** Begin Patch\n*** Update File: /workspace/plan-target.txt\n@@\n-before\n+after\n*** End Patch';
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    switch (reply++) {
      case 0:
        return { text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace/plan-target.txt"]}}\n```' };
      case 1:
        return { text: 'Plan: Update the one-line value and verify the file.' };
      case 2:
        return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\`` };
      case 3:
        return { text: 'I revised the plan to include the alternate idea.' };
      case 4:
        return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\`` };
      case 5:
        return { text: 'I made the change.' };
      case 6:
        expect(text).toContain('COMPLETION REVIEW');
        return { text: 'The approved change is complete and verified.' };
      default:
        throw new Error('The project-plan workflow requested an unexpected provider turn.');
    }
  } });
  // First draft, then an unapproved edit attempt is rejected and the plan is revised read-only.
  const draft = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId, projectPlanPhase: 'draft',
    text: 'Change the value after reviewing the file.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(draft);

  expect(await fs.readFile(target, 'utf8')).toBe('before\n');
  expect(await readProjectPlanState(draft.id)).toMatchObject({ request: draft.text, plan: expect.stringContaining('Update the one-line value') });
  expect(pages[0]).toMatchObject({ fresh: true });
  expect(pages[0]!.text).toContain('Available read-only tools');
  expect(pages[0]!.text).not.toContain('"name":"apply_patch"');
  expect(pages[1]!.text).toContain('# Plan first');
  await flushRecorder();
  let events = await readEvents(draft.id);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'read')).toHaveLength(1);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch')).toHaveLength(0);

  const review = await enqueueInput({
    id: randomUUID(), sessionId: draft.id, text: 'Please include the alternate idea in your plan.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(review);
  expect(await fs.readFile(target, 'utf8')).toBe('before\n');
  expect(await readProjectPlanState(draft.id)).toMatchObject({ plan: expect.stringContaining('alternate idea') });
  expect(pages[3]!.text).toContain('Plan awaiting approval');
  expect(pages[4]!.text).toContain('non-read-only tool request was blocked');

  const approved = await enqueueInput({
    id: randomUUID(), sessionId: draft.id, text: 'Aprobar', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(approved);
  expect(await fs.readFile(target, 'utf8')).toBe('after\n');
  expect(await readProjectPlanState(draft.id)).toBeNull();
  await flushRecorder();
  events = await readEvents(draft.id);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch')).toHaveLength(1);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'The approved change is complete and verified.')).toBe(true);
  expect(pages[5]!.text).toContain('The user explicitly approved this plan.');
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
  await runDeepseekProjectInput(input);
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
