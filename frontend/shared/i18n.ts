import { onLanguageChange, publishLanguageChange } from './localization/events.js';
import { initializeLanguageDocument, refreshLanguageBindings, syncLanguageControls } from './localization/dom-bindings.js';
import { parseLanguage, systemLanguage, translate, type Language } from './localization/catalog.js';
import { loadInitialLanguage, saveLanguagePreference } from './localization/preference.js';

export type { Language } from './localization/catalog.js';
export { onLanguageChange, systemLanguage };
export { ui, uiText } from './localization/dom-bindings.js';

let language = loadInitialLanguage();

export function currentLanguage(): Language {
  return language;
}

export function t(source: string, args: readonly unknown[] = []): string {
  return translate(language, source, args);
}

export function setLanguage(next: Language): void {
  language = next;
  saveLanguagePreference(next);
  document.documentElement.lang = next;
  syncLanguageControls(next);
  publishLanguageChange();
  refreshLanguageBindings();
}

export function initLanguage(): void {
  initializeLanguageDocument({
    current: () => language,
    parse: parseLanguage,
    set: setLanguage,
    translate: t
  });
}
