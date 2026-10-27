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
  stripDsmlChrome,
  usesBrowserProvider,
  usesApiProvider,
  webToolGuide,
  webChatRoundReminder
} from '../contracts/chat-protocol.js';
import { isWebProviderConversationId } from '../contracts/web-providers.js';
import { addProject } from '../backend/domains/workspace/projects.js';
import { getSessionWorkPlan, resetLocalProviderHydrationForTests } from '../backend/domains/sessions/input/provider-context.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const TEST_PROVIDER_CONVERSATION = 'ds-00000000-0000-0000-0000-000000000001';

// Most executor tests focus on the task/tool loop after the separately tested setup exchange.
function configureDeepseekForTests(options: Parameters<typeof configurePageForTests>[0]): void {
  configurePageForTests({ complete: async (text, signal, pageOptions) => {
    if (pageOptions?.fresh && /Initialize this NEURAFLOK conversation|Reply with exactly NEURAFLOK_READY/i.test(text)) {
      return { text: 'NEURAFLOK_READY' };
    }
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
let workspaceProject: Awaited<ReturnType<typeof addProject>>;

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
  workspaceProject = await addProject(directory);
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
  expect(guide).toContain('If the user asked a question or the work is done, answer after tools in a short friendly recap');
  expect(guide).toContain('That final answer must be friendly and easy to read');
  expect(webChatRoundReminder()).toContain('This is a conversation only');
  expect(webChatRoundReminder()).toContain('default workspace folder');
  expect(webChatRoundReminder()).not.toContain('apply_patch');
  expect(webChatRoundReminder()).not.toContain('Approved roots');
  expect(webChatRoundReminder()).not.toContain('Project structure');
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
  expect(rooted).toContain('On the user task, first output must be a complete neuraflok-tool fence');
  expect(rooted).toContain('If the user asked a question or the work is done, answer after tools in a short friendly recap');
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
  expect(parseWebChatTools('<neuraflok-tool fence> {"name":"exec_command","arguments":{"cmd":"Get-ChildItem -Name","workdir":"/shop"}} </neuraflok-tool>')).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'exec_command', arguments: '{"cmd":"Get-ChildItem -Name","workdir":"/shop"}' }
  }]);
  expect(parseWebChatTools('<DSML calls><DSML invoke name="exec_command"><DSML parameter name="arguments" string="false">{"cmd":"Get-ChildItem -Name","workdir":"/shop"}</DSML parameter><DSML parameter name="name" string="true">exec_command</DSML parameter></DSML invoke></DSML calls>')).toEqual([{
    id: 'call_1',
    type: 'function',
    function: { name: 'exec_command', arguments: '{"cmd":"Get-ChildItem -Name","workdir":"/shop"}' }
  }]);
  expect(incompleteWebChatTool('<DSML invoke name="exec_command"><DSML parameter name="arguments">{')).toBe(true);
  expect(incompleteWebChatTool('<exec_command>\n{"cmd":"rg --files"\n')).toBe(true);
  expect(incompleteWebChatTool('<exec_command>\n{"cmd":"rg --files","workdir":"/commander"}\n</exec_command>')).toBe(false);
  expect(stripWebChatTools(text)).toBe('Working.');
  const dsmlChrome = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n\n<\uFF5C\uFF5C\n\nEl proyecto Librería Brújula está listo. Abre index.html con doble clic.';
  expect(stripDsmlChrome(dsmlChrome)).toBe('El proyecto Librería Brújula está listo. Abre index.html con doble clic.');
  expect(stripWebChatTools(dsmlChrome)).toBe('El proyecto Librería Brújula está listo. Abre index.html con doble clic.');
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
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'Add hello.txt with that greeting.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
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
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'Write after-repair.txt', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
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
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'Write from-banner.txt', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  expect(await fs.readFile(path.join(directory, 'from-banner.txt'), 'utf8')).toBe('banner\n');
});

it('opens a new DeepSeek tab on a follow-up and packs the conversation recap', async () => {
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
  expect(pages[0]).toContain('This is a conversation only');
  expect(pages[0]).toContain('default workspace folder');
  expect(pages[0]).not.toContain('apply_patch');
  expect(pages[0]).not.toContain('Project structure');
  expect(pages[0]).not.toContain('WORKSPACE_CONTEXT');
  expect(pages[1]).toContain('second job');
  expect(pages[1]).toContain('first job');
  expect(pages[1]).toContain('Conversation recap');
  expect(pages[1]).not.toContain('apply_patch');
  expect(pages[1]).not.toContain('Available tools');
  expect(fresh).toEqual([true, true]);
});

