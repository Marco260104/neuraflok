import { currentLanguage } from '../../../shared/i18n.js';
import type { SettingEntry } from './model.js';

const TEXT_NODE = 3;

export function foldSearchText(text: string, language = currentLanguage()): string {
  return text.toLocaleLowerCase(language).normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const tabLabel = (button: HTMLElement): string =>
  [...button.childNodes].filter(node => node.nodeType === TEXT_NODE || (node as Element).tagName === 'SPAN' && !(node as Element).classList.contains('badge'))
    .map(node => node.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();

function offered(node: HTMLElement, page: HTMLElement): boolean {
  for (let at: HTMLElement | null = node; at && at !== page; at = at.parentElement) {
    if (at.hidden) return false;
    if (at.classList.contains('step') && at.parentElement?.classList.contains('wizard') && !at.classList.contains('is-open')) return false;
  }
  return true;
}

export function collectSettings(root: ParentNode = document): SettingEntry[] {
  const entries: SettingEntry[] = [];
  for (const button of root.querySelectorAll<HTMLElement>('#tabs button[data-tab]')) {
    const tab = button.dataset.tab!;
    const page = root.querySelector<HTMLElement>(tab === 'settings' ? '[data-view="settings"]' : `[data-panel="${tab}"]`);
    if (!page) continue;
    const pageName = tabLabel(button);
    let section = '';
    for (const step of page.querySelectorAll<HTMLElement>('.setup-rail button[data-rail-step]')) {
      const title = words(step.querySelector('.setup-rail-label'));
      if (title && offered(step, page)) entries.push({ tab, page: pageName, section: '', title, detail: '', target: step });
    }
    for (const node of page.querySelectorAll<HTMLElement>('.settings-section-head, .setting, .field > label, .perm-main')) {
      if (node.classList.contains('settings-section-head')) {
        section = words(node.querySelector('h2'));
        if (section && offered(node, page)) entries.push({ tab, page: pageName, section: '', title: section, detail: words(node.querySelector('p')), target: node });
        continue;
      }
      if (!offered(node, page)) continue;
      const field = node.matches('.field > label');
      const title = field ? words(node) : words(node.querySelector('.setting-text > b, b'));
      if (!title) continue;
      const detail = field ? '' : words(node.querySelector('.setting-text > em, em'));
      const target = field ? node.parentElement! : node.closest<HTMLElement>('.perm') ?? node;
      entries.push({ tab, page: pageName, section, title, detail, target });
    }
  }
  return entries;
}
