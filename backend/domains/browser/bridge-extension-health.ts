import type { IncomingMessage } from 'node:http';

interface BridgeExtensionHealthRuntime {
  appVersion: string;
  bridgeProtocol: number;
  changed(): void;
  extensionBuildOf(request: IncomingMessage): string | null;
  extensionProtocol(request: IncomingMessage): number | null;
  logInfo(message: string): void;
  logWarn(message: string): void;
  noteExtensionBuild(request: IncomingMessage): void;
  noteExternalVersion(isExternalBrowser: boolean, version: string): boolean;
  shippedExtensionBuild(): string | null;
}

const UPDATE_HOLD_DETAILS: Record<string, string> = {
  'app-busy': 'a tool call is running in this app',
  sending: 'a message is being sent',
  commands: 'a browser command is still pending',
  'chat-busy': 'a provider page is still answering',
  'already-tried': 'it already tried this update once; restart the integrated browser',
  'folder-not-ready': 'its folder does not hold the new build yet'
};

const MAX_ANNOUNCED_BUILDS = 16;
const ANNOUNCEMENT_INTERVAL_MS = 30 * 60_000;

// Owns extension version announcements, protocol warnings, and deferred-update explanations.
export function createBridgeExtensionHealth(runtime: BridgeExtensionHealthRuntime) {
  const announcements = new Map<string, number>();
  let currentVersion: string | null = null;
  let warnedProtocol = false;
  let lastUpdateHold: string | null = null;

  function warnProtocol(protocol: number | null): void {
    if (warnedProtocol || protocol === null || protocol === runtime.bridgeProtocol) return;
    warnedProtocol = true;
    runtime.logWarn(
      `bridge: the browser extension speaks protocol ${protocol} but this app speaks ${runtime.bridgeProtocol}. ` +
        `Restart NEURAFLOK to refresh its bundled companion for app ${runtime.appVersion}.`
    );
  }

  function noteVersion(request: IncomingMessage): void {
    runtime.noteExtensionBuild(request);
    const stamp = runtime.extensionBuildOf(request);
    const protocol = runtime.extensionProtocol(request);
    const reportedVersion = request.headers['x-extension-version'];
    if (typeof reportedVersion !== 'string') {
      warnProtocol(protocol);
      return;
    }

    const version = reportedVersion.slice(0, 32);
    const externalChanged = runtime.noteExternalVersion(request.headers['x-extension-host'] === 'browser', version);
    currentVersion = version;
    const key = `${version}\u0000${stamp ?? ''}`;
    const lastAnnouncementAt = announcements.get(key);

    if (lastAnnouncementAt === undefined || Date.now() - lastAnnouncementAt >= ANNOUNCEMENT_INTERVAL_MS) {
      announcements.delete(key);
      announcements.set(key, Date.now());
      if (announcements.size > MAX_ANNOUNCED_BUILDS) announcements.delete(announcements.keys().next().value!);
      runtime.logInfo(`bridge: browser extension ${version} connected${stamp ? ` (build ${stamp})` : ''}`);
      const shipped = runtime.shippedExtensionBuild();
      if (shipped && stamp && stamp !== shipped) {
        runtime.logInfo(`bridge: companion build ${stamp} differs from shipped build ${shipped}; restart NEURAFLOK if automatic refresh does not finish`);
      }
      runtime.changed();
    } else if (externalChanged) {
      runtime.changed();
    }

    warnProtocol(protocol);
  }

  function noteUpdateHold(hold: unknown): void {
    const reason = typeof hold === 'string' && Object.hasOwn(UPDATE_HOLD_DETAILS, hold) ? hold : null;
    if (reason === lastUpdateHold) return;
    lastUpdateHold = reason;
    if (reason) runtime.logInfo(`bridge: the browser extension waits to update: ${UPDATE_HOLD_DETAILS[reason]}`);
  }

  return {
    get version(): string | null { return currentVersion; },
    noteUpdateHold,
    noteVersion,
    reset(): void {
      currentVersion = null;
      warnedProtocol = false;
      announcements.clear();
    }
  };
}
