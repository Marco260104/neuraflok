const APP_LANGUAGES = new Set(['en', 'de', 'es', 'fr', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW']);
const APP_LANGUAGE_KEY = 'appLanguage';

export function createAppLanguageSync(chrome) {
  async function apply(data) {
    const language = data?.language == null ? 'en' : data.language;
    if (!APP_LANGUAGES.has(language)) return false;
    const stored = await chrome.storage.local.get(APP_LANGUAGE_KEY);
    if (stored[APP_LANGUAGE_KEY] === language) return false;
    await chrome.storage.local.set({ [APP_LANGUAGE_KEY]: language });
    return true;
  }

  return { apply };
}
