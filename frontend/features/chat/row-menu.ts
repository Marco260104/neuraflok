import { renderRowMenuLevel, type RowMenuRenderActions } from './row-menu/render.js';
import { placeMenuBeside, placeRowMenu } from './row-menu/position.js';
import type { RowMenuItem, RowMenuOptions } from './row-menu/types.js';

export type { RowMenuItem, RowMenuOptions } from './row-menu/types.js';

const SUBMENU_DELAY_MS = 120;

type OpenMenu = {
  options: RowMenuOptions;
  levels: HTMLElement[];
  openTimer: number;
  refreshers: Array<() => void>;
  pixelRatio: number;
};

let current: OpenMenu | null = null;
const listeners = new Set<() => void>();

export function rowMenuOpenFor(owner: string): boolean {
  return current?.options.owner === owner;
}

export function onRowMenuChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyChange(): void {
  for (const listener of listeners) listener();
}

export function closeRowMenu(restoreFocus = false): void {
  if (!current) return;
  const { options, levels, openTimer } = current;
  window.clearTimeout(openTimer);
  current = null;
  for (const level of levels) leave(level);
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('scroll', scrolled, true);
  window.removeEventListener('resize', resized);
  window.removeEventListener('blur', resized);
  options.anchor()?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) options.anchor()?.focus({ preventScroll: true });
  notifyChange();
}

export function toggleRowMenu(options: RowMenuOptions): void {
  if (rowMenuOpenFor(options.owner) && !options.at) {
    closeRowMenu(true);
    return;
  }
  openRowMenu(options);
}

export function refreshRowMenu(): void {
  for (const refresh of current?.refreshers ?? []) refresh();
}

export function openRowMenu(options: RowMenuOptions): void {
  closeRowMenu();
  current = { options, levels: [], openTimer: 0, refreshers: [], pixelRatio: window.devicePixelRatio };
  options.anchor()?.setAttribute('aria-expanded', 'true');
  const menu = renderRowMenuLevel(options.items(), options.label, 0, renderActions());
  document.body.append(menu);
  current.levels.push(menu);
  placeRowMenu(menu, options);
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('scroll', scrolled, true);
  window.addEventListener('resize', resized);
  window.addEventListener('blur', resized);
  focusItem(menu, 0);
  notifyChange();
}

function renderActions(): RowMenuRenderActions {
  return {
    keydown,
    openSubmenu,
    closeMenu: closeRowMenu,
    closeBelow: closeLevelsBelow,
    scheduleSubmenu(open) {
      if (!current) return;
      window.clearTimeout(current.openTimer);
      current.openTimer = window.setTimeout(open, SUBMENU_DELAY_MS);
    },
    cancelSubmenu() {
      if (current) window.clearTimeout(current.openTimer);
    },
    refresh: refreshRowMenu,
    trackHint(refresh) {
      current?.refreshers.push(refresh);
    }
  };
}

function leave(level: HTMLElement): void {
  level.className = 'row-menu-leaving';
  level.removeAttribute('role');
  const animation = window.getComputedStyle(level).animationName;
  if (!animation || animation === 'none') {
    level.remove();
    return;
  }
  level.addEventListener('animationend', () => level.remove(), { once: true });
  window.setTimeout(() => level.remove(), 200);
}

function outside(event: PointerEvent): void {
  if (!current) return;
  const target = event.target as Node | null;
  if (target && current.levels.some(level => level.contains(target))) return;
  if (target && current.options.anchor()?.contains(target)) return;
  closeRowMenu();
}

function scrolled(event: Event): void {
  if (!current) return;
  const target = event.target as Node | null;
  if (target && current.levels.some(level => level.contains(target))) return;
  closeRowMenu();
}

function resized(event: Event): void {
  if (!current) return;
  if (event.type !== 'resize' || window.devicePixelRatio === current.pixelRatio) {
    closeRowMenu();
    return;
  }
  current.pixelRatio = window.devicePixelRatio;
  closeLevelsBelow(0);
  const menu = current.levels[0];
  if (menu) placeRowMenu(menu, current.options);
}

function openSubmenu(item: RowMenuItem, button: HTMLButtonElement, depth: number, focusFirst: boolean): void {
  if (!current || !item.submenu) return;
  window.clearTimeout(current.openTimer);
  const open = current.levels[depth + 1];
  if (open?.dataset.parentAction === item.action) {
    if (focusFirst) focusItem(open, checkedIndex(open));
    return;
  }
  closeLevelsBelow(depth);
  const submenu = renderRowMenuLevel(item.submenu(), item.label, depth + 1, renderActions());
  submenu.dataset.parentAction = item.action;
  document.body.append(submenu);
  current.levels.push(submenu);
  button.setAttribute('aria-expanded', 'true');
  placeMenuBeside(submenu, button.getBoundingClientRect(), 'right');
  if (focusFirst) focusItem(submenu, checkedIndex(submenu));
}

function closeLevelsBelow(depth: number): void {
  if (!current) return;
  for (const extra of current.levels.splice(depth + 1)) leave(extra);
  current.levels[depth]?.querySelectorAll('[aria-haspopup="menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('.row-menu-item:not(:disabled)')];
}

function checkedIndex(menu: HTMLElement): number {
  const index = enabledItems(menu).findIndex(button => button.getAttribute('aria-checked') === 'true');
  return Math.max(0, index);
}

function focusItem(menu: HTMLElement, index: number): void {
  const items = enabledItems(menu);
  items[Math.min(Math.max(0, index), items.length - 1)]?.focus({ preventScroll: true });
}

function keydown(event: KeyboardEvent, menu: HTMLElement, depth: number): void {
  if (!current) return;
  const items = enabledItems(menu);
  const active = items.indexOf(document.activeElement as HTMLButtonElement);
  const move = (index: number): void => {
    event.preventDefault();
    items[(index + items.length) % items.length]?.focus({ preventScroll: true });
  };
  switch (event.key) {
    case 'ArrowDown': return move(active + 1);
    case 'ArrowUp': return move(active < 0 ? items.length - 1 : active - 1);
    case 'Home': return move(0);
    case 'End': return move(items.length - 1);
    case 'ArrowRight': {
      const button = items[active];
      if (button?.getAttribute('aria-haspopup') === 'menu') {
        event.preventDefault();
        button.click();
      }
      return;
    }
    case 'ArrowLeft':
    case 'Escape': {
      event.preventDefault();
      event.stopPropagation();
      if (depth > 0) {
        const parent = current.levels[depth - 1];
        const action = menu.dataset.parentAction;
        closeLevelsBelow(depth - 1);
        parent?.querySelector<HTMLElement>(`[data-row-action="${action}"]`)?.focus({ preventScroll: true });
      } else if (event.key === 'Escape') closeRowMenu(true);
      return;
    }
    case 'Tab': closeRowMenu(); return;
  }
}
