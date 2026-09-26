import os from 'node:os';
import { DESKTOP_CAPABILITIES, type Capabilities, type PlatformInfo } from '../../../contracts/types.js';

type DesktopSupportPolicy = 'available' | 'unavailable' | 'macos-versioned';

interface PlatformPolicy {
  family: PlatformInfo['family'];
  name: string;
  desktopSupport: DesktopSupportPolicy;
}

const PLATFORM_POLICIES: Partial<Record<NodeJS.Platform, PlatformPolicy>> = {
  win32: { family: 'windows', name: 'Windows', desktopSupport: 'available' },
  darwin: { family: 'macos', name: 'macOS', desktopSupport: 'macos-versioned' },
  linux: { family: 'linux', name: 'Linux', desktopSupport: 'unavailable' }
};

const MINIMUM_MACOS_DARWIN_VERSION = [21, 4] as const;
const BROWSER_DESKTOP_CAPABILITIES = new Set(['screen', 'control']);
const NATIVE_DESKTOP_CAPABILITIES = DESKTOP_CAPABILITIES.filter(
  capability => !BROWSER_DESKTOP_CAPABILITIES.has(capability)
);

/** ScreenCaptureKit is present from macOS 12.3 (Darwin 21.4). */
export function macOSDesktopAutomationSupported(release: string): boolean {
  const [major = 0, minor = 0] = release.split('.').map(part => Number.parseInt(part, 10) || 0);
  const [minimumMajor, minimumMinor] = MINIMUM_MACOS_DARWIN_VERSION;
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

export function desktopAutomationSupported(
  platform: NodeJS.Platform = process.platform,
  release?: string
): boolean {
  const policy = PLATFORM_POLICIES[platform]?.desktopSupport;
  if (policy === 'available') return true;
  if (policy !== 'macos-versioned') return false;

  const version = release ?? (platform === process.platform ? os.release() : undefined);
  return version === undefined || macOSDesktopAutomationSupported(version);
}

export function hostPlatformInfo(
  platform: NodeJS.Platform = process.platform,
  release?: string
): PlatformInfo {
  const policy = PLATFORM_POLICIES[platform];
  return {
    family: policy?.family ?? 'other',
    name: policy?.name ?? platform,
    desktopAutomation: desktopAutomationSupported(platform, release)
  };
}

/** Preserve browser controls while disabling native desktop capabilities on unsupported systems. */
export function capabilitiesForPlatform(
  capabilities: Capabilities,
  platform: NodeJS.Platform = process.platform,
  release?: string
): Capabilities {
  if (desktopAutomationSupported(platform, release)) return capabilities;

  const projected = { ...capabilities };
  for (const capability of NATIVE_DESKTOP_CAPABILITIES) projected[capability] = false;
  return projected;
}
