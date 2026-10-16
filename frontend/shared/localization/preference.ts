import { migrateLegacyPreferenceNamespace } from '../storage-namespace.js';
import { parseLanguage, systemLanguage, type Language } from './catalog.js';

const LANGUAGE_STORAGE_KEY = 'neuraflok.ui.language';

function systemPreferences(): readonly string[] {
  try {
    return window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language];
  } catch {
    return [];
  }
}

export function loadInitialLanguage(): Language {
  try {
    const storage = window.localStorage;
    migrateLegacyPreferenceNamespace(storage);
    const saved = storage.getItem(LANGUAGE_STORAGE_KEY);
    return saved === null ? systemLanguage(systemPreferences()) : parseLanguage(saved);
  } catch {
    return systemLanguage(systemPreferences());
  }
}

export function saveLanguagePreference(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    return;
  }
}
