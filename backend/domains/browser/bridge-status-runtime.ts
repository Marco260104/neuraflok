import type http from 'node:http';
import type { WebProviderId, WebProviderPresenceMap } from '../../../contracts/web-providers.js';
import { clearCompanionDiagnostics } from './companion-diagnostics.js';
import { createBridgeBrowserCredentials } from './bridge-browser-credentials.js';
import { createBridgeExtensionHealth } from './bridge-extension-health.js';
import { createBridgePresence } from './bridge-presence.js';
import { createBridgeStatus } from './bridge-status.js';
import type { createBridgeCompanionClients } from './bridge-companion-clients.js';
import type { WakeHost } from './browser-wake.js';
import { externalBrowserProof, noteExternalInstalled } from './browser-proof.js';
import { browserControl } from './control/index.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { getSecret, setSecret } from '../../infrastructure/settings/secrets.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../../infrastructure/settings/version.js';

export interface BridgeStatusRuntimeDependencies {
  browserWakeConnected(host?: WakeHost): boolean;
  companionClients: ReturnType<typeof createBridgeCompanionClients>;
  disconnectedToken: string;
  error(): string | null;
  extensionProtocol(request: http.IncomingMessage): number | null;
  getPort(): number | null;
  browserPresentMs: number;
  portOverridden(): boolean;
  revokeBrowserWake(): void;
  running(): boolean;
  shippedExtensionBuild(): string | null;
}

export function createBridgeStatusRuntime(dependencies: BridgeStatusRuntimeDependencies) {
  const listeners = new Set<() => void>();
  const {
    browserOf,
    extensionBuildOf,
    noteExtensionBuild
  } = dependencies.companionClients;
  const { browserWakeConnected } = dependencies;

  function changed(): void {
    for (const listener of listeners) listener();
  }

  function onBridgeChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const bridgePresence = createBridgePresence({
    browserOf,
    browserWakeConnected,
    changed,
    externalBrowserProof,
    noteExternalInstalled,
    serverRunning: dependencies.running,
    browserPresentMs: dependencies.browserPresentMs
  });
  const browserCredentials = createBridgeBrowserCredentials({
    disconnectedToken: dependencies.disconnectedToken,
    setSecret,
    disconnectBrowser: () => {
      bridgePresence.disconnect();
      clearCompanionDiagnostics();
      dependencies.revokeBrowserWake();
      browserControl.reset();
    },
    logInfo,
    changed
  });
  const extensionHealth = createBridgeExtensionHealth({
    appVersion: APP_VERSION,
    bridgeProtocol: BRIDGE_PROTOCOL,
    changed,
    extensionBuildOf,
    extensionProtocol: dependencies.extensionProtocol,
    logInfo,
    logWarn,
    noteExtensionBuild,
    noteExternalVersion: (isExternalBrowser, version) => bridgePresence.noteExtensionVersion(isExternalBrowser, version),
    shippedExtensionBuild: dependencies.shippedExtensionBuild
  });
  const statusQueries = createBridgeStatus({
    getToken: () => getSecret('bridgeToken'),
    disconnectedToken: dependencies.disconnectedToken,
    running: dependencies.running,
    portOverridden: dependencies.portOverridden,
    error: dependencies.error,
    port: dependencies.getPort,
    presence: bridgePresence,
    extensionHealth,
    browserWakeConnected
  });

  function extensionHost(request: http.IncomingMessage): 'integrated' | 'browser' | null {
    const value = request.headers['x-extension-host'];
    if (value === 'integrated') return 'integrated';
    return value === 'browser' ? 'browser' : null;
  }

  function noteBrowserSeen(request: http.IncomingMessage): boolean {
    return bridgePresence.noteBrowserSeen(request, extensionHost(request));
  }

  return {
    bridgePresence,
    browserCredentials,
    browserPresent: statusQueries.browserPresent,
    bridgeStatus: statusQueries.bridgeStatus,
    changed,
    clearWebProviderStatus(provider: WebProviderId): void {
      if (!bridgePresence.clearWebProviderStatus(provider)) return;
      changed();
    },
    extensionHealth,
    extensionHost,
    noteBrowserSeen,
    noteExtensionUpdateHold: extensionHealth.noteUpdateHold,
    onBridgeChange,
    scheduleBrowserPresence: bridgePresence.scheduleBrowserPresence,
    unpair: browserCredentials.unpair,
    webProvidersStatus(): WebProviderPresenceMap {
      return statusQueries.webProvidersStatus();
    }
  };
}
