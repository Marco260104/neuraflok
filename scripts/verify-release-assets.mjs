import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';

/** The files release.yml publishes, in its SHA256SUMS.txt order. */
export const RELEASE_FILES = [
  'NEURAFLOK-Setup-x64.exe',
  'NEURAFLOK-Setup-arm64.exe',
  'NEURAFLOK-macOS-x64.dmg',
  'NEURAFLOK-macOS-x64.zip',
  'NEURAFLOK-macOS-arm64.dmg',
  'NEURAFLOK-macOS-arm64.zip',
  'NEURAFLOK-Linux-x64.AppImage',
  'NEURAFLOK-Linux-x64.deb',
  'NEURAFLOK-Linux-arm64.AppImage',
  'NEURAFLOK-Linux-arm64.deb',
  'NEURAFLOK-Provider-Extension.zip',
  'NEURAFLOK-Native-Sources.tar.gz'
];
const PROVIDER_EXTENSION = 'NEURAFLOK-Provider-Extension.zip';

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** Validate published files, checksums, and the provider extension version stamp. */
export async function verifyReleaseAssets({ dir, tag }) {
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  if (!existsSync(sumsFile)) return ['SHA256SUMS.txt is missing from the release.'];
  const sums = new Map(readFileSync(sumsFile, 'utf8').split('\n').map(line => line.trim().split(/\s+\*?/)).filter(parts => parts.length === 2)
    .map(([hash, name]) => [name, hash.toLowerCase()]));
  const problems = [];
  for (const name of RELEASE_FILES) {
    const file = path.join(dir, name);
    if (!existsSync(file)) { problems.push(`${name} is missing from the release.`); continue; }
    if (!sums.has(name)) { problems.push(`${name} is not listed in SHA256SUMS.txt.`); continue; }
    if (await sha256(file) !== sums.get(name)) problems.push(`${name} does not match its SHA256SUMS.txt checksum.`);
  }
  const wanted = tag.replace(/^v/, '');
  const extension = path.join(dir, PROVIDER_EXTENSION);
  if (existsSync(extension)) {
    const entries = unzipSync(readFileSync(extension));
    const stamp = entries['build-stamp.txt'] ? strFromU8(entries['build-stamp.txt']).trim() : '';
    if (!stamp) problems.push(`${PROVIDER_EXTENSION} is missing build-stamp.txt.`);
    const manifest = entries['manifest.json'] ? JSON.parse(strFromU8(entries['manifest.json'])) : null;
    const version = manifest?.version ?? null;
    if (version !== wanted) problems.push(`The browser extension in ${PROVIDER_EXTENSION} is version ${version ?? 'unknown'}, not ${wanted}.`);
  }
  return problems;
}

async function main() {
  const [dir, tag, report] = process.argv.slice(2);
  if (!dir || !tag) throw new Error('Usage: node scripts/verify-release-assets.mjs <folder> <tag> [report.md]');
  const problems = await verifyReleaseAssets({ dir, tag });
  if (report) writeFileSync(report, problems.map(problem => `- ${problem}`).join('\n') + '\n');
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else console.log(`${tag}: all ${RELEASE_FILES.length} files match SHA256SUMS.txt and the provider extension is the tagged build.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