it('sends setup once, waits for its acknowledgement, then sends authored messages separately', async () => {
  const folder = path.join(directory, 'setup-project');
  await fs.mkdir(folder, { recursive: true });
  const project = await addProject(folder);
  const pages: Array<{ text: string; fresh: boolean }> = [];
  let acknowledge!: (value: { text: string }) => void;
  let setupDone = false;
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh && !setupDone) {
      return new Promise(resolve => {
        acknowledge = (value) => {
          setupDone = true;
          resolve(value);
        };
      });
    }
    return { text: 'Task received.' };
  } });
  const first = await enqueueInput({ id: randomUUID(), sessionId: null, projectId: project.id, text: 'MY_ACTUAL_REQUEST', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
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
  expect(pages[2]).toMatchObject({ fresh: true, text: expect.stringContaining('MY_FOLLOWUP') });
  expect(pages[2]!.text).toContain('Continuation of this NEURAFLOK session');
  expect(pages[2]!.text).not.toContain('Available tools');
});

it('warms a new web chat with setup only, then sends the first user task as a follow-up', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    if (options?.fresh) return { text: 'NEURAFLOK_READY' };
    return { text: 'Task received.' };
  } });
  const warmup = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'NEURAFLOK_WARMUP', warmup: true, authoredSource: 'none',
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
  expect(pages[1]).toMatchObject({ fresh: true, text: expect.stringContaining('MY_ACTUAL_REQUEST') });
  expect(pages[1]!.text).not.toContain('Available tools');
  expect(pages[1]!.text).toContain('Project structure');
  expect(pages[1]!.text).not.toContain('Continuation of this NEURAFLOK session');
  await flushRecorder();
  const events = await readEvents(warmup.id);
  expect(events.some(event => event.kind === 'user_message' && event.message.text === 'MY_ACTUAL_REQUEST')).toBe(true);
});

it('does not execute tool examples from setup and still sends the user task', async () => {
  const folder = path.join(directory, 'setup-tools-project');
  await fs.mkdir(folder, { recursive: true });
  const project = await addProject(folder);
  const complete = vi.fn(async (_text: string, _signal?: AbortSignal, options?: { fresh?: boolean }) => {
    if (options?.fresh) return { text: '```neuraflok-tool\n{"name":"read","arguments":{"paths":["/workspace"]}}\n```' };
    return { text: 'Task received.' };
  });
  configurePageForTests({ complete });
  const entry = await enqueueInput({ id: randomUUID(), sessionId: null, projectId: project.id, text: 'Do my task', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  expect(await runDeepseekInput(entry)).toBeTruthy();
  expect(complete).toHaveBeenCalledTimes(2);
  await flushRecorder();
  const events = await readEvents(entry.id);
  expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(0);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'Task received.')).toBe(true);
});

it('does not store a leftover setup recap in the project thread', async () => {
  const leftover = [
    'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:',
    '',
    'Lógica (core.js)',
    '',
    'npm run dev y abre http://localhost:3000.'
  ].join('\n');
  let userRounds = 0;
  configurePageForTests({ complete: async (text, _signal, options) => {
    if (options?.fresh && /Initialize this NEURAFLOK conversation|Reply with exactly NEURAFLOK_READY/i.test(text)) {
      return { text: leftover };
    }
    userRounds += 1;
    if (userRounds === 1) return { text: leftover };
    return { text: 'Librería Brújula es una aplicación de ventas para una librería local.' };
  } });
  const entry = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id,
    text: 'PUEDES DECIRME DE QUE TRATA EL PROYECTO', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  expect(await runDeepseekInput(entry)).toBeTruthy();
  await flushRecorder();
  const thread = JSON.parse(await fs.readFile(sessionWebProviderThreadPath(entry.id, 'deepseek'), 'utf8')) as {
    messages: Array<{ role: string; content?: string }>;
  };
  expect(thread.messages.some(row => String(row.content || '').includes('descuento dinámico'))).toBe(false);
  expect(thread.messages.some(row => row.role === 'assistant' && String(row.content || '').includes('NEURAFLOK_READY'))).toBe(true);
  const events = await readEvents(entry.id);
  expect(events.some(event => event.kind === 'assistant_message' && String(event.message?.text || '').includes('descuento dinámico'))).toBe(false);
  expect(events.some(event => event.kind === 'assistant_message' && String(event.message?.text || '').includes('Librería Brújula'))).toBe(true);
});

