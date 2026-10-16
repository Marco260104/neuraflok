import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FINGERPRINT_FILE = 'build-stamp.txt';

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function collectExtensionAssets(root) {
  const assets = [];
  const visit = (directory, prefix = '') => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile() && relativePath !== FINGERPRINT_FILE && !relativePath.endsWith('.d.ts')) assets.push(relativePath);
    }
  };
  visit(root);
  return assets;
}

function updateLength(hash, value) {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value));
  hash.update(length);
}

export function createExtensionFingerprint(root) {
  const hash = createHash('sha256');
  hash.update('NEURAFLOK-BROWSER-EXTENSION\0v1\0', 'utf8');
  for (const relativePath of collectExtensionAssets(root)) {
    const pathBytes = Buffer.from(relativePath, 'utf8');
    const content = readFileSync(path.join(root, ...relativePath.split('/')));
    updateLength(hash, pathBytes.length);
    hash.update(pathBytes);
    updateLength(hash, content.length);
    hash.update(content);
  }
  return hash.digest('hex').slice(0, 12);
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(currentDirectory, '..', '..', 'browser-extension');
const currentModule = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  const fingerprint = createExtensionFingerprint(extensionDirectory);
  const assets = collectExtensionAssets(extensionDirectory);
  writeFileSync(path.join(extensionDirectory, FINGERPRINT_FILE), `${fingerprint}\n`, 'utf8');
  console.log(`browser extension fingerprint: ${fingerprint} across ${assets.length} files`);
}
