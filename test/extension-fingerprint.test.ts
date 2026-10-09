import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectExtensionAssets, createExtensionFingerprint } from '../scripts/packaging/extension-fingerprint.mjs';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'neuraflok-extension-fingerprint-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('browser extension fingerprint', () => {
  it('collects assets deterministically and ignores generated or editor-only files', () => {
    const root = createTemporaryDirectory();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'z.js'), 'z');
    writeFileSync(path.join(root, 'build-stamp.txt'), 'old');
    writeFileSync(path.join(root, 'types.d.ts'), 'type EditorOnly = true');
    writeFileSync(path.join(root, 'src', 'a.js'), 'a');

    expect(collectExtensionAssets(root)).toEqual(['src/a.js', 'z.js']);
    expect(createExtensionFingerprint(root)).toMatch(/^[a-f0-9]{12}$/);
  });

  it('frames each path and content so distinct asset sets produce distinct identities', () => {
    const left = createTemporaryDirectory();
    const right = createTemporaryDirectory();
    writeFileSync(path.join(left, 'a'), 'bc');
    writeFileSync(path.join(right, 'ab'), 'c');

    expect(createExtensionFingerprint(left)).not.toBe(createExtensionFingerprint(right));
  });

  it('changes the identity when a shipped asset changes but ignores stamp updates', () => {
    const root = createTemporaryDirectory();
    writeFileSync(path.join(root, 'worker.js'), 'first');
    writeFileSync(path.join(root, 'build-stamp.txt'), 'old');
    const initial = createExtensionFingerprint(root);

    writeFileSync(path.join(root, 'build-stamp.txt'), 'new');
    expect(createExtensionFingerprint(root)).toBe(initial);
    writeFileSync(path.join(root, 'worker.js'), 'second');
    expect(createExtensionFingerprint(root)).not.toBe(initial);
  });
});