it('does not stream a leftover project recap into the transcript', async () => {
  resetBrowserChatForTests();
  resetProviderPageForTests();
  const leftover = [
    'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:',
    '',
    'Lógica (core.js)',
    '',
    'npm run dev y abre http://localhost:3000.'
  ].join('\n');
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id,
    text: 'De qué trata el proyecto', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  const running = runDeepseekInput(input);
  await vi.waitFor(() => expect(pendingProviderPage()?.fresh).toBe(true));
  const setup = pendingProviderPage()!;
  expect(settleProviderPage({
    id: setup.id, provider: 'deepseek', conversationId: setup.conversationId,
    text: 'NEURAFLOK_READY'
  })).toBe(true);
  await vi.waitFor(() => expect(pendingProviderPage()?.text).toContain('De qué trata el proyecto'));
  const offer = pendingProviderPage()!;
  expect(reportProviderPageProgress({
    id: offer.id, provider: 'deepseek', conversationId: offer.conversationId,
    text: leftover, generating: true
  })).toBe(true);
  expect(settleProviderPage({
    id: offer.id, provider: 'deepseek', conversationId: offer.conversationId,
    text: 'Librería Brújula es una aplicación de ventas para una librería local.'
  })).toBe(true);
  await running;
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'assistant_message' && String(event.message?.text || '').includes('descuento dinámico'))).toBe(false);
  expect(events.some(event => event.kind === 'assistant_message' && String(event.message?.text || '').includes('Librería Brújula'))).toBe(true);
  const thread = JSON.parse(await fs.readFile(sessionWebProviderThreadPath(input.id, 'deepseek'), 'utf8')) as {
    messages: Array<{ role: string; content?: string }>;
  };
  expect(thread.messages.some(row => String(row.content || '').includes('descuento dinámico'))).toBe(false);
});

it('saves a recap-style answer after tools', async () => {
  const recap = [
    'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:',
    '',
    'Lógica (core.js)',
    '',
    'También apliqué el parche de SPEC.md. npm run dev.'
  ].join('\n');
  const patch = '*** Begin Patch\n*** Add File: /workspace/recap-after-tools.txt\n+ok\n*** End Patch';
  const fence = `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\``;
  let round = 0;
  configureDeepseekForTests({
    complete: async () => {
      const n = round++;
      if (n === 0) return { text: fence };
      return { text: recap };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id,
    text: 'Aplica el parche', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  expect(await runDeepseekInput(input)).toBeTruthy();
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch')).toBe(true);
  expect(events.some(event => event.kind === 'assistant_message' && String(event.message?.text || '').includes('También apliqué el parche'))).toBe(true);
});

it('retries a general chat on a leftover project recap and keeps the real greeting', async () => {
  const leftover = [
    'Sí, ya quedó implementado el descuento dinámico por producto. Esto es lo que cambió:',
    '',
    'Lógica (core.js)',
    '',
    'npm run dev y abre http://localhost:3000.'
  ].join('\n');
  const pages: Array<{ text: string; fresh: boolean }> = [];
  let round = 0;
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    round += 1;
    if (round === 1) return { text: leftover };
    return { text: 'Hola. ¿En qué te ayudo?' };
  } });
  const entry = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Hola', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(entry);
  await flushRecorder();
  const events = await readEvents(entry.id);
  expect(pages.length).toBeGreaterThanOrEqual(2);
  expect(pages[1]!.fresh).toBe(true);
  expect(pages[1]!.text).toContain('This is a conversation only');
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'Hola. ¿En qué te ayudo?')).toBe(true);
  expect(events.some(event => event.kind === 'assistant_message' && String(event.message?.text || '').includes('descuento dinámico'))).toBe(false);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
});

it('retries a leftover conversation error on a general chat and keeps the greeting', async () => {
  let round = 0;
  configurePageForTests({ complete: async () => {
    round += 1;
    if (round === 1) throw new Error('The provider page still showed a previous conversation. Open a new chat and send again.');
    return { text: 'Hola. Dime.' };
  } });
  const entry = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Hola', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(entry);
  await flushRecorder();
  const events = await readEvents(entry.id);
  expect(round).toBe(2);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'Hola. Dime.')).toBe(true);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
});

