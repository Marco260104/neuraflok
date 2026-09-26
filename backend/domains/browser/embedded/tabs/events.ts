import { TabModelState } from './runtime-state.js';
import { TabReadModel } from './read-model.js';
import type { TabChange, TabRecord } from './model-contracts.js';

export function publishTabUpdate(state: TabModelState, read: TabReadModel, tab: TabRecord, change: TabChange): void {
  state.emit({ name: 'tabs.onUpdated', args: [tab.id, change, read.tab(tab.id)!] });
}
