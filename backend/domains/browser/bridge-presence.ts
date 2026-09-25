import type http from 'node:http';
import type { BridgeStatus } from '../../../contracts/types.js';
import type { WebProviderId } from '../../../contracts/web-providers.js';
import {
  clearWebProviderPresence,
  resetWebProviderPresence,
  webProviderPresenceTimestamps,
  WEB_PROVIDER_PRESENCE_TTL_MS
} from '../providers/presence.js';

type Runtime = {
  browserOf(req: http.IncomingMessage): string | null;
  browserWakeConnected(host?: string): boolean;
  changed(): void;
  externalBrowserProof(): { version: string } | null;
  noteExternalInstalled(browserId: string, version: string): boolean;
  serverRunning(): boolean;
  browserPresentMs: number;
};

type ExternalExtension = { seenAt: number | null; version: string | null; browserId?: string } | null;

export function createBridgePresence(runtime: Runtime) {
  let lastSeenAt: number | null = null;
  let browserPresenceTimer: ReturnType<typeof setTimeout> | null = null;
  let externalExtension: ExternalExtension = null;
  let integratedExtensionSeenAt: number | null = null;

  function browserPresent(): boolean {
    return runtime.serverRunning() && lastSeenAt !== null && Date.now() - lastSeenAt < runtime.browserPresentMs;
  }

  function integratedExtensionPresent(): boolean {
    return runtime.serverRunning() && ((integratedExtensionSeenAt !== null && Date.now() - integratedExtensionSeenAt < runtime.browserPresentMs) ||
      runtime.browserWakeConnected('integrated'));
  }

  function externalExtensionPresent(): boolean {
    return runtime.serverRunning() && externalExtension?.seenAt != null && Date.now() - externalExtension.seenAt < runtime.browserPresentMs;
  }

  function noteExternalExtension(req: http.IncomingMessage, host: 'integrated' | 'browser' | null): boolean {
    if (host === 'integrated') {
      const appeared = !integratedExtensionPresent();
      integratedExtensionSeenAt = Date.now();
      return appeared;
    }
    if (host !== 'browser') return false;
    const header = req.headers['x-extension-version'];
    const version = typeof header === 'string' ? header.slice(0, 32) : null;
    const browserId = runtime.browserOf(req) ?? undefined;
    const sameBrowser = browserId !== undefined && externalExtension?.browserId === browserId && externalExtensionPresent();
    const appeared = !sameBrowser || externalExtension?.version !== version;
    externalExtension = { ...(sameBrowser ? externalExtension : {}), seenAt: Date.now(), version, browserId };
    const proved = browserId !== undefined && version !== null && runtime.noteExternalInstalled(browserId, version);
    return appeared || proved;
  }

  function scheduleBrowserPresence(): void {
    if (browserPresenceTimer) clearTimeout(browserPresenceTimer);
    browserPresenceTimer = null;
    const now = Date.now();
    const deadlines = [lastSeenAt, externalExtension?.seenAt ?? null, integratedExtensionSeenAt]
      .map(at => at === null ? null : at + runtime.browserPresentMs)
      .concat(webProviderPresenceTimestamps().map(at => at === null ? null : at + WEB_PROVIDER_PRESENCE_TTL_MS))
      .filter((deadline): deadline is number => deadline !== null && deadline > now);
    if (!runtime.serverRunning() || deadlines.length === 0) return;
    browserPresenceTimer = setTimeout(() => {
      browserPresenceTimer = null;
      runtime.changed();
      scheduleBrowserPresence();
    }, Math.max(1, Math.min(...deadlines) - now + 1));
    browserPresenceTimer.unref?.();
  }

  function noteBrowserSeen(req: http.IncomingMessage, host: 'integrated' | 'browser' | null): boolean {
    const externalAppeared = noteExternalExtension(req, host);
    const wasPresent = browserPresent();
    lastSeenAt = Date.now();
    scheduleBrowserPresence();
    return !wasPresent || externalAppeared;
  }

  function externalExtensionStatus(): BridgeStatus['externalExtension'] {
    const proof = runtime.externalBrowserProof();
    if (!externalExtension && !proof) return null;
    return {
      present: externalExtensionPresent(),
      version: externalExtension?.version ?? null,
      lastSeenAt: externalExtension?.seenAt ?? null,
      proof: proof && { version: proof.version }
    };
  }

  function noteExtensionVersion(isExternal: boolean, version: string): boolean {
    if (!isExternal || externalExtension?.version === version) return false;
    externalExtension = { version, seenAt: null };
    return true;
  }

  function clearWebProviderStatus(provider: WebProviderId): boolean {
    if (!clearWebProviderPresence(provider)) return false;
    scheduleBrowserPresence();
    return true;
  }

  function clearObservations(): void {
    if (browserPresenceTimer) clearTimeout(browserPresenceTimer);
    browserPresenceTimer = null;
    lastSeenAt = null;
    resetWebProviderPresence();
    if (externalExtension) externalExtension.seenAt = null;
    integratedExtensionSeenAt = null;
  }

  function disconnect(): void {
    clearObservations();
    scheduleBrowserPresence();
  }

  function reset(): void {
    clearObservations();
    externalExtension = null;
  }

  return {
    browserPresent,
    clearObservations,
    clearWebProviderStatus,
    disconnect,
    externalExtensionPresent,
    externalExtensionStatus,
    get lastSeenAt() { return lastSeenAt; },
    integratedExtensionPresent,
    noteBrowserSeen,
    noteExtensionVersion,
    reset,
    scheduleBrowserPresence
  };
}
