interface Runtime {
  disconnectedToken: string;
  setSecret(key: string, value: string): Promise<void>;
  disconnectBrowser(): void;
  logInfo(message: string): void;
  changed(): void;
}

export function createBridgeBrowserCredentials(runtime: Runtime) {
  let epoch = 0;
  let queue: Promise<void> = Promise.resolve();

  function withBrowserCredentials<T>(operation: () => Promise<T>): Promise<T> {
    const work = queue.then(operation, operation);
    queue = work.then(() => undefined, () => undefined);
    return work;
  }

  async function unpair(): Promise<void> {
    ++epoch;
    await withBrowserCredentials(async () => {
      await runtime.setSecret('bridgeToken', runtime.disconnectedToken);
      runtime.disconnectBrowser();
      runtime.logInfo('bridge: browser disconnected');
      runtime.changed();
    });
  }

  return { withBrowserCredentials, unpair, get browserCredentialEpoch() { return epoch; } };
}
