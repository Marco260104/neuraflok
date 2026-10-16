import { normalizeArch, normalizePlatform, PLATFORM_INFO } from './target-platforms.mjs';

const SHARP_PACKAGES = Object.freeze({
  win32: arch => [`@img/sharp-win32-${arch}`],
  darwin: arch => [`@img/sharp-darwin-${arch}`, `@img/sharp-libvips-darwin-${arch}`],
  linux: arch => [`@img/sharp-linux-${arch}`, `@img/sharp-libvips-linux-${arch}`]
});

export function sharpPackagesFor(platformValue, archValue) {
  const platform = normalizePlatform(platformValue);
  const arch = normalizeArch(archValue);
  return SHARP_PACKAGES[platform](arch);
}

export function nativePrebuildDir(platformValue, archValue) {
  return [normalizePlatform(platformValue), normalizeArch(archValue)].join('-');
}

export function tarExecutableForPlatform(platformValue = process.platform) {
  return normalizePlatform(platformValue) === 'win32' ? 'tar.exe' : 'tar';
}

export function unpackedDirectoryPattern(platformValue) {
  const platform = normalizePlatform(platformValue);
  const family = PLATFORM_INFO[platform].unpackedPrefix;
  const suffix = platform === 'darwin' ? '' : '-unpacked';
  return new RegExp(`^${family}(?:-[a-z0-9]+)?${suffix}$`, 'i');
}
