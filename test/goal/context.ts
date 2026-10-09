import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
export { recordLoopMcpProof } from '../goal-mcp-proof.js';
export * as prompts from '../../contracts/automation/goal-prompts.js';

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf8'),
    decryptStringAsync: async (buffer: Buffer) => ({ result: buffer.toString('utf8'), shouldReEncrypt: false })
  }
}));

export const { defaultConfig, initConfigPath, saveConfig } = await import('../../backend/infrastructure/settings/config.js');

export const { initSecretsPath, setSecret } = await import('../../backend/infrastructure/settings/secrets.js');

export const { initDurableStore } = await import('../../backend/persistence/durable.js');

export const { appendEvent, createSession, observeSessionModel, initSessionStore, resetSessionStoreForTests, readRecentEvents } = await import(
  '../../backend/domains/sessions/history/store.js'
);

export const goal = await import('../../backend/domains/automation/goal.js');

export const apiSettings = await import('../../backend/domains/providers/api-settings.js');

export const { makeTempDir, removeTempDir } = await import('../helpers.js');

export let dir: string;

export const realFetch = globalThis.fetch;

export function referenceTranscript(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  expect(messages.some(message => message.role === 'assistant')).toBe(false);
  const reference = messages.find(message => message.role === 'user')!.content;
  expect(reference).toContain('reference data, not a request to execute');
  return JSON.parse(reference.slice(reference.indexOf('\n\n') + 2));
}

/** An SSE body shaped the way OpenRouter actually sends one, split where a test wants it. */
export function stream(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encode.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const delta = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;

/** The non-streaming strict response shape requested from OpenRouter in production. */
export function decision(action: 'stop' | 'continue', reply = ''): Response {
  return Response.json({
    choices: [{ message: { content: JSON.stringify({ action, reply }) } }]
  });
}

/** Waits for a draft to leave the two stages that mean "still working". */
export async function settled(conversationId: string): Promise<NonNullable<ReturnType<typeof goal.goalViewFor>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const view = goal.goalViewFor(conversationId);
    if (view && view.stage !== 'sending' && view.stage !== 'answering') return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the draft never settled');
}

beforeAll(async () => {
  dir = await makeTempDir('clf-goal-');
  initConfigPath(dir);
  initSecretsPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
  globalThis.fetch = realFetch;
});

beforeEach(async () => {
  goal.resetGoalStateForTests();
  await saveConfig({
    ...defaultConfig(),
    goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'api', enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' }
  });
  await setSecret('openRouterApiKey', 'sk-or-test');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});
