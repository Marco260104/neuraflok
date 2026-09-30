import { t } from '../../../shared/i18n.js';
import type { LocalProject } from '../../../../contracts/workspace/projects.js';
import { enableTabReorder, reorderKey } from '../tab-reorder.js';
import type { TerminalTab, WorkspaceTerminalOptions } from './contracts.js';
import { observeTerminalEvents } from './events.js';
import { createTerminalPanelView } from './panel-view.js';
import { createTerminalTabListView } from './tab-list-view.js';
import { createTerminalSession, startTerminalSession } from './session.js';
import { observeTerminalTheme, readTerminalTheme } from './theme.js';

export type { WorkspaceTerminalTab } from './contracts.js';

export function createWorkspaceTerminal(
  onToggleBottom: () => void,
  initialMount: HTMLElement,
  options: WorkspaceTerminalOptions = {}
) {
  const app = document.querySelector<HTMLElement>('.app')!;
  const panel = createTerminalPanelView(initialMount, options);
  const tabs = new Map<string, TerminalTab>();
  const terminalListView = createTerminalTabListView(panel, options);
  const stopAppearance = observeTerminalTheme(app, tabs);
  let project: LocalProject | null = null;
  let selected: string | null = null;
  let open = false;
  let disposed = false;

  function fit(): void {
    const tab = selected ? tabs.get(selected) : null;
    if (!tab?.fit || !tab.term || !open || !tab.node.getBoundingClientRect().height) return;
    tab.fit.fit();
    if (tab.ready && !tab.exited) {
      void window.api.terminalResize(tab.id, Math.min(500, tab.term.cols), Math.min(200, tab.term.rows));
    }
  }

  function paint(): void {
    terminalListView(tabs, selected, project?.name ?? null, selectTab, closeTab);
  }

  function setOpen(value: boolean): void {
    open = value;
    panel.panel.hidden = !value;
    if (value) requestAnimationFrame(() => { fit(); if (selected) tabs.get(selected)?.term?.focus(); });
  }

  function selectTab(id: string): void {
    if (!tabs.has(id)) return;
    selected = id;
    paint();
    fit();
    if (open) tabs.get(id)?.term?.focus();
  }

  function closeTab(id: string): void {
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    tab.term?.dispose();
    tab.node.remove();
    void window.api.terminalClose(id);
    if (selected === id) selected = [...tabs.keys()].at(-1) ?? null;
    paint();
    fit();
    if (!tabs.size) options.onEmpty?.();
  }

  function create(): string | null {
    const scope = project;
    if (tabs.size >= 8) return null;
    const id = crypto.randomUUID();
    const tab = createTerminalSession(id, scope?.name ?? t('Terminal'), panel.body);
    tabs.set(id, tab);
    selected = id;
    if (!options.dockedTabs) setOpen(true);
    paint();
    fit();
    void startTerminalSession(tab, scope, {
      isRetained: () => !disposed && tabs.has(id),
      isOpen: () => open,
      isSelected: () => selected === id,
      refresh: paint,
      fit,
      onTabsChanged: () => options.onTabsChanged?.()
    }, () => readTerminalTheme(app), onToggleBottom);
    return id;
  }

  function moveTab(id: string, index: number): void {
    const order = [...tabs.values()];
    const from = order.findIndex(tab => tab.id === id);
    if (from < 0) return;
    const [tab] = order.splice(from, 1);
    order.splice(Math.max(0, Math.min(order.length, index)), 0, tab!);
    tabs.clear();
    for (const entry of order) tabs.set(entry.id, entry);
    paint();
    options.onTabsChanged?.();
  }

  const stopEvents = observeTerminalEvents(tabs, paint, () => options.onTabsChanged?.());
  if (!options.dockedTabs) {
    enableTabReorder(panel.tabsHost, { item: '.terminal-tab', key: node => node.dataset.id, move: moveTab });
    panel.tabsHost.addEventListener('keydown', event => {
      const step = reorderKey(event);
      if (!step || !selected || tabs.size < 2) return;
      event.preventDefault();
      event.stopPropagation();
      moveTab(selected, [...tabs.keys()].indexOf(selected) + step);
      panel.tabsHost.querySelector<HTMLButtonElement>('.terminal-tab.is-selected > .btn:first-child')?.focus();
    });
  }
  panel.add.addEventListener('click', () => { panel.addMenu.open = false; void create(); });
  panel.empty.addEventListener('click', () => void create());
  panel.addMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      panel.addMenu.open = false;
      panel.addTrigger.focus();
    }
  });
  document.addEventListener('click', event => {
    if (panel.addMenu.open && !panel.addMenu.contains(event.target as Node)) panel.addMenu.open = false;
  });
  const observer = new ResizeObserver(fit);
  observer.observe(panel.body);
  window.addEventListener('beforeunload', () => {
    disposed = true;
    observer.disconnect();
    stopEvents();
    stopAppearance();
    for (const tab of tabs.values()) tab.term?.dispose();
  }, { once: true });
  paint();

  return {
    update(value: LocalProject | null): void { project = value; paint(); },
    show(mount: HTMLElement, createIfEmpty = true): void {
      if (panel.panel.parentElement !== mount) mount.append(panel.panel);
      setOpen(true);
      if (createIfEmpty && !tabs.size) void create();
    },
    newTab(): string | null { return create(); },
    tabs() { return [...tabs.values()].map(tab => ({ id: tab.id, title: tab.title, exited: tab.exited })); },
    selectTab,
    closeTab,
    hide(): void { setOpen(false); },
    visible(): boolean { return open; },
    hasTabs(): boolean { return tabs.size > 0; }
  };
}
