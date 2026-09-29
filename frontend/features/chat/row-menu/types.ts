export interface RowMenuItem {
  action: string;
  label: () => string;
  icon?: string;
  title?: () => string;
  danger?: boolean;
  checked?: boolean;
  swatch?: string;
  disabled?: boolean;
  submenu?: () => RowMenuItem[];
  shortcut?: () => string;
  hint?: () => string;
  run?: () => void;
  keepOpen?: boolean;
  separated?: boolean;
  data?: Record<string, string>;
}

export interface RowMenuOptions {
  owner: string;
  anchor: () => HTMLElement | null;
  label: () => string;
  items: () => RowMenuItem[];
  at?: { x: number; y: number };
}
