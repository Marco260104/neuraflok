import { describe, expect, it } from 'vitest';
import { settingsSave } from '../backend/application/ipc/settings-contract.js';
import { defaultConfig } from '../backend/infrastructure/settings/config/defaults.js';
import type { SettingsPatch } from '../backend/preload/api/contracts.js';
import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { JSDOM } from 'jsdom';

describe('Settings and connected model selection fixes (NF-14)', () => {
  it('validates settings snapshot with base including providers', () => {
    const config = defaultConfig();
    const base: SettingsPatch = {
      capabilities: config.capabilities,
      readOnly: config.readOnly,
      commandAllowlist: config.commandAllowlist,
      ui: config.ui,
      sessions: config.sessions,
      compaction: config.compaction,
      providerTools: config.providerTools ?? { instructions: '' },
      controlApi: config.controlApi ?? { enabled: false, allowActions: false },
      multiAgent: config.multiAgent,
      providers: config.providers,
      goal: config.goal
    };

    const patch: SettingsPatch = {
      ...base,
      ui: {
        ...base.ui,
        theme: 'light',
        webProvider: 'qwen'
      }
    };

    const parsed = settingsSave.safeParse({ patch, base });
    expect(parsed.success).toBe(true);
  });

  it('fails validation when base lacks providers (reproducing the original bug)', () => {
    const config = defaultConfig();
    const brokenBase = {
      capabilities: config.capabilities,
      readOnly: config.readOnly,
      commandAllowlist: config.commandAllowlist,
      ui: config.ui,
      sessions: config.sessions,
      compaction: config.compaction,
      providerTools: config.providerTools ?? { instructions: '' },
      controlApi: config.controlApi ?? { enabled: false, allowActions: false },
      multiAgent: config.multiAgent,
      // providers missing!
      goal: config.goal
    };

    const patch = {
      ...brokenBase,
      providers: config.providers,
      ui: {
        ...config.ui,
        theme: 'light'
      }
    };

    const parsed = settingsSave.safeParse({ patch, base: brokenBase });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.path.includes('providers'))).toBe(true);
    }
  });

  it('ensures uiLanguage is present in quick settings dialog markup', () => {
    const html = readRendererMarkup(process.cwd());
    const dom = new JSDOM(html);
    const select = dom.window.document.getElementById('uiLanguage') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const row = select?.closest('.quick-setting');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.quick-setting-label')?.textContent?.trim()).toBe('Language');
  });
});
