import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSource(source, filenames) {
  if (!isRecord(source) || typeof source.file !== 'string' || !SAFE_FILENAME.test(source.file) || filenames.has(source.file)) {
    throw new Error(`Invalid or duplicate native source filename: ${source?.file}`);
  }
  filenames.add(source.file);

  let url;
  if (typeof source.url !== 'string') throw new Error(`Invalid native source URL: ${source.file}`);
  try {
    url = new URL(source.url);
  } catch {
    throw new Error(`Invalid native source URL: ${source.file}`);
  }
  if (url.protocol !== 'https:' || !SHA256.test(source.sha256) || !Number.isSafeInteger(source.bytes) ||
      source.bytes < 1 || source.bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`Incomplete native source identity: ${source.file}`);
  }
}

export async function loadNativeSourceInventory(root) {
  const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
  const inventoryPath = path.join(noticeDirectory, 'sources.json');
  const [inventoryText, lockText, componentNotices] = await Promise.all([
    fs.readFile(inventoryPath, 'utf8'),
    fs.readFile(path.join(root, 'package-lock.json'), 'utf8'),
    fs.readFile(path.join(noticeDirectory, 'COMPONENT-NOTICES.txt'))
  ]);
  const inventory = JSON.parse(inventoryText);
  const lock = JSON.parse(lockText);

  if (!isRecord(inventory) || !isRecord(inventory.packages) || !Array.isArray(inventory.sources) ||
      !SHA256.test(inventory.componentNoticesSha256)) {
    throw new Error('Native source inventory has an invalid shape');
  }
  const actualNoticeHash = createHash('sha256').update(componentNotices).digest('hex');
  if (actualNoticeHash !== inventory.componentNoticesSha256) {
    throw new Error('Native component notice bytes differ from the reviewed inventory');
  }

  if (!isRecord(lock) || !isRecord(lock.packages)) throw new Error('Native source package lock has an invalid shape');
  const lockedPackages = lock.packages;
  for (const [name, version] of Object.entries(inventory.packages)) {
    if (typeof version !== 'string' || lockedPackages[`node_modules/${name}`]?.version !== version) {
      throw new Error(`Native source review does not cover locked ${name}; expected ${version}`);
    }
  }

  const filenames = new Set();
  for (const source of inventory.sources) validateSource(source, filenames);
  return { inventory, noticeDirectory };
}
