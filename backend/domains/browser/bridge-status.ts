import type { BridgeStatus } from '../../../contracts/types.js';
import type { WebProviderPresenceMap } from '../../../contracts/web-providers.js';
import { readWebProviderPresence } from '../providers/presence.js';
import type { createBridgeExtensionHealth } from './bridge-extension-health.js';
import type { createBridgePresence } from './bridge-presence.js';
import type { WakeHost } from './browser-wake.js';

type BridgePresence = Pick<
  ReturnType<typeof createBridgePresence>,
  'lastSeenAt' | 'externalExtensionStatus' | 'integratedExtensionPresent' | 'browserPresent'
>;

type ExtensionHealth = Pick<ReturnType<typeof createBridgeExtensionHealth>, 'version'>;

export interface BridgeStatusRuntime {
  getToken(): Promise<string | null>;
  disconnectedToken: string;
  running(): boolean;
  portOverridden(): boolean;
  error(): string | null;
  port(): number | null;
  presence: BridgePresence;
  extensionHealth: ExtensionHealth;
  browserWakeConnected(host?: WakeHost): boolean;
}

export function createBridgeStatus(runtime: BridgeStatusRuntime) {
  function webProvidersStatus(): WebProviderPresenceMap {
    return readWebProviderPresence(runtime.running());
  }

  function browserPresent(): boolean {
    return runtime.presence.browserPresent();
  }

  async function bridgeStatus(): Promise<BridgeStatus> {
    const stored = await runtime.getToken();
    return {
      running: runtime.running(),
      portOverridden: runtime.portOverridden(),
      error: runtime.error(),
      port: runtime.port(),
      paired: stored !== null && stored !== runtime.disconnectedToken,
      present: browserPresent() || runtime.browserWakeConnected(),
      lastSeenAt: runtime.presence.lastSeenAt,
      extensionVersion: runtime.extensionHealth.version,
      externalExtension: runtime.presence.externalExtensionStatus(),
      integratedExtension: { present: runtime.presence.integratedExtensionPresent() },
      webProviders: webProvidersStatus()
    };
  }

  return {
    bridgeStatus,
    webProvidersStatus,
    browserPresent
  };
}
