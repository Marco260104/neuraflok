import { expect, it, vi } from 'vitest';
import { IntegratedBrowserExtensionBridge } from '../backend/domains/browser/embedded/extension-worker-bridge.js';
import { API_CHANNEL, type WorkerLike, type WorkerRegistry } from '../backend/domains/browser/embedded/extension-worker.js';

it('waits for the integrated extension to confirm the exact conversation reveal', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const sent: Array<[string, unknown[]]> = [];
  const worker: WorkerLike = {
    scope: 'chrome-extension://companion/',
    isDestroyed: () => false,
    send: (_channel, name, args) => sent.push([name as string, args as unknown[]]),
    startTask: () => ({ end: () => undefined }),
    ipc: {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      removeHandler: channel => { handlers.delete(channel); }
    }
  };
  const registry: WorkerRegistry = {
    getWorkerFromVersionID: () => worker,
    getAllRunning: () => ({}),
    startWorkerForScope: vi.fn(async () => undefined)
  };
  const bridge = new IntegratedBrowserExtensionBridge({} as never);
  bridge.connect(registry, 'companion');
  bridge.statusChanged(1, 'running');

  const conversationId = 'ds-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const revealed = bridge.revealProviderConversation(conversationId);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual(['neuraflok.reveal-provider-conversation', [expect.any(String), conversationId]]);

  const requestId = sent[0]![1][0] as string;
  await expect(handlers.get(API_CHANNEL)!({}, 'neuraflok.reveal-result', [requestId, true]))
    .resolves.toEqual({ ok: true, value: undefined });
  await expect(revealed).resolves.toBe(true);
  bridge.close();
});
