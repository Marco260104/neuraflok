export const SUPPORTED_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
export const SUPPORTED_ARCHES = Object.freeze(['x64', 'arm64']);

const PLATFORM_ALIASES = new Map([
  ['win', 'win32'],
  ['windows', 'win32'],
  ['win32', 'win32'],
  ['mac', 'darwin'],
  ['macos', 'darwin'],
  ['darwin', 'darwin'],
  ['linux', 'linux']
]);

const PLATFORM_RECORDS = {
  win32: { builderFlag: '--win', upstreamOs: 'windows', displayName: 'Windows', executableSuffix: '.exe', unpackedPrefix: 'win' },
  darwin: { builderFlag: '--mac', upstreamOs: 'darwin', displayName: 'macOS', executableSuffix: '', unpackedPrefix: 'mac' },
  linux: { builderFlag: '--linux', upstreamOs: 'linux', displayName: 'Linux', executableSuffix: '', unpackedPrefix: 'linux' }
};

export const PLATFORM_INFO = Object.freeze(Object.fromEntries(
  Object.entries(PLATFORM_RECORDS).map(([platform, details]) => [platform, Object.freeze(details)])
));

export function normalizePlatform(value = process.platform) {
  const normalized = PLATFORM_ALIASES.get(String(value).toLowerCase());
  if (!normalized) {
    throw new Error(`Unsupported packaging platform ${value}; expected ${SUPPORTED_PLATFORMS.join(', ')}`);
  }
  return normalized;
}

export function normalizeArch(value = process.arch) {
  const arch = String(value).toLowerCase();
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`Unsupported packaging architecture ${value}; expected ${SUPPORTED_ARCHES.join(', ')}`);
  }
  return arch;
}
