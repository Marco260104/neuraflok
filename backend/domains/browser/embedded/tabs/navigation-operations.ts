import { publishTabUpdate } from './events.js';
import { TabReadModel } from './read-model.js';
import { TabModelState } from './runtime-state.js';
import type { TabChange, TabRecord } from './model-contracts.js';

export class NavigationOperations {
  constructor(private readonly state: TabModelState, private readonly read: TabReadModel) {}

  navigationStarted(id: number, url: string): void {
    const tab = this.state.tabs.get(id);
    if (!tab) return;
    tab.pendingUrl = url;
    if (tab.status !== 'loading') {
      tab.status = 'loading';
      this.update(tab, { status: 'loading' });
    }
  }

  navigationCommitted(id: number, url: string): void {
    const tab = this.state.tabs.get(id);
    if (!tab) return;
    delete tab.pendingUrl;
    const changed = tab.url !== url;
    tab.url = url;
    const change: TabChange = {};
    if (tab.status !== 'loading') { tab.status = 'loading'; change.status = 'loading'; }
    if (changed) change.url = url;
    if (Object.keys(change).length) this.update(tab, change);
  }

  sameDocumentNavigated(id: number, url: string): void {
    const tab = this.state.tabs.get(id);
    if (!tab || tab.url === url) return;
    tab.url = url;
    this.update(tab, { url });
  }

  titleChanged(id: number, title: string): void {
    const tab = this.state.tabs.get(id);
    if (!tab || tab.title === title) return;
    tab.title = title;
    this.update(tab, { title });
  }

  loadingStopped(id: number): void {
    const tab = this.state.tabs.get(id);
    if (!tab) return;
    delete tab.pendingUrl;
    if (tab.status === 'complete') return;
    tab.status = 'complete';
    this.update(tab, { status: 'complete' });
  }

  private update(tab: TabRecord, change: TabChange): void {
    publishTabUpdate(this.state, this.read, tab, change);
  }
}
