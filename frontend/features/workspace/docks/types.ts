export type DockView = 'review' | 'files' | 'agents' | 'terminal';
export type AdoptableView = Exclude<DockView, 'terminal'>;
export type DockTab = AdoptableView | `terminal:${string}`;

export interface DockViewRegistration {
  label: string;
  glyph: string;
  available(): boolean;
  show(mount: HTMLElement): void;
  hide(): void;
}

export interface DockTerminalTab {
  id: string;
  title: string;
  exited: boolean;
}

export interface DockTerminalView {
  show(mount: HTMLElement, createIfEmpty: boolean): void;
  hide(): void;
  canCreate(): boolean;
  newTab(): string | null;
  tabs(): DockTerminalTab[];
  selectTab(id: string): void;
  closeTab(id: string): void;
}

export type BottomTerminalView = Pick<DockTerminalView, 'show' | 'hide'>;
