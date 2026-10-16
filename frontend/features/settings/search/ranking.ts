import { currentLanguage } from '../../../shared/i18n.js';
import { foldSearchText } from './indexer.js';
import type { SettingEntry } from './model.js';

const MAX_RESULTS = 12;

export function searchSettings(entries: SettingEntry[], query: string, language = currentLanguage()): SettingEntry[] {
  const wanted = foldSearchText(query, language);
  if (!wanted) return [];
  const terms = wanted.split(' ');
  const scored: Array<{ entry: SettingEntry; rank: number; at: number }> = [];
  entries.forEach((entry, at) => {
    const title = foldSearchText(entry.title, language);
    const place = foldSearchText(`${entry.page} ${entry.section}`, language);
    const all = `${title} ${foldSearchText(entry.detail, language)} ${place}`;
    if (!terms.every(term => all.includes(term))) return;
    const rank = title.startsWith(wanted) ? 0 : terms.every(term => title.includes(term)) ? 1
      : terms.every(term => `${title} ${place}`.includes(term)) ? 2 : 3;
    scored.push({ entry, rank, at });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.at - b.at).slice(0, MAX_RESULTS).map(({ entry }) => entry);
}
