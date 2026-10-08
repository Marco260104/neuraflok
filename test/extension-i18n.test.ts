import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const extension = path.join(root, 'browser-extension');
const expectedLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt_BR', 'pt_PT', 'ru', 'tr', 'vi', 'zh_CN', 'zh_TW'];
const i18nSource = await readFile(path.join(extension, 'src', 'popup', 'localization.js'), 'utf8');

async function messagesFor(language: string) {
  const context: Record<string, any> = {
    navigator: { language: 'en' },
    chrome: { storage: { local: { get: async () => ({ appLanguage: language }) } } }
  };
  context.globalThis = context;
  vm.runInNewContext(i18nSource, context);
  await context.NEURAFLOK_I18N.ready;
  return context.NEURAFLOK_I18N.messages(language) as Record<string, string>;
}

function markupKeys(source: string): string[] {
  return [...new Set([...source.matchAll(/\bdata-i18n(?:-title|-aria-label)?=["']([A-Za-z0-9_]+)["']/g)].map(match => match[1]!))].sort();
}

function codeKeys(source: string): string[] {
  return [...new Set([...source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g)].map(match => match[1]!))].sort();
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
}

describe('NEURAFLOK companion localization', () => {
  it('ships only the app-supported Chrome locale names', async () => {
    const found = (await readdir(path.join(extension, '_locales'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    expect(found).toEqual(expectedLocales.slice().sort());
  });

  it('keeps manifest and provider adapters on the new extension layout', async () => {
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')) as Record<string, any>;
    expect(manifest.default_locale).toBe('en');
    expect(manifest.host_permissions.filter((entry: string) => entry.startsWith('https://'))).toEqual([
      'https://chat.deepseek.com/*', 'https://kimi.com/*', 'https://www.kimi.com/*', 'https://chat.qwen.ai/*',
      'https://z.ai/*', 'https://chat.z.ai/*', 'https://chatglm.cn/*', 'https://www.chatglm.cn/*'
    ]);
    const scripts = manifest.content_scripts.filter((entry: any) => (entry.world ?? 'ISOLATED') === 'ISOLATED');
    const deepseek = scripts.find((entry: any) => entry.matches.includes('https://chat.deepseek.com/*'));
    const webProviders = scripts.find((entry: any) => entry.matches.includes('https://kimi.com/*'));
    expect(deepseek?.js).toEqual(['src/provider-pages/deepseek/dom-adapter.js', 'src/provider-pages/shared/delivery-agent.js', 'src/provider-pages/deepseek/controller.js']);
    expect(webProviders?.js).toEqual(['src/provider-pages/web/dom-adapter.js', 'src/provider-pages/shared/delivery-agent.js', 'src/provider-pages/web/controller.js']);
    for (const locale of expectedLocales) {
      const catalog = JSON.parse(await readFile(path.join(extension, '_locales', locale, 'messages.json'), 'utf8')) as Record<string, { message: string }>;
      expect(catalog.extension_name?.message).toBeTruthy();
      expect(catalog.extension_description?.message).toBeTruthy();
    }
  });

  it('translates every popup label in each supported app language', async () => {
    const [markup, script] = await Promise.all([
      readFile(path.join(extension, 'src', 'popup', 'index.html'), 'utf8'),
      readFile(path.join(extension, 'src', 'popup', 'controller.js'), 'utf8')
    ]);
    const used = [...new Set([...markupKeys(markup), ...codeKeys(script)])].sort();
    const english = await messagesFor('en');
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(english[key], `missing English companion message ${key}`).toBeTruthy();

    for (const locale of expectedLocales.map(value => value.replace('_', '-'))) {
      const translated = await messagesFor(locale);
      expect(Object.keys(translated).sort(), locale).toEqual(Object.keys(english).sort());
      for (const [key, message] of Object.entries(translated)) expect(message, `${locale}:${key}`).toBeTruthy();
      for (const key of used) expect(translated[key], `${locale}:${key}`).toBeTruthy();
      for (const key of Object.keys(english)) expect(placeholders(translated[key]!), `${locale}:${key}`).toEqual(placeholders(english[key]!));
    }
  });
});
