import { t, ui } from '../../shared/i18n.js';
import { refreshRowMenu, rowMenuOpenFor, toggleRowMenu } from '../chat/row-menu.js';
import { createViewMenuItems, type ViewMenuActions } from './view-menu-items.js';

export type { ViewMenuActions } from './view-menu-items.js';

const OWNER = 'view-menu';

export function initViewMenu(actions: ViewMenuActions): { refresh(): void } {
  const button = document.getElementById('viewMenu') as HTMLButtonElement;
  const label = () => t('View');

  ui(button, 'title', label);
  ui(button, 'aria-label', label);
  button.addEventListener('click', () => {
    toggleRowMenu({ owner: OWNER, anchor: () => button, label, items: () => createViewMenuItems(actions) });
  });
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' || rowMenuOpenFor(OWNER)) return;
    event.preventDefault();
    button.click();
  });

  return {
    refresh: () => {
      if (rowMenuOpenFor(OWNER)) refreshRowMenu();
    }
  };
}
