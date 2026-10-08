import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, initConfigPath, loadConfig } from '../backend/infrastructure/settings/config.js';
import { APP_VERSION } from '../backend/infrastructure/settings/version.js';
import { releaseNotesUrl, whatsNewAction } from '../contracts/whats-new.js';
import { makeTempDir, removeTempDir } from './helpers.js';

// What's New shows once after a real update, never on a fresh install.

describe('whatsNewAction', () => {
  const has = (version: string) => version === '0.1.0';
  it('shows once after an update to a version with highlights', () => {
    expect(whatsNewAction('0.1.0', '0.0.9', has)).toBe('show');
    expect(whatsNewAction('0.1.0', '0.1.0', has)).toBe('none');
  });
  it('treats a configuration from before the feature as an update', () => {
    expect(whatsNewAction('0.1.0', undefined, has)).toBe('show');
  });
  it('records quietly for a version without highlights, a downgrade, or a malformed old value', () => {
    expect(whatsNewAction('0.1.1', '0.1.0', has)).toBe('record');
    expect(whatsNewAction('0.1.0', '0.1.1', has)).toBe('record');
    expect(whatsNewAction('0.1.0', '0.1.0.1', has)).toBe('record');
  });
  it('does not link release notes when this project has no published release page', () => {
    expect(releaseNotesUrl('0.1.0')).toBeNull();
  });
});

describe('the version a start records', () => {
  let dir: string;
  beforeAll(async () => { dir = await makeTempDir('clf-whats-new-'); initConfigPath(dir); });
  afterAll(async () => { await removeTempDir(dir); });

  it('records its own version on a fresh install, so nothing shows', async () => {
    await fs.rm(path.join(dir, 'config.json'), { force: true });
    expect((await loadConfig()).ui.lastSeenVersion).toBe(APP_VERSION);
  });
  it('keeps an existing install without a recorded version unrecorded, so its update shows', async () => {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(defaultConfig()), 'utf8');
    expect((await loadConfig()).ui.lastSeenVersion).toBeUndefined();
  });
  it('drops a stored value that is not a version string instead of rejecting the file', async () => {
    const config = { ...defaultConfig(), ui: { ...defaultConfig().ui, lastSeenVersion: 42 } };
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
    const loaded = await loadConfig();
    expect(loaded.ui.lastSeenVersion).toBeUndefined();
    expect(loaded.ui.theme).toBe(defaultConfig().ui.theme);
  });
});
