import { el, icon } from '../../../shared/dom.js';
import { t } from '../../../shared/i18n.js';
import { createDockIconButton } from './elements.js';
import type { AdoptableView, DockTab, DockTerminalTab, DockViewRegistration } from './types.js';

interface DockTabStripElements {
  tabs: HTMLElement;
  bar: HTMLElement;
  plus: HTMLElement;
  launch: HTMLElement;
  rightToggle: HTMLButtonElement;
}

export function createDockTabStrip(elements: DockTabStripElements) {
  let signature = '';

  const render = (
    opened: DockTab[],
    active: DockTab | null,
    terminalTabs: DockTerminalTab[],
    views: ReadonlyMap<AdoptableView, DockViewRegistration>,
    activate: (key: DockTab) => void,
    close: (key: DockTab) => void
  ): void => {
    const nextSignature = `${opened.join(',')}|${terminalTabs.map(tab => `${tab.id}:${tab.title}:${tab.exited}`).join(',')}`;
    if (nextSignature === signature) {
      for (const tab of elements.tabs.children as HTMLCollectionOf<HTMLElement>) {
        const selected = tab.dataset.key === active;
        const pick = tab.querySelector<HTMLButtonElement>('[role=tab]')!;
        tab.classList.toggle('is-selected', selected);
        pick.setAttribute('aria-selected', String(selected));
        pick.tabIndex = selected ? 0 : -1;
      }
      return;
    }

    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.work-dock-tab');
    const focusedKey = focused && elements.tabs.contains(focused) ? focused.dataset.key : null;
    const focusedClose = Boolean(focusedKey && (document.activeElement as HTMLElement).classList.contains('btn-icon'));
    signature = nextSignature;
    elements.tabs.replaceChildren();

    for (const key of opened) {
      const terminalId = key.startsWith('terminal:') ? key.slice('terminal:'.length) : null;
      const terminal = terminalId ? terminalTabs.find(entry => entry.id === terminalId) : null;
      const view = terminalId ? null : views.get(key as AdoptableView);
      if (!terminal && !view) continue;

      const tab = el('div', `work-dock-tab${active === key ? ' is-selected' : ''}`);
      tab.dataset.key = key;
      if (terminalId) tab.dataset.terminalId = terminalId;
      const pick = el('button', 'btn') as HTMLButtonElement;
      pick.append(icon(terminalId ? 'i-terminal' : view!.glyph), el('span', 'tab-label', () => terminal
        ? `${terminal.title}${terminal.exited ? ` · ${t('exited')}` : ''}` : t(view!.label)));
      pick.type = 'button';
      pick.setAttribute('role', 'tab');
      if (terminal) pick.title = terminal.title;
      pick.setAttribute('aria-selected', String(active === key));
      pick.tabIndex = active === key ? 0 : -1;
      pick.addEventListener('click', () => activate(key));
      const remove = createDockIconButton('i-x', terminalId ? 'Close terminal' : 'Close tab');
      remove.addEventListener('click', () => {
        close(key);
        (elements.tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')
          ?? (elements.bar.hidden ? elements.launch.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? elements.rightToggle : elements.plus)).focus();
      });
      tab.append(pick, remove);
      elements.tabs.append(tab);
    }

    if (focusedKey) {
      const replacement = [...elements.tabs.children].find(node => (node as HTMLElement).dataset.key === focusedKey);
      (replacement?.querySelector<HTMLButtonElement>(focusedClose ? '.btn:last-child' : '[role=tab]'))?.focus();
    }
  };

  return { render };
}
