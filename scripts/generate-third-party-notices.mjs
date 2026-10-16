import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = [
  'NEURAFLOK — Third-party Notices',
  '',
  'NEURAFLOK application source is MIT licensed. Third-party dependencies, frameworks, and native',
  'components retain their own terms; see LICENSE, NOTICE, and the inventory below.',
  'This inventory preserves the license and notice texts',
  'of the production npm components present when this build was prepared. Platform-specific',
  'Electron/Chromium, native image libraries and ripgrep notices also accompany',
  'their respective packaged binaries. Optional packages for other targets are supplied by',
  'the packaging pipeline together with their notices.',
  '',
  ''
];
const missing = [];
notices.push('='.repeat(80), 'NEURAFLOK project license and notice', '');
for (const file of ['LICENSE', 'NOTICE']) {
  notices.push(`--- ${file} ---`, await fs.readFile(path.join(root, file), 'utf8'), '');
}
notices.push('='.repeat(80), 'Phosphor Icons — interface icons (Regular and Fill weights)',
  'Source: https://www.npmjs.com/package/@phosphor-icons/core/v/2.1.1',
  'NEURAFLOK uses the bundled Phosphor icon font for interface icons.', '');
notices.push('--- Phosphor LICENSE ---', await fs.readFile(path.join(root, 'docs/licenses/phosphor/LICENSE'), 'utf8'), '');
let count = 0;
for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!relative || entry.dev === true) continue;
  const directory = path.join(root, relative);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (entry.optional && error.code === 'ENOENT') continue; throw new Error(`Missing or invalid production dependency: ${relative}`); }
  if (manifest.version !== entry.version) throw new Error(`Production dependency version differs from lockfile: ${relative}`);
  const files = [];
  // Include nested notices without attributing a nested dependency to its parent package.
  async function walk(folder, depth = 0) {
    for (const item of await fs.readdir(folder, { withFileTypes: true })) {
      if (item.isDirectory() && !['node_modules', '.git'].includes(item.name) && depth < 4) await walk(path.join(folder, item.name), depth + 1);
      else if (item.isFile() && /^(licen[sc]e|notice|copying|copyright)([._-].*)?$/i.test(item.name)) files.push(path.join(folder, item.name));
    }
  }
  await walk(directory);
  if (manifest.name === 'flora-colossus' && !files.length) files.push(path.join(root, 'docs/licenses/flora-colossus-LICENSE'));
  if (manifest.name.startsWith('@napi-rs/canvas-') && !files.length) {
    // Preserve the upstream MIT license omitted from platform binary package archives.
    files.push(path.join(root, 'docs/licenses/napi-rs-canvas-LICENSE'));
  }
  if (manifest.name.startsWith('@img/')) {
    // libvips distributions publish their composite attribution in README.md.
    try { await fs.access(path.join(directory, 'README.md')); files.push(path.join(directory, 'README.md')); } catch {}
  }
  if (!files.length) missing.push(`${manifest.name}@${manifest.version}`);
  const license = typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? manifest.licenses ?? 'Not declared');
  notices.push('='.repeat(80), `${manifest.name}@${manifest.version}`, `Declared license: ${license}`, `Package: https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`, '');
  for (const file of files.sort()) notices.push(`--- ${file.startsWith(directory + path.sep) ? path.relative(directory, file).replaceAll('\\', '/') : 'Upstream license supplement (see docs/licenses/README.md)'} ---`, await fs.readFile(file, 'utf8'), '');
  count++;
}
if (missing.length) throw new Error(`Missing license texts for production packages: ${missing.join(', ')}`);
notices.push('='.repeat(80), 'Native image-library license supplements', 'The following texts accompany the LGPL/MPL components listed in the platform-specific sharp/libvips notices. They do not replace component copyright notices or corresponding-source obligations.', '');
for (const file of ['README.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt']) {
  notices.push(`--- ${file} ---`, await fs.readFile(path.join(root, 'docs/licenses/native', file), 'utf8'), '');
}
// Check platform-specific notice output on the host that generated it.
if (!process.argv.includes('--check')) await fs.writeFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
console.log(`Validated license notices for ${count} production packages.`);
