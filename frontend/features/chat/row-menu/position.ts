import type { RowMenuOptions } from './types.js';

const EDGE = 8;

export function placeRowMenu(menu: HTMLElement, options: RowMenuOptions): void {
  if (options.at) {
    placeMenuAt(menu, options.at.x, options.at.y);
    return;
  }
  const anchor = options.anchor()?.getBoundingClientRect();
  if (anchor && anchor.width > 0) placeMenuBeside(menu, anchor, 'below');
  else placeMenuAt(menu, EDGE, EDGE);
}

export function placeMenuAt(menu: HTMLElement, x: number, y: number): void {
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE))}px`;
  menu.style.top = `${Math.max(EDGE, y + height > window.innerHeight - EDGE ? y - height : y)}px`;
}

export function placeMenuBeside(menu: HTMLElement, box: DOMRect, side: 'below' | 'right'): void {
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left: number;
  let top: number;
  if (side === 'below') {
    left = box.left;
    top = box.bottom + 4;
    if (top + height > window.innerHeight - EDGE) top = box.top - height - 4;
  } else {
    left = box.right + 2;
    if (left + width > window.innerWidth - EDGE) left = box.left - width - 2;
    top = box.top - 5;
  }
  menu.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE))}px`;
  menu.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE))}px`;
}
