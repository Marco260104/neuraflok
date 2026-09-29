import zhCN from '../../locales/zh-CN.json';
import es from '../../locales/es.json';
import zhTW from '../../locales/zh-TW.json';
import ja from '../../locales/ja.json';
import ko from '../../locales/ko.json';
import tr from '../../locales/tr.json';
import fr from '../../locales/fr.json';
import ptPT from '../../locales/pt-PT.json';
import ptBR from '../../locales/pt-BR.json';
import de from '../../locales/de.json';
import ru from '../../locales/ru.json';
import vi from '../../locales/vi.json';

export type Language = 'en' | 'es' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'tr' | 'vi' | 'fr' | 'pt-PT' | 'pt-BR' | 'de' | 'ru';

type MessageCatalog = Readonly<Record<string, string>>;

const catalogs: Readonly<Record<Exclude<Language, 'en'>, MessageCatalog>> = {
  es,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  tr,
  vi,
  fr,
  'pt-PT': ptPT,
  'pt-BR': ptBR,
  de,
  ru
};

const supportedLanguages = new Set<string>(['en', ...Object.keys(catalogs)]);
const catalogMessages = new Set(Object.values(catalogs).flatMap(catalog => Object.keys(catalog)));

export function parseLanguage(value: string | null | undefined): Language {
  return value && supportedLanguages.has(value) ? value as Language : 'en';
}

export function systemLanguage(preferred: readonly string[]): Language {
  for (const candidate of preferred) {
    const tag = String(candidate).toLowerCase();
    const base = tag.split('-')[0];
    if (base === 'zh') return /-(hant|tw|hk|mo)\b/.test(tag) ? 'zh-TW' : 'zh-CN';
    if (base === 'pt') return /^pt-pt\b/.test(tag) ? 'pt-PT' : 'pt-BR';
    if (base && supportedLanguages.has(base)) return base as Language;
  }
  return 'en';
}

export function isCatalogMessage(source: string): boolean {
  return catalogMessages.has(source);
}

export function isNormalizedCatalogMessage(source: string): boolean {
  return isCatalogMessage(source.replace(/\s+/g, ' ').trim());
}

export function translate(language: Language, source: string, args: readonly unknown[] = []): string {
  const catalog = language === 'en' ? undefined : catalogs[language];
  const normalized = source.replace(/\s+/g, ' ').trim();
  const key = catalog && Object.hasOwn(catalog, source) ? source : normalized;
  const message = catalog && Object.hasOwn(catalog, key) ? catalog[key]! : source;
  return message.replace(/\{(\d+)\}/g, (match, rawIndex: string) => {
    const index = Number(rawIndex);
    return index < args.length ? String(args[index]) : match;
  });
}
