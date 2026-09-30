import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

export type TerminalTab = {
  id: string;
  title: string;
  node: HTMLElement;
  term: Terminal | null;
  fit: FitAddon | null;
  ready: boolean;
  exited: boolean;
  queued: number;
  writes: Promise<void>;
};

export type WorkspaceTerminalTab = { id: string; title: string; exited: boolean };

export type WorkspaceTerminalOptions = {
  id?: string;
  onEmpty?: () => void;
  onClosePanel?: () => void;
  dockedTabs?: boolean;
  onTabsChanged?: () => void;
};

export type TerminalPanelElements = {
  panel: HTMLElement;
  body: HTMLElement;
  tabsHost: HTMLElement;
  add: HTMLButtonElement;
  addMenu: HTMLDetailsElement;
  addTrigger: HTMLElement;
  empty: HTMLButtonElement;
};

export type TerminalSessionCallbacks = {
  isRetained: () => boolean;
  isOpen: () => boolean;
  isSelected: () => boolean;
  refresh: () => void;
  fit: () => void;
  onTabsChanged: () => void;
};