it('sends a simple greeting without a setup handshake', async () => {
  const pages: Array<{ text: string; fresh: boolean }> = [];
  configurePageForTests({ complete: async (text, _signal, options) => {
    pages.push({ text, fresh: options?.fresh === true });
    return { text: 'Hola. Estoy listo.' };
  } });
  const entry = await enqueueInput({ id: randomUUID(), sessionId: null, text: 'Hola', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null });
  await runDeepseekInput(entry);
  expect(pages).toHaveLength(1);
  expect(pages[0]!.fresh).toBe(true);
  expect(pages[0]!.text).toContain('Hola');
  expect(pages[0]!.text).toContain('This is a conversation only');
  expect(pages[0]!.text).not.toContain('Available tools');
  expect(pages[0]!.text).not.toContain('apply_patch');
  expect(pages[0]!.text).not.toContain('WORKSPACE_CONTEXT');
  expect(pages[0]!.text).not.toContain('Initialize this NEURAFLOK conversation');
  await flushRecorder();
  const events = await readEvents(entry.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'Hola. Estoy listo.')).toBe(true);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
});

it('does not post the previous project reply as the new answer', async () => {
  const previous = 'El panel ya lista los productos y aplica el descuento dinámico por producto en core.js, con pruebas en el carrito.';
  const pages: string[] = [];
  configureDeepseekForTests({
    complete: async (text, _signal, options) => {
      pages.push(text);
      if (options?.fresh && /Initialize this NEURAFLOK conversation/i.test(text)) {
        return { text: 'NEURAFLOK_READY' };
      }
      if (pages.filter(row => !/Initialize this NEURAFLOK conversation/i.test(row)).length === 1) {
        return { text: previous };
      }
      if (text.includes(previous) || /What is next/i.test(text)) {
        if (pages.filter(row => /What is next/i.test(row)).length === 1) return { text: previous };
        return { text: 'Siguiente paso: cubrir esto con tests.' };
      }
      return { text: previous };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'Haz el panel', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'What is next?', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  await flushRecorder();
  const events = await readEvents(first.id);
  const assistants = events.filter(event => event.kind === 'assistant_message').map(event => String(event.message?.text || ''));
  expect(assistants.filter(text => text === previous)).toHaveLength(1);
  expect(assistants.some(text => text.includes('Siguiente paso'))).toBe(true);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
});

it('does not re-run leftover tools from the previous page answer', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/once.txt\n+once\n*** End Patch';
  const fence = `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\``;
  let round = 0;
  configureDeepseekForTests({
    complete: async () => {
      const n = round++;
      if (n === 0) return { text: fence };
      if (n === 1) return { text: 'Created once.txt.' };
      if (n === 2) return { text: fence };
      return { text: 'Follow-up done.' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'Write once.txt', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'What is next?', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch')).toHaveLength(1);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text === 'Follow-up done.')).toBe(true);
});

it('does not execute file tools in a general chat even if the page emits a fence', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/should-not-exist.txt\n+nope\n*** End Patch';
  configureDeepseekForTests({
    complete: async () => ({
      text: `Voy a leer el proyecto.\n\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\``
    })
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Hola necesito ayuda', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  await expect(fs.stat(path.join(directory, 'should-not-exist.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.filter(event => event.kind === 'tool_call')).toHaveLength(0);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('Voy a leer el proyecto'))).toBe(true);
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

it('sends project instructions and prior work when the user only types CONTINUA', async () => {
  const folder = path.join(directory, 'continue-project');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'AGENTS.md'), 'KEEP_THE_EXISTING_TREE_API');
  const project = await addProject(folder);
  const pages: string[] = [];
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      return { text: 'worked on the tree' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: project.id, text: 'Implementa el arbol binario',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, projectId: project.id, text: 'CONTINUA',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  expect(pages[1]).toContain('KEEP_THE_EXISTING_TREE_API');
  expect(pages[1]).toContain('Implementa el arbol binario');
  expect(pages[1]).toContain('CONVERSATION_SO_FAR');
  expect(pages[1]).toContain('Do not start an unrelated task');
  expect(pages[1]).not.toContain('PLAN_ONLY');
});

it('restores project context on the first follow-up after the live page binding is forgotten', async () => {
  const folder = path.join(directory, 'reopen-project');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'AGENTS.md'), 'KEEP_THE_EXISTING_TREE_API');
  const project = await addProject(folder);
  const pages: string[] = [];
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      return { text: 'noted' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: project.id, text: 'Implementa el arbol binario',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  resetLocalProviderHydrationForTests();
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, projectId: project.id, text: 'Añade tests unitarios al arbol',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  expect(pages[1]).toContain('KEEP_THE_EXISTING_TREE_API');
  expect(pages[1]).toContain('Implementa el arbol binario');
  expect(pages[1]).toContain('Añade tests unitarios al arbol');
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
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'spawn a worker', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
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

it('settles a wait with the last public progress text instead of a timeout error', async () => {
  resetProviderPageForTests();
  vi.useFakeTimers();
  try {
    const pending = requestProviderPageComplete('deepseek', TEST_PROVIDER_CONVERSATION, 'hello');
    const offer = pendingProviderPage();
    expect(reportProviderPageProgress({
      id: offer!.id, provider: 'deepseek', conversationId: TEST_PROVIDER_CONVERSATION,
      text: 'Created src/App.tsx and src/main.tsx.', generating: true
    })).toBe(true);
    await vi.advanceTimersByTimeAsync(601_000);
    await expect(pending).resolves.toEqual({ text: 'Created src/App.tsx and src/main.tsx.' });
  } finally {
    vi.useRealTimers();
    resetProviderPageForTests();
  }
});

it('does not stream DeepSeek reasoning into the local transcript', async () => {
  resetBrowserChatForTests();
  resetProviderPageForTests();
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Summarize the UI architecture.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  const running = runDeepseekInput(input);
  await vi.waitFor(() => expect(pendingProviderPage()?.fresh).toBe(true));
  const offer = pendingProviderPage()!;
  expect(offer.text).toContain('Summarize the UI architecture.');
  expect(reportProviderPageProgress({
    id: offer.id, provider: 'deepseek', conversationId: offer.conversationId,
    text: 'Let me inspect the React router and layout next.', generating: true
  })).toBe(true);
  expect(settleProviderPage({
    id: offer.id, provider: 'deepseek', conversationId: offer.conversationId,
    text: 'The app uses React Router and a dashboard shell.'
  })).toBe(true);
  await running;
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('Let me inspect'))).toBe(false);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('dashboard shell'))).toBe(true);
});

it('runs a long synthetic React and design task through many tool rounds without hanging', async () => {
  const files = [
    'package.json', 'src/main.tsx', 'src/App.tsx', 'src/layout/Shell.tsx', 'src/layout/Sidebar.tsx',
    'src/pages/Dashboard.tsx', 'src/pages/Settings.tsx', 'src/components/Button.tsx', 'src/components/Card.tsx',
    'src/styles/tokens.css', 'src/styles/theme.ts', 'src/hooks/useProject.ts', 'src/api/client.ts'
  ];
  let round = 0;
  configureDeepseekForTests({
    complete: async (text) => {
      if (text.includes('PLAN_ONLY')) {
        return { text: '1. Create the React files\n2. Wire the dashboard and settings\n3. Add design tokens and the API client' };
      }
      const n = round++;
      if (n < files.length) {
        const target = files[n]!;
        const patch = `*** Begin Patch\n*** Add File: /workspace/${target}\n+synthetic ${target}\n*** End Patch`;
        return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\`` };
      }
      if (n === files.length) {
        return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'read', arguments: { paths: files.map(file => `/workspace/${file}`) } })}\n\`\`\`` };
      }
      expect(text).toContain('neuraflok-result');
      return { text: 'Implemented the dashboard, settings page, design tokens, and API client.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id,
    text: 'Build a React dashboard with settings, design tokens, and an API client. Create every listed file.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  const turnId = await runDeepseekInput(input);
  expect(turnId).toBeTruthy();
  for (const file of files) {
    expect(await fs.readFile(path.join(directory, file), 'utf8')).toBe(`synthetic ${file}\n`);
  }
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.filter(event => event.kind === 'tool_call' && event.call.tool === 'apply_patch')).toHaveLength(files.length);
  expect(events.some(event => event.kind === 'turn_end' && event.outcome === 'completed')).toBe(true);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
  expect(round).toBe(files.length + 2);
});

