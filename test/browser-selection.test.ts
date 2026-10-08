import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, loadConfig, saveConfig } from '../backend/infrastructure/settings/config.js';
import { preferredBrowserCandidates } from '../backend/domains/browser/browser.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
beforeAll(async () => { dir = await makeTempDir('clf-browser-choice-'); initConfigPath(dir); });
afterAll(async () => { await removeTempDir(dir); });

it('normalizes a saved external-browser choice to the bundled internal browser', async () => {
  const config = defaultConfig();
  await saveConfig({ ...config, ui: { ...config.ui, chatBrowser: 'edge' } });
  expect((await loadConfig()).ui.chatBrowser).toBe('integrated');
});

it('migrates a config without a browser choice to the internal browser without losing other settings', async () => {
  const old = defaultConfig();
  delete old.ui.chatBrowser;
  const legacy = { ...old, ui: { ...old.ui, autoConnect: true } };
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(legacy));
  const loaded = (await loadConfig()).ui;
  expect(loaded.chatBrowser).toBe('integrated');
  expect(loaded).not.toHaveProperty('autoConnect');
});

it('finds Edge installations on each platform without mixing in Chrome', () => {
  expect(preferredBrowserCandidates('win32', { LOCALAPPDATA: 'C:\\Local', ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps86' }, undefined, 'edge'))
    .toEqual(['C:\\Local\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Apps86\\Microsoft\\Edge\\Application\\msedge.exe']);
  const mac = preferredBrowserCandidates('darwin', {}, '/Users/example', 'edge');
  expect(mac).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  expect(mac).toContain('/Users/example/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  expect(mac.every(candidate => candidate.includes('Microsoft Edge'))).toBe(true);
  const linux = preferredBrowserCandidates('linux', { PATH: '/custom/bin:/usr/bin' }, '/home/example', 'edge');
  expect(linux).toContain('/custom/bin/microsoft-edge');
  expect(linux).toContain('/usr/bin/microsoft-edge-stable');
  expect(linux.every(candidate => !/chrome|chromium/.test(candidate))).toBe(true);
});

it('finds Brave installations on each platform without mixing in Chrome or Edge', () => {
  expect(preferredBrowserCandidates('win32', { LOCALAPPDATA: 'C:\\Local', ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps86' }, undefined, 'brave'))
    .toEqual(['C:\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Apps\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Apps86\\BraveSoftware\\Brave-Browser\\Application\\brave.exe']);
  const mac = preferredBrowserCandidates('darwin', {}, '/Users/example', 'brave');
  expect(mac).toContain('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  expect(mac).toContain('/Users/example/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  expect(mac.every(candidate => candidate.includes('Brave'))).toBe(true);
  const linux = preferredBrowserCandidates('linux', { PATH: '/custom/bin:/usr/bin' }, '/home/example', 'brave');
  expect(linux).toContain('/custom/bin/brave-browser');
  expect(linux).toContain('/usr/bin/brave-browser');
  expect(linux).toContain('/opt/brave.com/brave/brave-browser');
  expect(linux).toContain('/snap/bin/brave');
  expect(linux.every(candidate => !/chrome|chromium|edge/.test(candidate))).toBe(true);
});
