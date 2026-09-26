import type http from 'node:http';

export interface BridgeLifecycleRuntime {
  server: http.Server | null;
  port: number | null;
  startBridgeOnce(epoch: number): Promise<number | null>;
  stopActiveBridge(): Promise<void>;
}

export function createBridgeLifecycle(runtime: BridgeLifecycleRuntime) {
  let epoch = 0;
  let desiredRunning = false;
  let shutdownRequested = false;
  let queue: Promise<void> = Promise.resolve();
  let startRequest: Promise<number | null> | null = null;
  let stopRequest: Promise<void> | null = null;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const request = queue.then(operation, operation);
    queue = request.then(() => undefined, () => undefined);
    return request;
  }

  function startBridge(): Promise<number | null> {
    if (shutdownRequested) return Promise.resolve(null);
    if (desiredRunning) {
      if (startRequest) return startRequest;
      if (runtime.server) return Promise.resolve(runtime.port);
    }

    desiredRunning = true;
    const requestEpoch = ++epoch;
    const request = enqueue(async () => {
      if (!desiredRunning || requestEpoch !== epoch) return null;
      if (runtime.server) return runtime.port;
      return runtime.startBridgeOnce(requestEpoch);
    });
    startRequest = request;
    const clear = (): void => {
      if (startRequest === request) startRequest = null;
    };
    void request.then(clear, clear);
    return request;
  }

  function stopBridge(): Promise<void> {
    if (!desiredRunning && stopRequest) return stopRequest;
    desiredRunning = false;
    const requestEpoch = ++epoch;
    const request = enqueue(async () => {
      if (desiredRunning || requestEpoch !== epoch) return;
      await runtime.stopActiveBridge();
    });
    stopRequest = request;
    return request.finally(() => {
      if (stopRequest === request) stopRequest = null;
    });
  }

  function shutdownBridge(): Promise<void> {
    shutdownRequested = true;
    return stopBridge();
  }

  return {
    startBridge,
    stopBridge,
    shutdownBridge,
    enqueue,
    setDesiredRunning: (value: boolean) => { desiredRunning = value; },
    resetShutdownForTests: () => { shutdownRequested = false; },
    isCurrent: (requestEpoch: number) => requestEpoch === epoch,
    get epoch() { return epoch; },
    get desiredRunning() { return desiredRunning; },
    get shutdownRequested() { return shutdownRequested; }
  };
}
