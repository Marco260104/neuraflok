import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertReleaseAbsent } from '../check-release-absent.mjs';

function versionFromFile(file, pattern, label) {
  const match = pattern.exec(readFileSync(file, 'utf8'));
  if (!match) throw new Error(`${label} version could not be read.`);
  return match[1];
}

export async function validateRelease({ root = process.cwd(), environment = process.env, checkReleaseAbsent = assertReleaseAbsent } = {}) {
  const tag = environment.CIRCLE_TAG || environment.TAG;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error(`Expected a stable vX.Y.Z tag, got ${tag || '(missing)'}.`);

  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  const version = pkg.version;
  const targetVersion = tag.slice(1);
  const appVersion = versionFromFile(`${root}/backend/infrastructure/settings/version.ts`, /APP_VERSION = '([^']+)'/, 'Application');
  const extensionVersion = JSON.parse(readFileSync(`${root}/browser-extension/manifest.json`, 'utf8')).version;
  const changelogVersion = versionFromFile(`${root}/CHANGELOG.md`, /^## \[(\d+\.\d+\.\d+)\]/m, 'Changelog');
  if ([version, appVersion, extensionVersion, changelogVersion].some(value => value !== targetVersion)) {
    throw new Error(`Release versions do not match ${tag}: package=${version}, app=${appVersion}, extension=${extensionVersion}, changelog=${changelogVersion}.`);
  }
  const notesFile = `${root}/docs/release-notes/${tag}.md`;
  const notes = readFileSync(notesFile, 'utf8');
  if (!/^## .+$/m.test(notes)) throw new Error(`${notesFile} has no release title.`);

  await checkReleaseAbsent({
    repository: environment.NEURAFLOK_REPOSITORY || 'Marco260104/neuraflok',
    tag,
    token: environment.GH_TOKEN
  });
  return { tag, version, notesFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateRelease().then(({ tag }) => process.stdout.write(`Release ${tag}: version metadata is aligned and no published release uses the tag.\n`))
    .catch(error => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