it('repairs cut tool fences in a heavy programming turn and then finishes', async () => {
  const patch = '*** Begin Patch\n*** Add File: /workspace/server/index.ts\n+export function listen() { return 3000 }\n*** End Patch';
  let round = 0;
  configureDeepseekForTests({
    complete: async () => {
      const n = round++;
      if (n === 0) return { text: '```neuraflok-tool\n{"name":"apply_patch","arguments":{"patch":' };
      if (n === 1) return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\`` };
      return { text: 'The Express-style server entry is in place.' };
    }
  });
  const input = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'Add server/index.ts', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(input);
  expect(await fs.readFile(path.join(directory, 'server', 'index.ts'), 'utf8')).toBe('export function listen() { return 3000 }\n');
  await flushRecorder();
  const events = await readEvents(input.id);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
  expect(events.some(event => event.kind === 'turn_end' && event.outcome === 'completed')).toBe(true);
});

it('answers a short greeting without tools, then a complex design follow-up with patches', async () => {
  const pages: string[] = [];
  let round = 0;
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      const n = round++;
      if (n === 0) return { text: 'Hola. Dime el siguiente paso.' };
      if (n === 1) {
        const patch = '*** Begin Patch\n*** Add File: /workspace/design/tokens.css\n+:root { --space: 8px }\n*** End Patch';
        return { text: `\`\`\`neuraflok-tool\n${JSON.stringify({ name: 'apply_patch', arguments: { patch } })}\n\`\`\`` };
      }
      return { text: 'Tokens listos en design/tokens.css.' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: workspaceProject.id, text: 'Hola', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, projectId: workspaceProject.id, text: 'Crea tokens de diseño.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  expect(await fs.readFile(path.join(directory, 'design', 'tokens.css'), 'utf8')).toBe(':root { --space: 8px }\n');
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('Hola'))).toBe(true);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
  expect(pages[0]).toContain('Hola');
  expect(pages[1]).toContain('Crea tokens de diseño.');
});

