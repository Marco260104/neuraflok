// Materialize the bundled companion at a stable user-data path for the integrated browser.

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { packagedRuntime } from '../../infrastructure/desktop-shell/runtime-packaging.js';

function runtimeIsPackaged(): boolean {
  return packagedRuntime(app.isPackaged === true, process.execPath);
}

const MATERIALIZED_FINGERPRINT = '.neuraflok-source';
const PUBLISH_LAST = new Set(['manifest.json', MATERIALIZED_FINGERPRINT]);

function extensionFingerprint(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string, relativeDir = ''): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        // Reject special entries so host-specific links cannot enter the browser trust folder.
        throw new Error(`Unsupported extension entry: ${relative}`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function validExtension(dir: string): boolean {
  try {
    return statSync(path.join(dir, 'manifest.json')).isFile();
  } catch {
    return false;
  }
}

function materializedFingerprint(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, MATERIALIZED_FINGERPRINT), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

type EntryKind = 'directory' | 'file' | 'other' | 'missing';

function entryKind(target: string): EntryKind {
  try {
    const stat = lstatSync(target);
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}

function ensureDirectory(target: string): void {
  const kind = entryKind(target);
  if (kind === 'directory') return;
  if (kind !== 'missing') rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
}

// Publish complete files atomically and keep the manifest last so the browser sees matching resources.
function replaceFile(source: string, target: string): void {
  ensureDirectory(path.dirname(target));
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.neuraflok-next-${process.pid}`);
  rmSync(temporary, { recursive: true, force: true });
  copyFileSync(source, temporary);
  chmodSync(temporary, statSync(source).mode);
  const kind = entryKind(target);
  if (kind !== 'missing') rmSync(target, { recursive: true, force: true });
  renameSync(temporary, target);
}

// Preserve the published directory inode so sandboxed browser grants survive in-place updates.
function syncTreeInPlace(source: string, target: string, root = true): void {
  ensureDirectory(target);
  const sourceEntries = readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  const ordinary = sourceEntries.filter((entry) => !root || !PUBLISH_LAST.has(entry.name));
  const final = root ? sourceEntries.filter((entry) => PUBLISH_LAST.has(entry.name)) : [];

  const publish = (entry: (typeof sourceEntries)[number]): void => {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      syncTreeInPlace(from, to, false);
      return;
    }
    if (!entry.isFile()) throw new Error(`Unsupported staged extension entry: ${entry.name}`);
    replaceFile(from, to);
  };

  for (const entry of ordinary) publish(entry);
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue;
    rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }
  for (const entry of final) publish(entry);
}

function recoverInterruptedMaterialization(stable: string, stage: string, backup: string): void {
  // Restore the published backup in place when possible so browser grants retain their root.
  if (validExtension(backup)) {
    if (entryKind(stable) === 'directory') syncTreeInPlace(backup, stable);
    else {
      rmSync(stable, { recursive: true, force: true });
      cpSync(backup, stable, { recursive: true, force: true });
    }
    if (validExtension(stable)) {
      rmSync(backup, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
    return;
  }

  // Recover only complete staged trees and preserve an existing published root when possible.
  if (validExtension(stage) && materializedFingerprint(stage) !== null) {
    if (entryKind(stable) === 'directory') {
      syncTreeInPlace(stage, stable);
      if (validExtension(stable)) rmSync(stage, { recursive: true, force: true });
    } else {
      rmSync(stable, { recursive: true, force: true });
      renameSync(stage, stable);
    }
    return;
  }

  if (validExtension(stable)) {
    rmSync(stage, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
}

// Stage and verify updates before publishing while retaining rollback and browser folder identity.
function materializePackagedExtension(bundled: string, stable: string): string | null {
  const stage = `${stable}.new`;
  const backup = `${stable}.old`;
  mkdirSync(path.dirname(stable), { recursive: true });
  recoverInterruptedMaterialization(stable, stage, backup);

  // Keep the last known-good installed copy available if packaged update resources are damaged.
  if (!validExtension(bundled)) return validExtension(stable) ? stable : null;
  const fingerprint = extensionFingerprint(bundled);
  if (validExtension(stable) && materializedFingerprint(stable) === fingerprint) return stable;
  rmSync(stage, { recursive: true, force: true });

  try {
    cpSync(bundled, stage, { recursive: true, force: true });
    if (!validExtension(stage)) throw new Error('Staged extension is missing manifest.json');
    writeFileSync(path.join(stage, MATERIALIZED_FINGERPRINT), fingerprint, { encoding: 'utf8', mode: 0o600 });

    // Keep a complete rollback copy before changing the browser-visible folder contents.
    rmSync(backup, { recursive: true, force: true });
    const hadPublishedDirectory = entryKind(stable) === 'directory';
    const hadValidPublishedCopy = validExtension(stable);
    if (hadValidPublishedCopy) cpSync(stable, backup, { recursive: true, force: true });

    if (hadPublishedDirectory) {
      syncTreeInPlace(stage, stable);
      if (!validExtension(stable) || materializedFingerprint(stable) !== fingerprint)
        throw new Error('Published extension did not match staged source');
      rmSync(stage, { recursive: true, force: true });
    } else {
      rmSync(stable, { recursive: true, force: true });
      renameSync(stage, stable);
    }
    rmSync(backup, { recursive: true, force: true });
    return stable;
  } catch {
    // Restore a known-good copy when possible and retain recovery files if rollback cannot finish.
    if (validExtension(backup)) {
      try {
        if (entryKind(stable) === 'directory') syncTreeInPlace(backup, stable);
        else {
          rmSync(stable, { recursive: true, force: true });
          cpSync(backup, stable, { recursive: true, force: true });
        }
      } catch {
        return validExtension(stable) ? stable : null;
      }
    }
    if (validExtension(stable)) {
      rmSync(stage, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
    }
    return validExtension(stable) ? stable : null;
  }
}

// Return the companion path used by the app-owned browser, or null when unavailable.
export function extensionDir(): string | null {
  if (runtimeIsPackaged()) {
    const bundled = path.join(process.resourcesPath, 'browser-extension');
    const stable = path.join(app.getPath('userData'), 'extension');
    try {
      return materializePackagedExtension(bundled, stable);
    } catch {
      // Keep a previously materialized extension available when a damaged update cannot be fingerprinted.
      return validExtension(stable) ? stable : null;
    }
  }

  const candidates = [
    path.join(app.getAppPath(), 'browser-extension'),
    path.join(process.cwd(), 'browser-extension'),
    path.join(process.resourcesPath, 'browser-extension')
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

// Locate the shipped companion without materializing it or requiring unavailable host paths.
function shippedExtensionDir(): string | null {
  const candidates = runtimeIsPackaged()
    ? [() => path.join(process.resourcesPath, 'browser-extension'), () => path.join(app.getPath('userData'), 'extension')]
    : [() => path.join(app.getAppPath(), 'browser-extension'), () => path.join(process.cwd(), 'browser-extension')];
  for (const candidate of candidates) {
    try {
      const dir = candidate();
      if (validExtension(dir)) return dir;
    } catch {
      // A missing host-specific root does not prevent checking the remaining candidates.
    }
  }
  return null;
}

// Read the packaged build stamp once so the app and companion can compare installed versions.
let shippedStamp: string | null | undefined;
export function shippedExtensionBuild(): string | null {
  if (shippedStamp !== undefined) return shippedStamp;
  shippedStamp = null;
  try {
    const dir = shippedExtensionDir();
    if (dir) shippedStamp = readFileSync(path.join(dir, 'build-stamp.txt'), 'utf8').trim().slice(0, 12) || null;
  } catch {
    // Missing or damaged build metadata means there is no version comparison to report.
  }
  return shippedStamp;
}

// Set or clear the cached shipped build for isolated tests.
export function setShippedExtensionBuildForTest(stamp?: string | null): void {
  shippedStamp = stamp;
}

// Return the packaged companion build stamp, or null when unavailable.
export function materializedExtensionBuild(): string | null {
  try {
    if (!runtimeIsPackaged()) return null;
    return readFileSync(path.join(app.getPath('userData'), 'extension', 'build-stamp.txt'), 'utf8').trim().slice(0, 12) || null;
  } catch {
    return null;
  }
}

// Offer a shipped update only when a packaged companion reports a different build.
export function extensionUpdateOffer(running: string | null): { build: string } | null {
  // Keep bridge status available when build metadata or Electron paths are unavailable.
  try {
    if (!running) return null;
    const shipped = shippedExtensionBuild();
    if (!shipped || running === shipped || !runtimeIsPackaged()) return null;
    return { build: shipped };
  } catch {
    return null;
  }
}

// Refresh the browser-loaded companion when its worker is idle and can reload safely.
export function prepareExtensionUpdate(running: string | null): { build: string; ready: boolean } | null {
  const offer = extensionUpdateOffer(running);
  if (!offer) return null;
  try { extensionDir(); } catch { /* reported as not ready below */ }
  return { build: offer.build, ready: materializedExtensionBuild() === offer.build };
}
