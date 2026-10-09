import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createAppLanguageSync } from '../browser-extension/src/background/connectivity/language-sync.js';

const root = path.join(process.cwd(), 'browser-extension');
const i18nSource = readFileSync(path.join(root, 'src', 'popup', 'localization.js'), 'utf8');
const workerSource = readFileSync(path.join(root, 'src', 'background', 'service-worker.js'), 'utf8');

function loadI18n(appLanguage?: string) {
  const listeners: Array<(changes: Record<string, { newValue: unknown }>, area: string) => void> = [];
  const dispatched: Array<{ type: string; detail?: unknown }> = [];
  const chrome = {
    storage: {
      local: { get: async () => appLanguage ? { appLanguage } : {} },
      onChanged: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) }
    }
  };
  const context: Record<string, any> = {
    chrome,
    navigator: { language: 'de-DE' },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: { detail?: unknown } = {}) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: (event: { type: string; detail?: unknown }) => { dispatched.push(event); }
  };
  context.globalThis = context;
  vm.runInNewContext(i18nSource, context);
  return { api: context.NEURAFLOK_I18N, listeners, dispatched };
}

it('uses the language selected in NEURAFLOK instead of the browser language', async () => {
  const { api } = loadI18n('en');
  await api.ready;
  expect(api.language()).toBe('en');
  expect(api.t('stateActive')).toBe('System active');
});

it('uses the browser language until NEURAFLOK provides its preference', async () => {
  const { api } = loadI18n();
  await api.ready;
  expect(api.language()).toBe('de');
  expect(api.t('stateActive')).toBe('System aktiv');
});

it('follows app language changes while the companion panel is open', async () => {
  const { api, listeners, dispatched } = loadI18n('de');
  await api.ready;
  expect(api.t('stateActive')).toBe('System aktiv');
  for (const listener of listeners) listener({ appLanguage: { newValue: 'es' } }, 'local');
  expect(api.language()).toBe('es');
  expect(api.t('stateActive')).toBe('Sistema activo');
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.type).toBe('neuraflok-language-changed');
});

it('keeps all provider labels available when a locale uses a regional code', () => {
  const { api } = loadI18n();
  const spanish = api.messages('es-MX');
  expect(spanish.stateActive).toBe('Sistema activo');
  expect(spanish.providerCount).toBe('{0} de {1} activos');
});

it('stores only a language supported by the app and applies its English default', async () => {
  const stored: Record<string, unknown> = {};
  const chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => key in stored ? { [key]: stored[key] } : {}),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, value); })
      }
    }
  };
  const sync = createAppLanguageSync(chrome as never);
  await expect(sync.apply({ language: 'en' })).resolves.toBe(true);
  await expect(sync.apply({ language: 'es' })).resolves.toBe(true);
  await expect(sync.apply({ language: 'xx' })).resolves.toBe(false);
  await expect(sync.apply({ language: null })).resolves.toBe(true);
  expect(stored.appLanguage).toBe('en');
  expect(chrome.storage.local.set).toHaveBeenCalledTimes(3);
});

it('applies the app language during bridge maintenance', () => {
  expect(workerSource).toContain("import { createAppLanguageSync } from './connectivity/language-sync.js'");
  expect(workerSource).toContain('await appLanguage.apply(data).catch');
});
