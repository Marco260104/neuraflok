import { t } from '../../../shared/i18n.js';
import type { TerminalTab } from './contracts.js';

export function observeTerminalEvents(
  tabs: Map<string, TerminalTab>,
  refresh: () => void,
  onTabsChanged: () => void
): () => void {
  return window.api.onTerminalEvent(event => {
    const tab = tabs.get(event.id);
    if (!tab) return;
    if ('data' in event) {
      if (tab.term) tab.term.write(event.data, () => { void window.api.terminalAck(event.id, event.data.length); });
      else void window.api.terminalAck(event.id, event.data.length);
      return;
    }
    tab.exited = true;
    tab.term?.write(`\r\n[${t('Process exited: {0}', [event.exitCode])}]\r\n`);
    refresh();
    onTabsChanged();
  });
}
