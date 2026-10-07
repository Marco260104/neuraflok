import { normalizeArch, normalizePlatform } from './target-platforms.mjs';

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Packaging option ${name} requires a value.`);
  return value;
}

export function parseDesktopBuildOptions(argv = process.argv.slice(2), defaults = {}) {
  let platform = defaults.platform ?? process.platform;
  let architectureList = defaults.architectureList ?? process.arch;
  let directoryOnly = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dir') {
      directoryOnly = true;
      continue;
    }

    const separator = argument.indexOf('=');
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (name !== '--platform' && name !== '--arch') continue;

    const value = separator < 0
      ? readValue(argv, index++, argument)
      : argument.slice(separator + 1);
    if (!value) throw new Error(`Packaging option ${name} requires a value.`);
    if (name === '--platform') platform = value;
    else architectureList = value;
  }

  return {
    platform: normalizePlatform(platform),
    architectures: architectureList.split(',').map(value => normalizeArch(value.trim())),
    directoryOnly
  };
}
