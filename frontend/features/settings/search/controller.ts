import { $, el, icon } from '../../../shared/dom.js';
import { currentLanguage, t, ui } from '../../../shared/i18n.js';
import { isMac } from '../shortcuts.js';
import { collectSettings } from './indexer.js';
import type { SettingEntry } from './model.js';
import { searchSettings } from './ranking.js';

const MARK_MS = 1600;

export interface SettingsSearch {
  reset(): void;
}

export function initSettingsSearch(options: { open(tab: string): void; shown(): boolean }): SettingsSearch {
  const field = $<HTMLInputElement>('settingsFind');
  const clear = $<HTMLButtonElement>('settingsFindClear');
  const results = $('settingsFindResults');
  const pages = $('tabs');
  let marked: HTMLElement | null = null;
  let markTimer = 0;

  const show = (searching: boolean): void => {
    results.hidden = !searching;
    pages.hidden = searching || !options.shown();
    clear.hidden = !field.value;
  };

  const titled = (title: string, query: string): HTMLElement => {
    const node = el('b');
    node.dir = 'auto';
    const lower = title.toLocaleLowerCase(currentLanguage());
    const ranges = query.toLocaleLowerCase(currentLanguage()).split(/\s+/).filter(Boolean)
      .map(term => [lower.indexOf(term), term.length] as const).filter(([start]) => start >= 0)
      .map(([start, length]) => [start, start + length] as const).sort((a, b) => a[0] - b[0]);
    let at = 0;
    for (const [start, end] of ranges) {
      if (start < at) continue;
      if (start > at) node.append(title.slice(at, start));
      node.append(el('mark', '', title.slice(start, end)));
      at = end;
    }
    if (at < title.length) node.append(title.slice(at));
    return node;
  };

  const open = (entry: SettingEntry): void => {
    reset();
    options.open(entry.tab);
    if (entry.target.matches('[data-rail-step]')) entry.target.click();
    for (let details = entry.target.parentElement?.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
    window.requestAnimationFrame(() => {
      entry.target.scrollIntoView({ block: 'center' });
      window.clearTimeout(markTimer);
      marked?.classList.remove('is-found');
      marked = entry.target;
      marked.classList.add('is-found');
      markTimer = window.setTimeout(() => { marked?.classList.remove('is-found'); marked = null; }, MARK_MS);
      entry.target.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea, button')?.focus({ preventScroll: true });
    });
  };

  const paint = (): void => {
    results.replaceChildren();
    const query = field.value.trim();
    show(Boolean(query));
    if (!query) return;
    const found = searchSettings(collectSettings(), query);
    const list = el('div', 'search-list');
    list.setAttribute('role', 'list');
    for (const entry of found) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-result';
      row.setAttribute('role', 'listitem');
      row.append(titled(entry.title, query), el('span', 'search-snippet', entry.section ? `${entry.page} › ${entry.section}` : entry.page));
      row.addEventListener('click', () => open(entry));
      list.append(row);
    }
    results.append(list);
    if (!found.length) results.append(el('p', 'empty search-status', () => t("No settings match your search.")));
  };

  const reset = (): void => {
    field.value = '';
    paint();
  };

  ui(field, 'placeholder', () => t("Search settings…"));
  ui(field, 'aria-label', () => t("Search settings"));
  ui(clear, 'title', () => t("Clear search"));
  ui(clear, 'aria-label', () => t("Clear search"));
  if (!clear.firstChild) clear.append(icon('i-x'));
  field.addEventListener('input', paint);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && field.value) { event.preventDefault(); event.stopPropagation(); reset(); }
    else if (event.key === 'ArrowDown') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'Enter') {
      const first = results.querySelector<HTMLElement>('.search-result');
      if (first) { event.preventDefault(); first.click(); }
    }
  });
  clear.addEventListener('click', () => { reset(); field.focus(); });
  results.addEventListener('keydown', (event) => {
    const rows = [...results.querySelectorAll<HTMLElement>('.search-result')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    if (event.key === 'ArrowDown' && at < rows.length - 1) { event.preventDefault(); rows[at + 1]!.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); (at > 0 ? rows[at - 1]! : field).focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); field.focus(); }
  });
  document.addEventListener('keydown', (event) => {
    if (!options.shown() || event.key.toLowerCase() !== 'f' || event.shiftKey || event.altKey || event.repeat) return;
    if (isMac() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    if ((event.target as Element | null)?.closest?.('.xterm')) return;
    event.preventDefault();
    field.focus();
    field.select();
  });
  show(false);
  return { reset };
}
