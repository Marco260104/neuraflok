import http from 'node:http';
import type { createBridgeHttpBoundary } from './bridge-http-boundary.js';

export interface BridgeListenerRuntime {
  getPort(): number | null;
  getServer(): http.Server | null;
  handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  isCurrent(epoch: number): boolean;
  isDesiredRunning(): boolean;
  isRecovering(): boolean;
  isShutdownRequested(): boolean;
  logWarn: typeof import('../../infrastructure/settings/logger.js').logWarn;
  originOf: ReturnType<typeof createBridgeHttpBoundary>['originOf'];
  sendJson: ReturnType<typeof createBridgeHttpBoundary>['json'];
  setPort(port: number | null): void;
  setRecovering(recovering: boolean): void;
  setServer(server: http.Server | null): void;
}

export type PreparedBridge = { instance: http.Server; actual: number };

export function createBridgeListenerOperations(runtime: BridgeListenerRuntime) {
  const {
    getPort,
    getServer,
    handleRequest,
    isCurrent,
    isDesiredRunning,
    isRecovering,
    isShutdownRequested,
    logWarn: warn,
    originOf: readOrigin,
    sendJson,
    setPort,
    setRecovering,
    setServer
  } = runtime;

  async function closeCancelledBridgeStart(instance: http.Server, actual: number | null = null): Promise<null> {
    if (getServer() === instance) setServer(null);
    if (actual !== null && getPort() === actual) setPort(null);
    setRecovering(false);
    if (instance.listening) {
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    }
    return null;
  }

  // A prepared listener has a real socket, but cannot serve application requests until published.
  function createBridgeListener(): http.Server {
    const instance = http.createServer((req, res) => {
      if (getServer() !== instance || isRecovering() || !isDesiredRunning()) {
        sendJson(res, 503, { error: 'bridge_recovering', retryable: true }, readOrigin(req).origin);
        return;
      }
      handleRequest(req, res).catch((err: Error) => {
        warn(`bridge request failed: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' }, readOrigin(req).origin);
      });
    });
    instance.headersTimeout = 15_000;
    instance.requestTimeout = 30_000;
    return instance;
  }

  async function prepareBridgeListener(candidates: readonly number[], epoch: number): Promise<PreparedBridge> {
    const instance = createBridgeListener();
    let failure: NodeJS.ErrnoException | undefined;
    for (const candidate of candidates) {
      if (!isCurrent(epoch) || isShutdownRequested()) break;
      const currentServer = getServer();
      if (currentServer && candidate === getPort()) return { instance: currentServer, actual: candidate };
      const bound = await new Promise<boolean>(resolve => {
        const onError = (error: NodeJS.ErrnoException): void => { failure = error; resolve(false); };
        instance.once('error', onError);
        instance.listen(candidate, '127.0.0.1', () => {
          instance.removeListener('error', onError);
          resolve(true);
        });
      });
      if (!bound) continue;
      const address = instance.address();
      const actual = typeof address === 'object' && address ? address.port : candidate;
      instance.on('error', err => warn(`bridge server error: ${err.message}`));
      if (isCurrent(epoch) && !isShutdownRequested()) return { instance, actual };
      await drainBridgeListener(instance);
      break;
    }
    if (!isCurrent(epoch) || isShutdownRequested()) throw new Error('Browser bridge change cancelled.');
    if (candidates.length === 1 && failure?.code === 'EADDRINUSE') {
      throw new Error(`Port ${candidates[0]} is already in use (EADDRINUSE).`);
    }
    throw new Error(`Port${candidates.length === 1 ? '' : 's'} ${candidates.join(', ')}: ${failure?.message ?? 'unavailable'}`);
  }

  function drainBridgeListener(instance: http.Server): Promise<void> {
    if (!instance.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // Stop admission and drain accepted extension writes. Abruptly destroying sockets here could lose an /events or /closed item after Chrome had already handed it to the app. Keep shutdown bounded because a wedged localhost client must not pin Electron forever.
      let settled = false;
      const force = setTimeout(() => {
        if (settled) return;
        // Force first, report second: what breaks the deadlock must not sit behind a call that can throw.
        instance.closeAllConnections();
        warn('bridge drain timed out after 15s; forcing remaining connections closed');
      }, 15_000);
      force.unref?.();
      // One sweep is not enough. Chrome holds its keep-alive socket open between polls, so a connection that is merely *between* requests when stop is called is idle a millisecond later and would otherwise sit here until the 15s force. Sweeping repeatedly retires each socket the moment its in-flight request finishes, which is the drain that was intended.
      const sweep = setInterval(() => instance.closeIdleConnections?.(), 100);
      sweep.unref?.();
      instance.closeIdleConnections?.();
      instance.close(() => {
        settled = true;
        clearInterval(sweep);
        clearTimeout(force);
        resolve();
      });
    });
  }

  return { closeCancelledBridgeStart, prepareBridgeListener, drainBridgeListener };
}
