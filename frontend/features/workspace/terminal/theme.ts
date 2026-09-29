import { onAppearanceChanged } from '../../settings/appearance.js';
import type { TerminalTab } from './contracts.js';

export function readTerminalTheme(app: HTMLElement) {
  const colors = getComputedStyle(app);
  const background = colors.getPropertyValue('--page').trim();
  const foreground = colors.getPropertyValue('--ink').trim();
  return { background, foreground, cursor: foreground, cursorAccent: background };
}

export function observeTerminalTheme(app: HTMLElement, tabs: Map<string, TerminalTab>): () => void {
  return onAppearanceChanged(() => {
    const theme = readTerminalTheme(app);
    for (const tab of tabs.values()) if (tab.term) tab.term.options.theme = theme;
  });
}
