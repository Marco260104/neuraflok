import { el, icon } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';
import type { TerminalPanelElements, TerminalTab, WorkspaceTerminalOptions } from './contracts.js';
import { createTerminalIconButton } from './panel-view.js';

export function createTerminalTabListView(
  panel: TerminalPanelElements,
  options: WorkspaceTerminalOptions
): (
  tabs: Map<string, TerminalTab>,
  selected: string | null,
  projectName: string | null,
  onSelect: (id: string) => void,
  onClose: (id: string) => void
) => void {
  let tabSignature = '';
  return (tabs, selected, projectName, onSelect, onClose) => {
    for (const tab of tabs.values()) tab.node.hidden = tab.id !== selected;
    const signature = [...tabs.values()].map(tab => `${tab.id}:${tab.title}:${tab.exited}`).join(',');
    if (!options.dockedTabs && signature === tabSignature) {
      for (const wrapper of panel.tabsHost.children as HTMLCollectionOf<HTMLElement>) {
        const current = wrapper.dataset.id === selected;
        wrapper.classList.toggle('is-selected', current);
        wrapper.querySelector('.btn')!.setAttribute('aria-pressed', String(current));
      }
    } else if (!options.dockedTabs) {
      tabSignature = signature;
      panel.tabsHost.replaceChildren();
    }
    for (const tab of tabs.values()) {
      if (options.dockedTabs || panel.tabsHost.childElementCount === tabs.size) continue;
      const wrapper = el('div', `terminal-tab${tab.id === selected ? ' is-selected' : ''}`);
      wrapper.dataset.id = tab.id;
      const pick = el('button', 'btn') as HTMLButtonElement;
      pick.append(icon('i-terminal'), el('span', 'tab-label', () => `${tab.title}${tab.exited ? ` · ${t('exited')}` : ''}`));
      pick.type = 'button';
      pick.title = tab.title;
      pick.setAttribute('aria-pressed', String(tab.id === selected));
      pick.addEventListener('click', () => onSelect(tab.id));
      const close = createTerminalIconButton('i-x', 'Close terminal');
      close.addEventListener('click', () => onClose(tab.id));
      wrapper.append(pick, close);
      panel.tabsHost.append(wrapper);
    }
    panel.empty.hidden = Boolean(options.dockedTabs) || tabs.size > 0;
    panel.add.disabled = tabs.size >= 8;
    ui(panel.empty, 'textContent', () => projectName ? t('Open a terminal in this project') : t('New terminal'));
  };
}
