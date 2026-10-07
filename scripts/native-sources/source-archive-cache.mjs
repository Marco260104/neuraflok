import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const SAFE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function verifyArchive(bytes, source) {
  if (bytes.length !== source.bytes) throw new Error(`Native source size mismatch: ${source.file}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== source.sha256) throw new Error(`Native source checksum mismatch: ${source.file}`);
  return bytes;
}

async function downloadArchive(source, fetchSource, signal) {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchSource(source.url, { signal: requestSignal });
  if (!response.ok) throw new Error(`Native source download failed: ${source.file}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`Native source response was empty: ${source.file}`);

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > source.bytes) throw new Error(`Native source exceeds reviewed size: ${source.file}`);
    chunks.push(bytes);
  }
  return verifyArchive(Buffer.concat(chunks), source);
}

export async function downloadVerifiedArchive(source, archivesDirectory, fetchSource = globalThis.fetch, signal) {
  let sourceUrl;
  try {
    sourceUrl = new URL(source.url);
  } catch {
    throw new Error(`Invalid native source URL: ${source?.file}`);
  }
  if (!SAFE_FILENAME.test(source.file) || sourceUrl.protocol !== 'https:' || !SHA256.test(source.sha256) ||
      !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`Invalid native source identity: ${source?.file}`);
  }
  if (typeof fetchSource !== 'function') throw new Error('A native source downloader is required');

  await fs.mkdir(archivesDirectory, { recursive: true });
  const destination = path.join(archivesDirectory, source.file);
  let cached;
  try {
    cached = await fs.readFile(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (cached) return verifyArchive(cached, source);

  const bytes = await downloadArchive(source, fetchSource, signal);
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
    await fs.rename(temporaryPath, destination);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  return bytes;
}

export async function prepareVerifiedArchives(sources, archivesDirectory, options = {}) {
  const concurrency = options.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error('Native source download concurrency must be between 1 and 32');
  }

  let nextIndex = 0;
  let completed = 0;
  let failed = false;
  const controller = new AbortController();
  const workerCount = Math.min(concurrency, sources.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!failed && nextIndex < sources.length) {
      const source = sources[nextIndex++];
      try {
        await downloadVerifiedArchive(source, archivesDirectory, options.fetchSource, controller.signal);
        completed++;
        options.onVerified?.(completed, sources.length, source);
      } catch (error) {
        failed = true;
        if (!controller.signal.aborted) controller.abort(error);
        throw error;
      }
    }
  }));
  return completed;
}
