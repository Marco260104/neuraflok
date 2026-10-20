/** Every interface language the app ships, as stored by the NEURAFLOK renderer. */
export const UI_LANGUAGES = ['en', 'de', 'es', 'fr', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const UI_LANGUAGE_NAMES = {
  en: 'English',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  'pt-BR': 'Brazilian Portuguese',
  'pt-PT': 'European Portuguese',
  ru: 'Russian',
  tr: 'Turkish',
  vi: 'Vietnamese',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese'
} as const satisfies Record<UiLanguage, string>;

/** Standing model instruction so replies match the selected interface language. */
export function replyLanguageInstruction(language?: UiLanguage | null): string {
  if (!language || !(language in UI_LANGUAGE_NAMES)) return '';
  const name = UI_LANGUAGE_NAMES[language];
  return `Reply in ${name}. Use that language for every user-facing sentence, including explanations, summaries, status, and error descriptions. Keep tool names, file paths, code identifiers, and commands unchanged.`;
}
