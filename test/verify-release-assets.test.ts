import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
// @ts-expect-error The checker is a plain Node script without type declarations.
import { RELEASE_FILES as files, verifyReleaseAssets as verify } from '../scripts/verify-release-assets.mjs';

const RELEASE_FILES = files as string[];
const verifyReleaseAssets = verify as (options: { dir: string; tag: string }) => Promise<string[]>;

const EXTENSION_FILES = ['src/background/service-worker.js', 'src/background/browser/active-tabs/owner.js', 'src/background/browser/active-tabs/policy.js', 'src/background/browser/active-tabs/persistence.js', 'src/background/connectivity/bridge-client.js', 'src/background/connectivity/bridge-store.js', 'src/background/connectivity/language-sync.js', 'src/background/connectivity/update-coordinator.js', 'src/background/browser/control/controller.js', 'src/background/browser/control/input/actions.js', 'src/background/browser/control/input/coordinates.js', 'src/background/browser/control/input/keyboard.js', 'src/background/browser/control/page-runtime.js', 'src/background/browser/control/page-agent.js', 'src/background/browser/control/diagnostics.js', 'src/background/providers/session-runtime.js', 'src/background/providers/session-observer.js', 'src/background/providers/delivery-ledger.js', 'src/background/providers/execution/router.js', 'src/background/providers/execution/deepseek.js', 'src/background/providers/execution/web.js', 'src/background/providers/tab-events.js', 'src/background/providers/provider-catalog.js',
  'src/provider-pages/deepseek/dom-adapter.js', 'src/provider-pages/shared/delivery-agent.js', 'src/provider-pages/deepseek/controller.js', 'src/provider-pages/deepseek/companion.css', 'src/provider-pages/web/dom-adapter.js', 'src/provider-pages/web/controller.js',
  'src/popup/index.html', 'src/popup/styles.css', 'src/popup/controller.js', 'src/popup/localization.js', 'assets/icons/icon16.png', 'assets/icons/icon32.png', 'assets/icons/icon48.png', 'assets/icons/icon128.png',
  'LICENSE', 'NOTICE'];
let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

/** A complete, correct release folder; `change` edits it before the checksums are written. */
function release(change: { manifest?: object; stamp?: string | null; omit?: string; afterSums?: () => void } = {}) {
  dir = mkdtempSync(path.join(tmpdir(), 'release-'));
  const extensionEntries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(change.manifest ?? { version: '0.1.0' }))
  };
  if (change.stamp !== null) {
    extensionEntries['build-stamp.txt'] = strToU8(change.stamp ?? '7b3057119b13\n');
  }
  for (const name of EXTENSION_FILES) extensionEntries[name] = strToU8(name);
  const sums: string[] = [];
  for (const name of RELEASE_FILES) {
    const bytes = name === 'NEURAFLOK-Provider-Extension.zip' ? zipSync(extensionEntries) : Buffer.from(`contents of ${name}`);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    if (name !== change.omit) writeFileSync(path.join(dir, name), bytes);
  }
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  change.afterSums?.();
  return dir;
}

it('accepts a complete release whose files match their checksums and whose extension is the tagged build', async () => {
  expect(await verifyReleaseAssets({ dir: release(), tag: 'v0.1.0' })).toEqual([]);
});

it('reports a file whose bytes differ from the published checksum', async () => {
  const folder = release({ afterSums: () => writeFileSync(path.join(dir, 'NEURAFLOK-Setup-x64.exe'), 'truncated') });
  expect(await verifyReleaseAssets({ dir: folder, tag: 'v0.1.0' })).toEqual([
    'NEURAFLOK-Setup-x64.exe does not match its SHA256SUMS.txt checksum.'
  ]);
});

it('reports missing files and a Chromium extension whose version or build stamp is wrong', async () => {
  expect(await verifyReleaseAssets({ dir: release({ omit: 'NEURAFLOK-Linux-arm64.deb' }), tag: 'v0.1.0' }))
    .toEqual(['NEURAFLOK-Linux-arm64.deb is missing from the release.']);
  rmSync(dir, { recursive: true, force: true });
  expect(await verifyReleaseAssets({ dir: release({ manifest: { version: '0.0.9' }, stamp: null }), tag: 'v0.1.0' })).toEqual([
    'NEURAFLOK-Provider-Extension.zip is missing build-stamp.txt.',
    'The browser extension in NEURAFLOK-Provider-Extension.zip is version 0.0.9, not 0.1.0.'
  ]);
});

it('reports a release without checksums instead of trusting its files', async () => {
  const folder = release({ afterSums: () => rmSync(path.join(dir, 'SHA256SUMS.txt')) });
  expect(await verifyReleaseAssets({ dir: folder, tag: 'v2.1.21' })).toEqual(['SHA256SUMS.txt is missing from the release.']);
});
