import type http from 'node:http';
import type { Config } from '../../../contracts/types.js';
import type { createBridgeHttpBoundary } from './bridge-http-boundary.js';
import { createBridgeLifecycle, type BridgeLifecycleRuntime } from './bridge-lifecycle.js';
import { createBridgeListenerOperations, type BridgeListenerRuntime } from './bridge-listener.js';
import { createBridgeServerLifecycle } from './bridge-server-lifecycle.js';
import { bridgeRuntimeState } from './bridge-runtime-state.js';
import { createBridgeUnclaimedInputRecovery } from './bridge-unclaimed-input-recovery.js';

type ServerLifecyclePorts = Omit<
  Parameters<typeof createBridgeServerLifecycle>[0],
  | 'attachWake'
  | 'closeCancelledStart'
  | 'desiredRunning'
  | 'disposeWake'
  | 'drainListener'
  | 'enqueue'
  | 'epoch'
  | 'getPort'
  | 'getServer'
  | 'isCurrent'
  | 'isRecovering'
  | 'prepareListener'
  | 'retryUnclaimedBrowserInputs'
  | 'setDesiredRunning'
  | 'setError'
  | 'setPort'
  | 'setRecovering'
  | 'setServer'
  | 'shutdownRequested'
>;

interface BridgeServerHostOptions {
  backgroundChats(): boolean;
  disconnectedToken: string;
  getSecret(name: 'bridgeToken'): Promise<string | null>;
  handleRequest: BridgeListenerRuntime['handleRequest'];
  httpBoundary: ReturnType<typeof createBridgeHttpBoundary>;
  logInfo(message: string): void;
  logWarn(message: string): void;
  originOf: ReturnType<typeof createBridgeHttpBoundary>['originOf'];
  ports: ServerLifecyclePorts;
  recoveryInputAllowed(sessionId: string, conversationId: string): boolean;
  safeEqual(left: string, right: string): boolean;
  attachBrowserWake(instance: http.Server, allowed: (request: http.IncomingMessage) => boolean, authenticate: (candidate: string) => Promise<boolean>, changed: () => void): ReturnType<typeof import('./browser-wake.js').attachBrowserWake>;
  changed(): void;
}

export function createBridgeServerHost(options: BridgeServerHostOptions) {
  const { ports } = options;
  let bridgeLifecycle: ReturnType<typeof createBridgeLifecycle>;

  const bridgeLifecycleRuntime: BridgeLifecycleRuntime = {
    get server() { return bridgeRuntimeState.server; },
    get port() { return bridgeRuntimeState.port; },
    startBridgeOnce: (epoch: number) => bridgeRuntimeState.bridgeServerLifecycle?.startBridgeOnce(epoch) ?? Promise.resolve(null),
    stopActiveBridge: () => bridgeRuntimeState.bridgeServerLifecycle?.stopActiveBridge() ?? Promise.resolve()
  };
  bridgeLifecycle = createBridgeLifecycle(bridgeLifecycleRuntime);

  const unclaimedInputRecovery = createBridgeUnclaimedInputRecovery({
    recoveryInputAllowed: options.recoveryInputAllowed,
    isBridgeDesiredRunning: () => bridgeLifecycle.desiredRunning,
    hasBridgeServer: () => bridgeRuntimeState.server !== null,
    backgroundChats: options.backgroundChats,
    logInfo: options.logInfo,
    logWarn: options.logWarn
  });

  const bridgeListenerRuntime: BridgeListenerRuntime = {
    getPort: () => bridgeRuntimeState.port,
    getServer: () => bridgeRuntimeState.server,
    handleRequest: options.handleRequest,
    isCurrent: (epoch: number) => bridgeLifecycle.isCurrent(epoch),
    isDesiredRunning: () => bridgeLifecycle.desiredRunning,
    isRecovering: () => bridgeRuntimeState.bridgeRecovering,
    isShutdownRequested: () => bridgeLifecycle.shutdownRequested,
    logWarn: options.logWarn,
    originOf: options.originOf,
    sendJson: options.httpBoundary.json,
    setPort: (next: number | null) => { bridgeRuntimeState.port = next; },
    setRecovering: (next: boolean) => { bridgeRuntimeState.bridgeRecovering = next; },
    setServer: (next: http.Server | null) => { bridgeRuntimeState.server = next; }
  };
  const bridgeListener = createBridgeListenerOperations(bridgeListenerRuntime);
  const { closeCancelledBridgeStart, prepareBridgeListener, drainBridgeListener } = bridgeListener;

  const attachWake = (instance: http.Server): void => {
    bridgeRuntimeState.browserWake = options.attachBrowserWake(
      instance,
      request => !bridgeRuntimeState.bridgeRecovering && bridgeRuntimeState.server === instance && options.originOf(request).ok,
      async candidate => {
        const stored = await options.getSecret('bridgeToken');
        return !!stored && stored !== options.disconnectedToken && options.safeEqual(candidate, stored);
      },
      options.changed
    );
  };

  bridgeRuntimeState.bridgeServerLifecycle = createBridgeServerLifecycle({
    enqueue: operation => bridgeLifecycle.enqueue(operation),
    get epoch() { return bridgeLifecycle.epoch; },
    get desiredRunning() { return bridgeLifecycle.desiredRunning; },
    get shutdownRequested() { return bridgeLifecycle.shutdownRequested; },
    isCurrent: epoch => bridgeLifecycle.isCurrent(epoch),
    setDesiredRunning: value => bridgeLifecycle.setDesiredRunning(value),
    getServer: () => bridgeRuntimeState.server,
    setServer: value => { bridgeRuntimeState.server = value; },
    getPort: () => bridgeRuntimeState.port,
    setPort: value => { bridgeRuntimeState.port = value; },
    isRecovering: () => bridgeRuntimeState.bridgeRecovering,
    setRecovering: value => { bridgeRuntimeState.bridgeRecovering = value; },
    setError: value => { bridgeRuntimeState.bridgeError = value; },
    prepareListener: (candidates, epoch) => prepareBridgeListener(candidates, epoch),
    closeCancelledStart: (instance, actual) => closeCancelledBridgeStart(instance, actual),
    drainListener: instance => drainBridgeListener(instance),
    attachWake,
    disposeWake: () => { bridgeRuntimeState.browserWake?.dispose(); bridgeRuntimeState.browserWake = null; },
    retryUnclaimedBrowserInputs: () => unclaimedInputRecovery.retryUnclaimedBrowserInputs(),
    ...ports
  });

  return {
    bridgeLifecycle,
    bridgeLifecycleRuntime,
    bridgeListenerRuntime,
    startBridge: () => bridgeLifecycle.startBridge(),
    stopBridge: () => bridgeLifecycle.stopBridge(),
    shutdownBridge: () => bridgeLifecycle.shutdownBridge(),
    publishBridgePortChange: (next: Config, previous: Config, persist: () => Promise<Config>) =>
      bridgeRuntimeState.bridgeServerLifecycle?.publishBridgePortChange(next, previous, persist) ??
      Promise.reject(new Error('Browser bridge lifecycle is unavailable.'))
  };
}