it('continues a previous web chat without treating a greeting as a failed reopen', async () => {
  const pages: string[] = [];
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      return { text: pages.length === 1 ? 'Ready for the dashboard work.' : 'Continuing from yesterday: the Card component is done.' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Start the design system.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id, text: 'Continue the Card component.', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(events.some(event => event.kind === 'chat_error')).toBe(false);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('Card component is done'))).toBe(true);
  expect(pages[1]).toContain('Continue the Card component.');
});

it('sends PLAN_ONLY from composer Plan and posts the plan without executing it', async () => {
  const folder = path.join(directory, 'plan-project');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'AGENTS.md'), 'KEEP_PLAN_TREE');
  const project = await addProject(folder);
  const pages: string[] = [];
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      if (text.includes('PLAN_ONLY')) {
        return { text: '1. Inspect the current layout\n2. Change the loading animation\n3. Verify the home screen' };
      }
      return { text: 'should not execute the plan yet' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, projectId: project.id, text: 'Cambia la animación de carga',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, planOnly: true
  });
  await runDeepseekInput(first);
  await flushRecorder();
  const events = await readEvents(first.id);
  expect(pages.some(page => page.includes('PLAN_ONLY'))).toBe(true);
  expect(pages.some(page => page.includes('KEEP_PLAN_TREE') || page.includes('Project structure') || page.includes('Project files'))).toBe(true);
  expect(pages.some(page => page.includes('EXECUTE_ONE_STEP'))).toBe(false);
  expect(getSessionWorkPlan(first.id)).toBeNull();
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('Inspect the current layout'))).toBe(true);
  expect(events.some(event => event.kind === 'assistant_message' && event.message.text.includes('should not execute'))).toBe(false);
});

it('sends a new request without PLAN_ONLY when plan mode is off', async () => {
  const pages: string[] = [];
  configureDeepseekForTests({
    complete: async (text) => {
      pages.push(text);
      return { text: pages.length === 1 ? 'El catálogo vanilla ya funciona.' : 'Voy a migrar a Next.js y Anime.js.' };
    }
  });
  const first = await enqueueInput({
    id: randomUUID(), sessionId: null, text: 'Haz la librería vanilla.',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(first);
  const second = await enqueueInput({
    id: randomUUID(), sessionId: first.id,
    text: 'Puedes cambiar todo y usar Next.js y Anime.js para una animación de carga',
    mode: 'auto', dueAt: 0, model: null, reasoningEffort: null
  });
  await runDeepseekInput(second);
  expect(pages.some(page => page.includes('PLAN_ONLY'))).toBe(false);
  expect(pages.some(page => page.includes('EXECUTE_ONE_STEP'))).toBe(false);
  expect(pages.some(page => page.includes('Next.js') && page.includes('Anime.js'))).toBe(true);
  expect(getSessionWorkPlan(first.id)).toBeNull();
});
