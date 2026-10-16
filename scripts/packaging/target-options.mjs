import { normalizeArch, normalizePlatform } from './target-platforms.mjs';

const OPTION_NAMES = new Map([
  ['--platform', 'platform'],
  ['--arch', 'arch']
]);

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Packaging option ${name} requires a value.`);
  return value;
}

export function parseTarget(argv = process.argv.slice(2)) {
  const selected = { platform: process.platform, arch: process.arch };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const option = OPTION_NAMES.get(argument);
    if (option) {
      selected[option] = optionValue(argv, index, argument);
      index++;
      continue;
    }

    const separator = argument.indexOf('=');
    if (separator < 0) continue;
    const inlineOption = OPTION_NAMES.get(argument.slice(0, separator));
    if (inlineOption) selected[inlineOption] = argument.slice(separator + 1);
  }

  return {
    platform: normalizePlatform(selected.platform),
    arch: normalizeArch(selected.arch)
  };
}
