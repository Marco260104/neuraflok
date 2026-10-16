import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadNativeSourceInventory } from '../scripts/native-sources/source-inventory.mjs';
import { downloadVerifiedArchive, prepareVerifiedArchives } from '../scripts/native-sources/source-archive-cache.mjs';
import { createNativeSourceArchive } from '../scripts/native-sources/source-release.mjs';

let temporaryDirectory: string | undefined;

async function makeTemporaryDirectory(): Promise<string> {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'neuraflok-native-sources-'));
  return temporaryDirectory;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe('native source inventory', () => {
  it('checks pinned packages and component notice bytes', async () => {
    const root = await makeTemporaryDirectory();
    const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
    await fs.mkdir(noticeDirectory, { recursive: true });
    const notices = Buffer.from('component notices');
    await fs.writeFile(path.join(noticeDirectory, 'COMPONENT-NOTICES.txt'), notices);
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/example-package': { version: '1.2.3' } }
    }));
    await fs.writeFile(path.join(noticeDirectory, 'sources.json'), JSON.stringify({
      componentNoticesSha256: sha256(notices),
      packages: { 'example-package': '1.2.3' },
      sources: [{ file: 'example.tar.gz', url: 'https://example.com/source.tar.gz', sha256: 'a'.repeat(64), bytes: 1 }]
    }));

    const loaded = await loadNativeSourceInventory(root);

    expect(loaded.inventory.sources).toHaveLength(1);
    expect(loaded.noticeDirectory).toBe(noticeDirectory);
  });

  it('rejects inventory paths that could escape the archive directory', async () => {
    const root = await makeTemporaryDirectory();
    const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
    await fs.mkdir(noticeDirectory, { recursive: true });
    const notices = Buffer.from('component notices');
    await fs.writeFile(path.join(noticeDirectory, 'COMPONENT-NOTICES.txt'), notices);
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
    await fs.writeFile(path.join(noticeDirectory, 'sources.json'), JSON.stringify({
      componentNoticesSha256: sha256(notices),
      packages: {},
      sources: [{ file: '../escape.tar.gz', url: 'https://example.com/source.tar.gz', sha256: 'a'.repeat(64), bytes: 1 }]
    }));

    await expect(loadNativeSourceInventory(root)).rejects.toThrow(/filename/i);
  });

  it('rejects a source inventory that does not match the package lock', async () => {
    const root = await makeTemporaryDirectory();
    const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
    await fs.mkdir(noticeDirectory, { recursive: true });
    const notices = Buffer.from('component notices');
    await fs.writeFile(path.join(noticeDirectory, 'COMPONENT-NOTICES.txt'), notices);
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
    await fs.writeFile(path.join(noticeDirectory, 'sources.json'), JSON.stringify({
      componentNoticesSha256: sha256(notices),
      packages: { 'example-package': '1.2.3' },
      sources: []
    }));

    await expect(loadNativeSourceInventory(root)).rejects.toThrow(/does not cover locked/i);
  });

  it('rejects a malformed package lock', async () => {
    const root = await makeTemporaryDirectory();
    const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
    await fs.mkdir(noticeDirectory, { recursive: true });
    const notices = Buffer.from('component notices');
    await fs.writeFile(path.join(noticeDirectory, 'COMPONENT-NOTICES.txt'), notices);
    await fs.writeFile(path.join(root, 'package-lock.json'), 'null');
    await fs.writeFile(path.join(noticeDirectory, 'sources.json'), JSON.stringify({
      componentNoticesSha256: sha256(notices),
      packages: {},
      sources: []
    }));

    await expect(loadNativeSourceInventory(root)).rejects.toThrow(/package lock has an invalid shape/i);
  });
});

