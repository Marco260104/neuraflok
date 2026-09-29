import { el, icon } from '../../../shared/dom.js';
import { ui } from '../../../shared/i18n.js';
import type { RowMenuItem } from './types.js';

export interface RowMenuRenderActions {
  keydown(event: KeyboardEvent, menu: HTMLElement, depth: number): void;
  openSubmenu(item: RowMenuItem, button: HTMLButtonElement, depth: number, focusFirst: boolean): void;
  closeMenu(restoreFocus?: boolean): void;
  closeBelow(depth: number): void;
  scheduleSubmenu(open: () => void): void;
  cancelSubmenu(): void;
  refresh(): void;
  trackHint(refresh: () => void): void;
}

export function renderRowMenuLevel(items: RowMenuItem[], label: () => string, depth: number, actions: RowMenuRenderActions): HTMLElement {
  const menu = el('div', 'row-menu');
  menu.setAttribute('role', 'menu');
  menu.dataset.depth = String(depth);
  ui(menu, 'aria-label', label);
  for (const item of items) {
    if (item.separated && menu.childElementCount) menu.append(el('div', 'row-menu-separator'));
    menu.append(renderMenuItem(item, depth, actions));
  }
  menu.addEventListener('keydown', event => actions.keydown(event, menu, depth));
  return menu;
}

function renderMenuItem(item: RowMenuItem, depth: number, actions: RowMenuRenderActions): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `row-menu-item${item.danger ? ' is-danger' : ''}`;
  button.dataset.rowAction = item.action;
  for (const [key, value] of Object.entries(item.data ?? {})) button.dataset[key] = value;
  button.tabIndex = -1;
  button.disabled = item.disabled === true;
  button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
  if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
  if (item.swatch !== undefined) {
    const swatch = el('span', 'row-menu-swatch');
    swatch.dataset.color = item.swatch;
    button.append(swatch);
  } else if (item.icon) button.append(icon(item.icon));
  else button.append(el('span', 'row-menu-gap'));

  button.append(el('span', 'row-menu-label', item.label));
  if (item.hint) {
    const hint = item.hint;
    const value = el('span', 'row-menu-hint', hint);
    button.append(value);
    actions.trackHint(() => { value.textContent = hint(); });
  }
  if (item.shortcut) button.append(el('kbd', 'row-menu-shortcut', item.shortcut));
  if (item.title) ui(button, 'title', item.title);

  if (item.submenu) renderSubmenuTrigger(item, button, depth, actions);
  else renderActionButton(item, button, depth, actions);
  button.addEventListener('pointermove', () => {
    if (document.activeElement !== button && !button.disabled) button.focus({ preventScroll: true });
  });
  return button;
}

function renderSubmenuTrigger(item: RowMenuItem, button: HTMLButtonElement, depth: number, actions: RowMenuRenderActions): void {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.append(icon('i-page-next', 'ico row-menu-chevron'));
  button.addEventListener('click', event => {
    event.stopPropagation();
    actions.openSubmenu(item, button, depth, true);
  });
  button.addEventListener('pointerenter', () => {
    actions.scheduleSubmenu(() => actions.openSubmenu(item, button, depth, false));
  });
}

function renderActionButton(item: RowMenuItem, button: HTMLButtonElement, depth: number, actions: RowMenuRenderActions): void {
  if (item.checked) button.append(icon('i-check', 'ico row-menu-check'));
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (button.disabled) return;
    if (item.keepOpen) {
      item.run?.();
      actions.refresh();
      return;
    }
    actions.closeMenu(true);
    item.run?.();
  });
  button.addEventListener('pointerenter', () => {
    actions.cancelSubmenu();
    actions.closeBelow(depth);
  });
}
