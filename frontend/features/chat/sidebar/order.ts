import { createSidebarOrderPreferences, type SidebarOrderEntry } from './order-preferences.js';
import { installSidebarOrderInteractions } from './order-interactions.js';

export function createSidebarOrder(
  list: HTMLElement,
  entries: () => SidebarOrderEntry[],
  repaint: () => void
) {
  const preferences = createSidebarOrderPreferences();
  const interactions = installSidebarOrderInteractions(list, entries, preferences, repaint);
  return {
    ordered: preferences.ordered,
    get interacting() { return interactions.interacting; }
  };
}