describe('verified native source cache', () => {
  it('downloads once, validates the pinned bytes, and reuses the verified cache', async () => {
    const directory = await makeTemporaryDirectory();
    const bytes = Buffer.from('pinned source');
    const source = { file: 'source.tar.gz', url: 'https://example.com/source.tar.gz', sha256: sha256(bytes), bytes: bytes.length };
    const fetchSource = vi.fn(async () => new Response(bytes));

    const first = await downloadVerifiedArchive(source, directory, fetchSource);
    const second = await downloadVerifiedArchive(source, directory, fetchSource);

    expect(first).toEqual(bytes);
    expect(second).toEqual(bytes);
    expect(fetchSource).toHaveBeenCalledTimes(1);
  });

  it('does not cache a source whose digest differs from the inventory', async () => {
    const directory = await makeTemporaryDirectory();
    const source = { file: 'source.tar.gz', url: 'https://example.com/source.tar.gz', sha256: 'a'.repeat(64), bytes: 6 };
    const fetchSource = vi.fn(async () => new Response(Buffer.from('source')));

    await expect(downloadVerifiedArchive(source, directory, fetchSource)).rejects.toThrow(/checksum mismatch/i);
    await expect(fs.access(path.join(directory, source.file))).rejects.toThrow();
  });

  it('refuses non-HTTPS source locations before making a request', async () => {
    const directory = await makeTemporaryDirectory();
    const fetchSource = vi.fn();
    const source = { file: 'source.tar.gz', url: 'http://example.com/source.tar.gz', sha256: 'a'.repeat(64), bytes: 1 };

    await expect(downloadVerifiedArchive(source, directory, fetchSource)).rejects.toThrow(/invalid native source/i);
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it('limits concurrent downloads and reports verified progress', async () => {
    const directory = await makeTemporaryDirectory();
    const bytes = Buffer.from('src');
    const sources = ['a.tar.gz', 'b.tar.gz', 'c.tar.gz'].map(file => ({
      file, url: `https://example.com/${file}`, sha256: sha256(bytes), bytes: bytes.length
    }));
    let active = 0;
    let peak = 0;
    const fetchSource = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return new Response(bytes);
    });
    const onVerified = vi.fn();

    const completed = await prepareVerifiedArchives(sources, directory, { concurrency: 2, fetchSource, onVerified });

    expect(completed).toBe(3);
    expect(peak).toBeLessThanOrEqual(2);
    expect(onVerified).toHaveBeenCalledTimes(3);
  });

  it('stops assigning new downloads after a worker fails', async () => {
    const directory = await makeTemporaryDirectory();
    const bytes = Buffer.from('src');
    const sources = ['a.tar.gz', 'b.tar.gz', 'c.tar.gz'].map(file => ({
      file, url: `https://example.com/${file}`, sha256: sha256(bytes), bytes: bytes.length
    }));
    const fetchSource = vi.fn(async () => { throw new Error('offline'); });

    await expect(prepareVerifiedArchives(sources, directory, { concurrency: 1, fetchSource })).rejects.toThrow('offline');
    expect(fetchSource).toHaveBeenCalledTimes(1);
  });

  it('aborts active downloads and leaves later sources unassigned after a worker fails', async () => {
    const directory = await makeTemporaryDirectory();
    const bytes = Buffer.from('src');
    const sources = ['a.tar.gz', 'b.tar.gz', 'c.tar.gz'].map(file => ({
      file, url: `https://example.com/${file}`, sha256: sha256(bytes), bytes: bytes.length
    }));
    let signalSecondRequest!: () => void;
    const secondRequestStarted = new Promise<void>(resolve => { signalSecondRequest = resolve; });
    const fetchSource = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.endsWith('/a.tar.gz')) {
        await secondRequestStarted;
        throw new Error('offline');
      }
      if (url.endsWith('/b.tar.gz')) {
        signalSecondRequest();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return new Response(bytes);
    });

    await expect(prepareVerifiedArchives(sources, directory, { concurrency: 2, fetchSource })).rejects.toThrow();
    expect(fetchSource).toHaveBeenCalledTimes(2);
  });
});

describe('native source release archive', () => {
  it('packages only manifest entries and includes checksums and license files', async () => {
    const root = await makeTemporaryDirectory();
    const noticeDirectory = path.join(root, 'docs', 'licenses', 'native');
    const archiveDirectory = path.join(root, 'release', 'native-sources', 'archives');
    await fs.mkdir(noticeDirectory, { recursive: true });
    await fs.mkdir(archiveDirectory, { recursive: true });
    const noticeFiles = ['sources.json', 'README.md', 'SOURCE-BUILD.md', 'COMPONENT-NOTICES.txt', 'LGPL-3.0.txt', 'GPL-3.0.txt', 'MPL-2.0.txt'];
    for (const filename of noticeFiles) await fs.writeFile(path.join(noticeDirectory, filename), filename);
    const sampleBytes = Buffer.from('pinned source');
    await fs.writeFile(path.join(archiveDirectory, 'sample.tar.gz'), sampleBytes);
    await fs.writeFile(path.join(archiveDirectory, 'stale.tar.gz'), 'must stay out');
    const inventory = {
      componentNoticesSha256: 'a'.repeat(64),
      packages: {},
      sources: [{ file: 'sample.tar.gz', url: 'https://example.com/sample.tar.gz', sha256: sha256(sampleBytes), bytes: sampleBytes.length }]
    };

    const archivePath = await createNativeSourceArchive(root, noticeDirectory, inventory);
    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const listing = spawnSync(tar, ['-tzf', archivePath], { encoding: 'utf8', windowsHide: true });

    expect(listing.error).toBeUndefined();
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain('SHA256SUMS.txt');
    expect(listing.stdout).toContain('archives/sample.tar.gz');
    expect(listing.stdout).not.toContain('stale.tar.gz');
    expect(await fs.readFile(path.join(root, 'release', 'native-sources', 'SHA256SUMS.txt'), 'utf8'))
      .toBe(`${sha256(sampleBytes)}  archives/sample.tar.gz\n`);
    for (const filename of noticeFiles) expect(listing.stdout).toContain(filename);
  });
});
