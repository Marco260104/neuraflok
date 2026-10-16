import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';

let base: string | null = null;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const originalExecPath = process.execPath;

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock('electron');
  if (base) await removeTempDir(base);
  base = null;
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: originalResourcesPath
  });
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    value: originalExecPath
  });
});

it('materializes a packaged extension into a stable per-user folder', async () => {
  base = await makeTempDir('clf-extension-path-');
  const resources = path.join(base, 'ephemeral-appimage-mount', 'resources');
  const bundled = path.join(resources, 'browser-extension');
  const userData = path.join(base, 'user-data');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'current package');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'icon');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../backend/domains/browser/extension-path.js');
  const first = extensionDir();
  expect(first).toBe(path.join(userData, 'extension'));
  expect(first).not.toContain('ephemeral-appimage-mount');
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('current package');
  expect(await fs.readFile(path.join(first!, 'icons', 'icon128.png'), 'utf8')).toBe('icon');
  const publishedInode = (await fs.stat(first!)).ino;

  // An app update refreshes the integrated browser companion at the same stable path.
  await fs.writeFile(path.join(bundled, 'background.js'), 'updated package');
  expect(extensionDir()).toBe(first);
  expect((await fs.stat(first!)).ino).toBe(publishedInode);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');

  // Retain the last known-good browser copy if a later packaged source is damaged.
  await fs.rm(path.join(bundled, 'manifest.json'));
  expect(extensionDir()).toBe(first);
  expect(await fs.readFile(path.join(first!, 'background.js'), 'utf8')).toBe('updated package');
});

it('repairs a stale destination shape with a complete staged extension instead of failing mid-copy', async () => {
  base = await makeTempDir('clf-extension-repair-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'browser-extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  await fs.mkdir(path.join(bundled, 'icons'), { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'new background');
  await fs.writeFile(path.join(bundled, 'icons', 'icon128.png'), 'new icon');

  // Staging prevents a destination type collision from corrupting the published browser copy.
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  await fs.writeFile(path.join(stable, 'background.js'), 'old background');
  await fs.writeFile(path.join(stable, 'icons'), 'stale file where a directory belongs');
  const publishedInode = (await fs.stat(stable)).ino;

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../backend/domains/browser/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect((await fs.stat(stable)).ino).toBe(publishedInode);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('new background');
  expect(await fs.readFile(path.join(stable, 'icons', 'icon128.png'), 'utf8')).toBe('new icon');
  await expect(fs.access(`${stable}.new`)).rejects.toBeDefined();
  await expect(fs.access(`${stable}.old`)).rejects.toBeDefined();
});

it('recovers an interrupted promotion from the valid old copy before trusting stale new or package data', async () => {
  base = await makeTempDir('clf-extension-crash-recovery-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'browser-extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  const backup = `${stable}.old`;
  const stage = `${stable}.new`;

  // Recover from a crash with a corrupt published tree, a valid backup, stale staging, and a damaged package.
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'background.js'), 'package without manifest');
  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'background.js'), 'corrupt stable');
  const publishedInode = (await fs.stat(stable)).ino;
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: '1.9.9' }));
  await fs.writeFile(path.join(backup, 'background.js'), 'last known good');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(stage, 'background.js'), 'uncommitted staging');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../backend/domains/browser/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect((await fs.stat(stable)).ino).toBe(publishedInode);
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('last known good');
  expect(JSON.parse(await fs.readFile(path.join(stable, 'manifest.json'), 'utf8'))).toEqual({ version: '1.9.9' });
  await expect(fs.access(backup)).rejects.toBeDefined();
  await expect(fs.access(stage)).rejects.toBeDefined();
});

it('restores an interrupted in-place update even when the mixed published tree still has a manifest', async () => {
  base = await makeTempDir('clf-extension-in-place-recovery-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'browser-extension');
  const userData = path.join(base, 'user-data');
  const stable = path.join(userData, 'extension');
  const backup = `${stable}.old`;
  const stage = `${stable}.new`;

  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '2.0.3' }));
  await fs.writeFile(path.join(bundled, 'background.js'), 'next package');

  await fs.mkdir(stable, { recursive: true });
  await fs.writeFile(path.join(stable, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(stable, 'background.js'), 'partially replaced');
  const publishedInode = (await fs.stat(stable)).ino;

  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: '2.0.2' }));
  await fs.writeFile(path.join(backup, 'background.js'), 'last complete package');
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ version: '2.0.3' }));
  await fs.writeFile(path.join(stage, 'background.js'), 'next package');
  await fs.writeFile(path.join(stage, '.neuraflok-source'), 'complete-stage');

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? userData : ''),
      getAppPath: () => path.join(base!, 'not-used')
    }
  }));

  const { extensionDir } = await import('../backend/domains/browser/extension-path.js');
  expect(extensionDir()).toBe(stable);
  expect((await fs.stat(stable)).ino).toBe(publishedInode);
  // Recovery restores the backup before applying the update without replacing the published root.
  expect(await fs.readFile(path.join(stable, 'background.js'), 'utf8')).toBe('next package');
  expect(JSON.parse(await fs.readFile(path.join(stable, 'manifest.json'), 'utf8'))).toEqual({ version: '2.0.3' });
  await expect(fs.access(backup)).rejects.toBeDefined();
  await expect(fs.access(stage)).rejects.toBeDefined();
});

it('offers a newer extension build without touching the folder until an idle extension asks', async () => {
  base = await makeTempDir('clf-extension-offer-');
  const resources = path.join(base, 'resources');
  const bundled = path.join(resources, 'browser-extension');
  const userData = path.join(base, 'user-data');
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
  await fs.writeFile(path.join(bundled, 'build-stamp.txt'), 'bbbbbbbbbbbb\n');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, writable: true, value: resources });
  vi.doMock('electron', () => ({ app: { isPackaged: true, getPath: (name: string) => (name === 'userData' ? userData : ''), getAppPath: () => base! } }));
  const { extensionUpdateOffer, prepareExtensionUpdate, materializedExtensionBuild } = await import('../backend/domains/browser/extension-path.js');
  expect(extensionUpdateOffer(null)).toBeNull(); // an unstamped checkout cannot be compared
  expect(extensionUpdateOffer('bbbbbbbbbbbb')).toBeNull();
  expect(extensionUpdateOffer('aaaaaaaaaaaa')).toEqual({ build: 'bbbbbbbbbbbb' });
  // An update offer must not replace files while a live extension worker still runs.
  expect(materializedExtensionBuild()).toBeNull();
  expect(prepareExtensionUpdate('bbbbbbbbbbbb')).toBeNull();
  expect(prepareExtensionUpdate('aaaaaaaaaaaa')).toEqual({ build: 'bbbbbbbbbbbb', ready: true });
  expect(materializedExtensionBuild()).toBe('bbbbbbbbbbbb');
});

it('loads the project companion when stamped .dev-electron reports packaged', async () => {
  base = await makeTempDir('clf-extension-dev-electron-');
  const project = path.join(base, 'project');
  const resources = path.join(base, '.dev-electron', 'resources');
  await fs.mkdir(path.join(project, 'browser-extension'), { recursive: true });
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(project, 'browser-extension', 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    writable: true,
    value: resources
  });
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    value: path.join(base, '.dev-electron', 'NEURAFLOK.exe')
  });
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getPath: (name: string) => (name === 'userData' ? path.join(base!, 'user-data') : ''),
      getAppPath: () => project
    }
  }));
  const { extensionDir } = await import('../backend/domains/browser/extension-path.js');
  expect(extensionDir()).toBe(path.join(project, 'browser-extension'));
});
