import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createBridgeClient } from '../browser-extension/src/background/connectivity/bridge-client.js';

type JsonResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text?: () => Promise<string> };

class WakeSocket {
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  readonly send = vi.fn();
  readonly close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string, sockets: WakeSocket[], unavailable: boolean) {
    if (unavailable) throw new Error('WebSocket unavailable');
    sockets.push(this);
  }

  open(): void { this.readyState = 1; this.onopen?.(); }
  message(data: string): void { this.onmessage?.({ data }); }
  finish(): void { this.readyState = 3; this.onclose?.(); }
}

function jsonResponse(status: number, data: unknown): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function harness(status = 200, unavailableSocket = false) {
  const sockets: WakeSocket[] = [];
  let socketUnavailable = unavailableSocket;
  const saved: Record<string, unknown> = {
    port: 8765,
    token: 'paired-secret',
    neuralJamBrowserId: '0123456789abcdef0123456789abcdef'
  };
  const chrome = {
    storage: { local: {
      get: async () => ({ ...saved }),
      set: async (value: Record<string, unknown>) => Object.assign(saved, value),
      remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete saved[key]; }
    } },
    runtime: {
      getURL: (path: string) => `chrome-extension://neuraflok/${path}`,
      getManifest: () => ({ version: '0.1.0' })
    }
  };
  const fetch = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.protocol === 'chrome-extension:') return { text: async () => 'abcdef012345' } as JsonResponse;
    if (url.pathname === '/hello') return jsonResponse(200, {
      app: 'neuraflok', version: '0.1.0', bridge: 16, compatible: true, disconnected: false
    });
    if (url.pathname === '/events') return jsonResponse(status, { ok: true });
    throw new Error(`Unexpected route ${url.pathname}`);
  });
  class Socket extends WakeSocket {
    constructor(url: string) { super(url, sockets, socketUnavailable); }
  }
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('WebSocket', Socket);
  const client = createBridgeClient(chrome as never);
  const wake = vi.fn();
  client.setWakeHandler(wake);
  return { client, fetch, sockets, wake, setSocketAvailable: (available: boolean) => { socketUnavailable = !available; } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('connects the wake channel after the first authenticated HTTP success and reconnects after closure', async () => {
  vi.useFakeTimers();
  const h = harness();
  await expect(h.client.request('/events')).resolves.toMatchObject({ ok: true, status: 200 });
  expect(h.sockets).toHaveLength(1);
  const socket = h.sockets[0]!;
  expect(socket.url).toBe('ws://127.0.0.1:8765/wake?host=browser');
  socket.open();
  expect(socket.send).toHaveBeenCalledWith('paired-secret');
  socket.message('ping');
  expect(socket.send).toHaveBeenCalledWith('pong');
  socket.message('unknown');
  expect(h.wake).not.toHaveBeenCalled();
  socket.message('wake');
  expect(h.wake).toHaveBeenCalledWith('wake');
  socket.message('browser-control');
  expect(h.wake).toHaveBeenCalledWith('browser-control');

  await h.client.request('/events');
  expect(h.sockets).toHaveLength(1);
  socket.finish();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(h.sockets).toHaveLength(2);
});

it('restores the wake channel from saved pairing without waiting for a provider or status request', async () => {
  const h = harness();
  const connected = h.client.connectWakeChannel();
  await flushMicrotasks();
  expect(h.fetch.mock.calls.filter(([input]) => String(input).startsWith('http://127.0.0.1'))).toHaveLength(0);
  expect(h.sockets).toHaveLength(1);
  let resolved = false;
  void connected.then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);
  h.sockets[0]!.open();
  h.sockets[0]!.message('wake');
  await expect(connected).resolves.toBe(true);
  expect(h.sockets[0]!.send).toHaveBeenCalledWith('paired-secret');
});

it('does not wait forever for a wake channel that never authenticates', async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    const connected = h.client.connectWakeChannel();
    await flushMicrotasks();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(connected).resolves.toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('replaces a wake socket that stays stuck in connecting state', async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    const connected = h.client.connectWakeChannel();
    await flushMicrotasks();
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(connected).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

it('does not treat failed HTTP as proof that the wake channel is ready', async () => {
  const h = harness(503);
  await expect(h.client.request('/events')).resolves.toMatchObject({ ok: false, status: 503 });
  expect(h.sockets).toHaveLength(0);
});

it('preserves a successful HTTP response when WebSocket construction is unavailable', async () => {
  vi.useFakeTimers();
  const h = harness(200, true);
  await expect(h.client.request('/events')).resolves.toMatchObject({ ok: true, status: 200 });
  expect(h.sockets).toHaveLength(0);
  h.setSocketAvailable(true);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(h.sockets).toHaveLength(1);
});

it('reconnects after a socket error even when the browser omits its close event', async () => {
  vi.useFakeTimers();
  const h = harness();
  await expect(h.client.request('/events')).resolves.toMatchObject({ ok: true, status: 200 });
  expect(h.sockets).toHaveLength(1);
  h.sockets[0]!.onerror?.();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(h.sockets).toHaveLength(2);
});
