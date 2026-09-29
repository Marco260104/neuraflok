import { t } from '../../shared/i18n.js';
import type { RowMenuItem } from '../chat/row-menu.js';
import { primaryShortcut } from './shortcuts.js';

export interface ViewMenuActions {
  search(): void;
  integratedBrowser(): boolean;
  showIntegratedBrowser(): void;
  zoom: { step(delta: number): Promise<void>; reset(): Promise<void>; percent(): number };
}

export function createViewMenuItems(actions: ViewMenuActions): RowMenuItem[] {
  const items: RowMenuItem[] = [
    { action: 'search', icon: 'i-search', shortcut: () => primaryShortcut('K'), label: () => t('Search chats'), run: actions.search }
  ];

  if (actions.integratedBrowser()) {
    items.push({
      action: 'integrated-browser',
      icon: 'i-browser',
      separated: true,
      label: () => t('Show browser'),
      run: actions.showIntegratedBrowser
    });
  }

  items.push(
    {
      action: 'zoom-in',
      icon: 'i-zoom-in',
      separated: true,
      keepOpen: true,
      shortcut: () => primaryShortcut('+'),
      label: () => t('Zoom in'),
      run: () => void actions.zoom.step(0.1)
    },
    {
      action: 'zoom-out',
      icon: 'i-zoom-out',
      keepOpen: true,
      shortcut: () => primaryShortcut('−'),
      label: () => t('Zoom out'),
      run: () => void actions.zoom.step(-0.1)
    },
    {
      action: 'zoom-reset',
      icon: 'i-zoom-reset',
      keepOpen: true,
      shortcut: () => primaryShortcut('0'),
      label: () => t('Actual size'),
      hint: () => `${Math.round(actions.zoom.percent())}%`,
      run: () => void actions.zoom.reset()
    }
  );

  return items;
}
