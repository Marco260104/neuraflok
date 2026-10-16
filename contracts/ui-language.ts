/** Every interface language the app ships, as stored by the NEURAFLOK renderer. */
export const UI_LANGUAGES = ['en', 'de', 'es', 'fr', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
