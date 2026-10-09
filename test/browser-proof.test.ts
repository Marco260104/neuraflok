import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  browserProofWritten, externalBrowserProof, initBrowserProofPath, loadBrowserProof,
  noteExternalInstalled, resetBrowserProofForTests
} from '../backend/domains/browser/browser-proof.js';

let dir = '';
const chrome = 'a'.repeat(32);
const edge = 'b'.repeat(32);

beforeEach(async () => {
  resetBrowserProofForTests();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-proof-'));
  initBrowserProofPath(dir);
});
afterEach(async () => { await browserProofWritten(); await fs.rm(dir, { recursive: true, force: true }); });

it('keeps extension installation evidence across a restart', async () => {
  expect(noteExternalInstalled(chrome, '0.1.0')).toBe(true);
  expect(noteExternalInstalled(chrome, '0.1.0')).toBe(false);
  await browserProofWritten();
  const saved = await fs.readFile(path.join(dir, 'browser-proof.json'), 'utf8');
  expect(Object.keys(JSON.parse(saved).external).sort()).toEqual(['browserId', 'installedAt', 'version']);
  resetBrowserProofForTests();
  initBrowserProofPath(dir);
  await loadBrowserProof();
  expect(externalBrowserProof()).toEqual({ browserId: chrome, version: '0.1.0', installedAt: expect.any(Number) });
});

it('replaces installation evidence when the browser or extension version changes', () => {
  noteExternalInstalled(chrome, '0.1.0');
  expect(noteExternalInstalled(edge, '0.1.0')).toBe(true);
  expect(externalBrowserProof()).toMatchObject({ browserId: edge, version: '0.1.0' });
  expect(noteExternalInstalled(edge, '0.1.1')).toBe(true);
  expect(externalBrowserProof()).toMatchObject({ browserId: edge, version: '0.1.1' });
});

it('reads damaged or foreign files as no proof', async () => {
  for (const content of ['{"external":', JSON.stringify({ external: { browserId: 'not valid!', version: '1.0.0', installedAt: 1 } }),
    JSON.stringify({ external: { browserId: chrome, version: 'x'.repeat(40), installedAt: 1 } })]) {
    await fs.writeFile(path.join(dir, 'browser-proof.json'), content, 'utf8');
    await loadBrowserProof();
    expect(externalBrowserProof()).toBeNull();
  }
});
