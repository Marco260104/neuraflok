import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zhCN from '../frontend/locales/zh-CN.json';
import type { Language } from '../frontend/shared/i18n.js';

const names = { en: 'English', es: 'Español', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어', ru: 'Русский', tr: 'Türkçe', vi: 'Tiếng Việt', fr: 'Français', 'pt-PT': 'Português (Portugal)', 'pt-BR': 'Português (Brasil)', de: 'Deutsch' } as const;
const languages = Object.keys(names) as Language[];
const catalogs = Object.fromEntries(languages.filter(locale => locale !== 'en').map(locale =>
  [locale, JSON.parse(readFileSync(`frontend/locales/${locale}.json`, 'utf8')) as Record<string, string>]));

let dom: JSDOM;
beforeEach(() => {
  vi.resetModules();
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement'] as const) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

// Covers the Traditional Chinese selector regression.
it.each(languages)('restores %s and synchronizes the language select, settings and reloads', async locale => {
  window.localStorage.setItem('neuraflok.ui.language', locale);
  const { initLanguage, currentLanguage, t } = await import('../frontend/shared/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  expect(currentLanguage()).toBe(locale);
  expect(document.documentElement.lang).toBe(locale);
  expect(select.value).toBe(locale);
  expect(select.selectedOptions[0]!.textContent).toBe(names[locale]);
  expect(select.closest('#quickSettingsDialog')).not.toBeNull();
  expect(document.querySelector('.setup-heading h1')!.textContent).toBe(catalogs[locale]?.Setup ?? 'Setup');
  expect(t('Settings')).toBe(catalogs[locale]?.Settings ?? 'Settings');

  select.value = locale === 'en' ? 'ja' : 'en';
  select.dispatchEvent(new dom.window.Event('change'));
  expect(currentLanguage()).not.toBe(locale);
  select.value = locale;
  select.dispatchEvent(new dom.window.Event('change'));
  expect(select.value).toBe(locale);
  expect(window.localStorage.getItem('neuraflok.ui.language')).toBe(locale);
  vi.resetModules();
  expect((await import('../frontend/shared/i18n.js')).currentLanguage()).toBe(locale);
});

it('migrates saved preferences to the NEURAFLOK storage namespace', async () => {
  window.localStorage.setItem('neuraljam.ui.language', 'es');
  window.localStorage.setItem('neuraljam.sidebar-order', 'saved-order');
  const { currentLanguage } = await import('../frontend/shared/i18n.js');
  expect(currentLanguage()).toBe('es');
  expect(window.localStorage.getItem('neuraflok.ui.language')).toBe('es');
  expect(window.localStorage.getItem('neuraflok.sidebar-order')).toBe('saved-order');
  expect(window.localStorage.getItem('neuraljam.ui.language')).toBeNull();
  expect(window.localStorage.getItem('neuraljam.sidebar-order')).toBeNull();
});

it.each([
  [['de-DE', 'de'], 'de'], [['zh-Hant-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-CN'], 'zh-CN'], [['zh'], 'zh-CN'],
  [['pt-PT'], 'pt-PT'], [['pt-BR'], 'pt-BR'], [['pt'], 'pt-BR'], [['nl-NL', 'fr-FR'], 'fr'], [['nl', 'sv'], 'en'],
  [['en-GB', 'de-DE'], 'en'], [['ja-JP'], 'ja'], [[], 'en']
] as const)('maps system languages %j to %s', async (preferred, expected) => {
  const { systemLanguage } = await import('../frontend/shared/i18n.js');
  expect(systemLanguage(preferred)).toBe(expected);
});

it('starts in the system language until a language is chosen, and a saved choice wins', async () => {
  vi.spyOn(dom.window.navigator, 'languages', 'get').mockReturnValue(['de-DE', 'de']);
  const first = await import('../frontend/shared/i18n.js');
  first.initLanguage();
  expect(first.currentLanguage()).toBe('de');
  expect(document.documentElement.lang).toBe('de');
  expect(document.querySelector('.setup-heading h1')!.textContent).toBe(catalogs.de!.Setup);
  // Following the system writes nothing: a later system change still applies until someone chooses.
  expect(window.localStorage.getItem('neuraflok.ui.language')).toBeNull();
  window.localStorage.setItem('neuraljam.ui.language', 'en');
  vi.resetModules();
  expect((await import('../frontend/shared/i18n.js')).currentLanguage()).toBe('en');
});

it('defaults to English, rejects unsupported variants and switches even when storage fails', async () => {
  expect((await import('../frontend/shared/i18n.js')).currentLanguage()).toBe('en');
  expect(window.localStorage.getItem('neuraflok.ui.language')).toBeNull();
  window.localStorage.setItem('neuraflok.ui.language', 'pt-AO');
  vi.resetModules();
  expect((await import('../frontend/shared/i18n.js')).currentLanguage()).toBe('en');
  vi.resetModules();
  vi.spyOn(dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const { initLanguage, currentLanguage, t } = await import('../frontend/shared/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  select.value = 'ja';
  select.dispatchEvent(new dom.window.Event('change'));
  expect(currentLanguage()).toBe('ja');
  expect(document.documentElement.lang).toBe('ja');
  expect((document.getElementById('uiLanguage') as HTMLSelectElement).value).toBe('ja');
  expect(t('Settings')).toBe('設定');
  expect(t('unknown /Save/<img src=x>')).toBe('unknown /Save/<img src=x>');
});

it.each([
  ['fr', /compétences?/iu], ['ja', /スキル/u], ['ko', /스킬/u], ['tr', /beceri/iu],
  ['vi', /kỹ năng/iu], ['zh-CN', /技能/u], ['zh-TW', /技能/u]
] as const)('uses the Skills page terminology in all four routing strings for %s', (locale, term) => {
  const catalog = catalogs[locale];
  if (!catalog) throw new Error(`Missing routing locale: ${locale}`);
  expect(catalog.Skills).toMatch(term);
  for (const key of [
    'Choose whether imported Skills can be matched to ordinary messages.',
    'Auto-select Skills',
    'Match one imported Skill by its exact name in the message, not by topic. Explicit Skill choices always win.',
    'Auto-selected Skill: /{0}'
  ]) {
    expect(catalog[key], `${locale}: ${key}`).toMatch(term);
    expect(catalog[key], `${locale}: ${key}`).not.toMatch(/\bskills?\b/iu);
  }
});

it.each(languages)('explains exact-name Skill routing rather than topic matching in %s', async locale => {
  const source = 'Match one imported Skill by its exact name in the message, not by topic. Explicit Skill choices always win.';
  const input = document.getElementById('autoSelectSkills') as HTMLInputElement;
  const hint = input.closest('.setting')!.querySelector('em')!;
  expect(hint.textContent).toBe(source);
  expect(input.checked).toBe(false);
  if (locale !== 'en') expect(catalogs[locale]).toHaveProperty(source);
  const { initLanguage, setLanguage } = await import('../frontend/shared/i18n.js');
  initLanguage(); setLanguage(locale);
  expect(hint.textContent).toBe(catalogs[locale]?.[source] ?? source);
  expect(document.getElementById('autoSelectSkills')).toBe(input);
  expect(input.checked).toBe(false);
});

it('translates known IPC failures and keeps provider errors and successful replies literal', async () => {
  window.localStorage.setItem('neuraflok.ui.language', 'ja');
  const { run } = await import('../frontend/shared/dom.js');
  expect(await run(Promise.resolve({ ok: false, error: 'Secure credential storage is unavailable.' }))).toBeNull();
  expect(document.querySelector('.toast')!.textContent).toBe(catalogs.ja!['Secure credential storage is unavailable.']);
  const error = 'PROVIDER: /Save/<img src=x> {0}\n  details';
  expect(await run(Promise.resolve({ ok: false, error }))).toBeNull();
  expect(document.querySelector('.toast')!.textContent).toBe(error);
  expect(document.querySelector('.toast img')).toBeNull();
  expect(await run(Promise.resolve({ ok: true, data: 'Settings' }))).toBe('Settings');
  expect(document.querySelectorAll('.toast')).toHaveLength(1);
});

it('preserves nested translated duration arguments in Turkish', async () => {
  const { setLanguage, t } = await import('../frontend/shared/i18n.js');
  setLanguage('tr');
  expect(t('{0} for {1}{2}s', [t('Worked'), `${t('{0}m', [1])} `, 5])).toBe('1 dk 5 sn · Çalıştı');
});

describe('app interface localization', () => {

  it('switches both ways without replacing controls, icons, emphasis, drafts or authored content', async () => {
    const { initLanguage, ui, t } = await import('../frontend/shared/i18n.js');
    const { el } = await import('../frontend/shared/dom.js');
    const native = document.createElement('span');
    native.setAttribute('translate', 'no'); native.title = 'Settings'; native.setAttribute('aria-label', 'Save');
    native.textContent = 'Save'; document.body.append(native);
    initLanguage();
    const input = document.getElementById('chatInput') as HTMLTextAreaElement;
    input.value = 'Save\n用户草稿 <script>not markup</script> 🙂';
    input.focus(); input.setSelectionRange(2, 7);
    const automation = document.getElementById('chatAutomation') as HTMLSelectElement;
    automation.value = 'loop';
    const icons = [...document.querySelectorAll('svg')];
    const skillNotice = document.querySelector('.skill-import-guide p');
    const pluginNoticeText = 'Import a folder, a standalone SKILL.md, or a public GitHub skill. Local skills can be linked to their GitHub source to check for updates; installing an update stays your choice.';
    const authored = el('div', 'msg', 'Save');
    document.body.append(authored);
    const action = el('button', '', () => t('Remove {0}', ['Save <img src=x>']));
    ui(action, 'aria-label', () => t('Remove {0}', ['Save <img src=x>']));
    document.body.append(action);
    const snapshots = new Map<string, string>();
    for (const locale of [...languages, 'en', 'zh-CN'] as const) {
      const language = document.getElementById('uiLanguage') as HTMLSelectElement;
      language.value = locale;
      language.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      expect(document.documentElement.lang).toBe(locale);
      expect(document.getElementById('chatInput')).toBe(input);
      expect(input.value).toBe('Save\n用户草稿 <script>not markup</script> 🙂');
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
      expect(document.activeElement).toBe(input);
      expect(automation.value).toBe('loop');
      expect([native.textContent, native.title, native.getAttribute('aria-label')]).toEqual(['Save', 'Settings', 'Save']);
      expect(authored.textContent).toBe('Save');
      expect(action.querySelector('img')).toBeNull();
      expect(action.textContent).toBe((catalogs[locale]?.['Remove {0}'] ?? 'Remove {0}').replace('{0}', 'Save <img src=x>'));
      expect(action.getAttribute('aria-label')).toBe(action.textContent);
      expect([...document.querySelectorAll('svg')]).toEqual(icons);
      expect(document.querySelector('.skill-import-guide p')).toBe(skillNotice);
      expect(skillNotice!.textContent).toBe(catalogs[locale]?.[pluginNoticeText] ?? pluginNoticeText);
      const text = document.getElementById('newChat')!.textContent!.trim();
      expect(text).toBe(catalogs[locale]?.['New chat'] ?? 'New chat');
      const globalWorkerLabel = document.getElementById('globalMaWorkers')!.closest('.setting')!.querySelector('b')!.textContent!;
      expect(globalWorkerLabel).toBe(catalogs[locale]?.['Workers across all chats'] ?? 'Workers across all chats');
      const shell = document.querySelector('.skill-import-guide')!.textContent!;
      if (snapshots.has(locale)) expect(shell).toBe(snapshots.get(locale));
      else snapshots.set(locale, shell);
    }
    expect(window.localStorage.getItem('neuraflok.ui.language')).toBe('zh-CN');
    expect(t('  Settings\n')).toBe('设置');
    expect(t('Remove {0}')).toBe('移除 {0}');
    const argument = '$& /資料/Save <img src=x>';
    expect(t('Remove {0}', [argument])).toBe(`移除 ${argument}`);
    expect(t('unknown source {0}', [argument])).toBe(`unknown source ${argument}`);
    for (const source of ['exec_command', 'gpt-6-astra']) expect(t(source)).toBe(source);
  });

  it('retains a newer authored value and persists the explicit language across renderer reloads', async () => {
    const first = await import('../frontend/shared/i18n.js');
    first.initLanguage();
    const node = document.createElement('div');
    document.body.append(node);
    first.ui(node, 'textContent', () => first.t('New chat'));
    node.textContent = 'User title — 保留原文';
    first.setLanguage('zh-CN');
    expect(node.textContent).toBe('User title — 保留原文');
    vi.resetModules();
    const next = await import('../frontend/shared/i18n.js');
    expect(next.currentLanguage()).toBe('zh-CN');
    expect(next.t('Settings')).toBe('设置');
    expect(next.t('not in the catalog')).toBe('not in the catalog');
    expect(next.t('__proto__')).toBe('__proto__');
    expect(next.t('toString')).toBe('toString');
  });

  it('only refreshes mounted bindings after repeated row replacement, including hidden labels and text nodes', async () => {
    const { ui, uiText, t, setLanguage } = await import('../frontend/shared/i18n.js');
    const pane = document.createElement('div');
    pane.hidden = true;
    document.body.append(pane);
    const retiredReads = vi.fn(() => t('Settings'));
    const retired: Node[] = [];
    for (let i = 0; i < 1024; i++) {
      const label = ui(document.createElement('span'), 'textContent', retiredReads);
      pane.replaceChildren(label);
      retired.push(label);
    }
    const live = ui(document.createElement('button'), 'title', () => t('Settings'));
    const text = uiText(() => t('Copy'));
    live.append(text);
    pane.replaceChildren(live);
    retiredReads.mockClear();
    for (const locale of ['zh-CN', 'en', 'zh-CN'] as const) {
      setLanguage(locale);
      expect(live.title).toBe(locale === 'zh-CN' ? '设置' : 'Settings');
      expect(text.textContent).toBe(locale === 'zh-CN' ? '复制' : 'Copy');
      expect(live.firstChild).toBe(text);
    }
    expect(retiredReads).not.toHaveBeenCalled();
    expect(retired).toHaveLength(1024);
    const fresh = ui(document.createElement('span'), 'textContent', () => t('Settings'));
    pane.append(fresh);
    expect(fresh.textContent).toBe('设置');
  });

  it('translates plan chrome while preserving model-authored headlines and details', async () => {
    const { setLanguage } = await import('../frontend/shared/i18n.js');
    const { renderAgentPlan } = await import('../frontend/features/agents/agent-plan.js');
    const host = document.createElement('div'); document.body.append(host);
    renderAgentPlan(host, 'session-one', { plan: [{ step: 'Plan', status: 'in_progress', details: 'Keep "Save" exactly as written.' }], explanation: 'Save', updatedAt: 1 } as any);
    const headline = host.querySelector('.agent-plan-step-title');
    setLanguage('zh-CN');
    expect(host.querySelector('.agent-plan-title')!.textContent).toBe('计划');
    expect(host.querySelector('.agent-plan-marker')!.getAttribute('aria-label')).toBe('进行中');
    expect(host.querySelector('.agent-plan-step-title')).toBe(headline);
    expect(headline!.textContent).toBe('Plan');
    expect(host.querySelector('.agent-plan-details')!.textContent).toBe('Keep "Save" exactly as written.');
    expect(host.querySelector('.agent-plan-explanation')!.textContent).toBe('Save');
  });

  it('keeps provider model/effort identities and recorded worker markers unchanged in Chinese', async () => {
    const { setLanguage } = await import('../frontend/shared/i18n.js');
    setLanguage('zh-CN');
    const { chatModelName } = await import('../frontend/features/chat/chat-models.js');
    expect(chatModelName('qwen3-coder', 'high')).toBe('qwen3-coder · 高');
    const { communicationTitle } = await import('../frontend/features/agents/agent-communication.js');
    expect(communicationTitle({ from: 'worker-1', to: 'prime', message: { text: '[worker-1 is awake again] Save' } } as any)).toBe('worker-1 已恢复工作');
    setLanguage('en');
    expect(chatModelName('qwen3-coder', 'high')).toBe('qwen3-coder · High');
  });

  it('covers every static app label in every catalog', () => {
    const catalog: Record<string, string> = zhCN;
    const walker = document.createTreeWalker(document.body, 4);
    const missing: string[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script, style, svg, code, kbd, textarea, [translate="no"]')) continue;
      const text = node.textContent!.replace(/\s+/g, ' ').trim();
      if (/[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
    }
    for (const node of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
      if (node.closest('[translate="no"]')) continue;
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const text = node.getAttribute(attr);
        if (text && /[a-zA-Z]{2}/.test(text) && !catalog[text]) missing.push(text);
      }
    }
    expect(missing).toEqual([]);
    for (const [locale, messages] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).filter(key => !Object.hasOwn(messages, key)), locale).toEqual([]);
    }
  });
});

it('matches both Turkish I pairs when searching settings', async () => {
  window.localStorage.setItem('neuraflok.ui.language', 'tr');
  const { searchSettings } = await import('../frontend/features/settings/search/ranking.js');
  const entries = [{ tab: 'home', page: 'Çalışma alanı', section: 'İzinler', title: 'IŞIK', detail: '', target: document.createElement('div') }];
  for (const query of ['izinler', 'İZİNLER', 'ışık', 'IŞIK']) expect(searchSettings(entries, query)).toHaveLength(1);
  expect(searchSettings(entries, 'missing')).toEqual([]);
});
