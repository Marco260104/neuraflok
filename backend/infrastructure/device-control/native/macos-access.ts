import { logInfo, logWarn } from '../../settings/logger.js';
import type { MacOSDesktopAccessStatus, MacOSPermissionState } from '../../../../contracts/types.js';
import { runHelper } from './transport.js';

let macOSDesktopAccess: MacOSDesktopAccessStatus | null = null;
const macOSDesktopAccessListeners = new Set<(status: MacOSDesktopAccessStatus) => void>();
let macOSDesktopAccessRefreshGeneration = 0;

export function getMacOSDesktopAccess(): MacOSDesktopAccessStatus | null {
  return macOSDesktopAccess;
}

export function onMacOSDesktopAccessChange(
  listener: (status: MacOSDesktopAccessStatus) => void
): () => void {
  macOSDesktopAccessListeners.add(listener);
  return () => macOSDesktopAccessListeners.delete(listener);
}

function publishMacOSDesktopAccess(status: MacOSDesktopAccessStatus): void {
  macOSDesktopAccess = status;
  for (const listener of macOSDesktopAccessListeners) listener(status);
}

async function requestParentAccessibility(): Promise<void> {
  try {
    // Request the macOS accessibility prompt in the Electron process.
    const electron = await import('electron');
    electron.systemPreferences?.isTrustedAccessibilityClient(true);
  } catch {
    // The subsequent backend preflight remains authoritative and fail-closed.
  }
}

function nativePermission(value: unknown): MacOSPermissionState {
  return value === true ? 'granted' : value === false ? 'missing' : 'unknown';
}

export async function refreshMacOSDesktopAccess(
  options: { promptAccessibility?: boolean } = {}
): Promise<MacOSDesktopAccessStatus | null> {
  if (process.platform !== 'darwin') return null;
  const generation = ++macOSDesktopAccessRefreshGeneration;
  if (options.promptAccessibility === true) await requestParentAccessibility();
  try {
    const reply = await runHelper({ op: 'warm' });
    const status: MacOSDesktopAccessStatus = {
      screen: nativePermission(reply['screenPermission']),
      accessibility: nativePermission(reply['accessibilityPermission']),
      checkedAt: Date.now(),
      error: null
    };
    if (generation === macOSDesktopAccessRefreshGeneration) publishMacOSDesktopAccess(status);
    return generation === macOSDesktopAccessRefreshGeneration ? status : macOSDesktopAccess;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: MacOSDesktopAccessStatus = {
      screen: 'unknown',
      accessibility: 'unknown',
      checkedAt: Date.now(),
      error: message
    };
    if (generation === macOSDesktopAccessRefreshGeneration) publishMacOSDesktopAccess(status);
    return generation === macOSDesktopAccessRefreshGeneration ? status : macOSDesktopAccess;
  }
}

export async function prewarmComputerHelper(): Promise<void> {
  if (process.platform !== 'darwin') {
    try {
      await runHelper({ op: 'warm' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`computer use prewarm failed: ${message}`);
    }
    return;
  }
  const status = await refreshMacOSDesktopAccess();
  if (!status) return;
  if (status.error) {
    logWarn(`computer use prewarm failed: ${status.error}`);
    return;
  }
  logInfo(
    `desktop macos permissions screen=${status.screen} accessibility=${status.accessibility} execution=in-process`
  );
}
