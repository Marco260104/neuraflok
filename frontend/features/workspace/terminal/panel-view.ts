import { el, icon } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';
import type { TerminalPanelElements, WorkspaceTerminalOptions } from './contracts.js';

export function createTerminalIconButton(glyph: string, label: string): HTMLButtonElement {
  const node = el('button', 'btn btn-icon') as HTMLButtonElement;
  node.type = 'button';
  node.append(icon(glyph));
  ui(node, 'title', () => t(label));
  ui(node, 'aria-label', () => t(label));
  return node;
}

export function createTerminalPanelView(
  initialMount: HTMLElement,
  options: WorkspaceTerminalOptions
): TerminalPanelElements {
  const panel = el('section', 'workspace-terminal');
  panel.id = options.id ?? 'workspaceTerminal';
  panel.hidden = true;
  ui(panel, 'aria-label', () => t('Terminal'));
  const bar = el('div', 'terminal-bar');
  const tabsHost = el('div', 'terminal-tabs');
  const body = el('div', 'terminal-body');
  const add = createTerminalIconButton('i-plus', 'New terminal');
  add.id = panel.id === 'workspaceTerminal' ? 'terminalNew' : `${panel.id}New`;
  const addMenu = el('details', 'work-dock-add') as HTMLDetailsElement;
  const addTrigger = el('summary');
  addTrigger.append(icon('i-plus'));
  ui(addTrigger, 'title', () => t('New tab'));
  ui(addTrigger, 'aria-label', () => t('New tab'));
  const addChoices = el('div', 'work-dock-menu');
  add.className = 'btn work-dock-menu-item';
  add.replaceChildren(icon('i-terminal'));
  add.append(el('span', '', () => t('Terminal')));
  addChoices.append(add);
  addMenu.append(addTrigger, addChoices);
  const empty = el('button', 'btn terminal-empty', () => t('Open a terminal in this project')) as HTMLButtonElement;
  empty.type = 'button';
  body.append(empty);
  bar.append(tabsHost, addMenu);
  if (options.onClosePanel) {
    const closePanel = createTerminalIconButton('i-x', 'Hide bottom panel');
    closePanel.classList.add('terminal-panel-close');
    closePanel.addEventListener('click', options.onClosePanel);
    bar.append(closePanel);
  }
  if (!options.dockedTabs) panel.append(bar);
  panel.append(body);
  initialMount.append(panel);
  return { panel, body, tabsHost, add, addMenu, addTrigger, empty };
}
