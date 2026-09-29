import type { SidebarOrderEntry, SidebarOrderPreferences } from './order-preferences.js';

interface DragSession {
  pointerId: number;
  itemId: string;
  scope: string;
  startX: number;
  startY: number;
  row: HTMLElement;
  active: boolean;
  targetId?: string;
  afterTarget?: boolean;
}

export function installSidebarOrderInteractions(
  list: HTMLElement,
  entries: () => SidebarOrderEntry[],
  preferences: SidebarOrderPreferences,
  repaint: () => void
): { get interacting(): boolean } {
  let drag: DragSession | null = null;
  let swallowDropClick = false;

  const itemId = (row: HTMLElement): string | undefined => row.dataset.sortId ?? row.dataset.id;
  const scopeOf = (row: HTMLElement): string => row.dataset.sortScope ?? '';
  const handleOf = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('[data-sort-handle]') ?? row;
  const visibleRows = (scope: string): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('[data-sort-scope]')]
    .filter(row => scopeOf(row) === scope && row.getClientRects().length > 0);

  function clearDropTargets(): void {
    for (const row of list.querySelectorAll('.sort-before, .sort-after')) {
      row.classList.remove('sort-before', 'sort-after');
    }
  }

  function finish(commit: boolean): void {
    const session = drag;
    if (!session) return;
    drag = null;

    if (commit && session.active && session.targetId) {
      preferences.move(session.itemId, session.targetId, !!session.afterTarget, session.scope, entries());
    }
    session.row.classList.remove('is-sorting');
    list.classList.remove('is-sorting');
    clearDropTargets();
    if (list.hasPointerCapture(session.pointerId)) list.releasePointerCapture(session.pointerId);

    if (session.active) {
      repaint();
      window.requestAnimationFrame(() => { swallowDropClick = false; });
    }
  }

  list.addEventListener('pointerdown', event => {
    swallowDropClick = false;
    const target = event.target as Element;
    if (event.button !== 0 || event.isPrimary === false || drag || target.closest('button, input, a')) return;
    const row = target.closest<HTMLElement>('[data-sort-scope]');
    const id = row && itemId(row);
    if (!row || !id || !list.contains(row) || !handleOf(row).contains(target)) return;
    drag = {
      pointerId: event.pointerId,
      itemId: id,
      scope: scopeOf(row),
      startX: event.clientX,
      startY: event.clientY,
      row,
      active: false
    };
  });

  list.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    if (!drag.active) {
      drag.active = true;
      swallowDropClick = true;
      list.setPointerCapture(event.pointerId);
      list.classList.add('is-sorting');
      drag.row.classList.add('is-sorting');
      document.getElementById('sessionTooltip')?.remove();
    }

    event.preventDefault();
    scrollAtEdge(event.clientY);
    markTarget(event.clientY);
  });

  window.addEventListener('pointerup', event => {
    if (event.pointerId === drag?.pointerId) finish(true);
  });
  window.addEventListener('pointercancel', event => {
    if (event.pointerId === drag?.pointerId) finish(false);
  });
  list.addEventListener('lostpointercapture', () => finish(false));
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !drag) return;
    event.preventDefault();
    finish(false);
  });
  list.addEventListener('click', event => {
    if (!swallowDropClick) return;
    swallowDropClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  list.addEventListener('keydown', moveWithKeyboard);

  function scrollAtEdge(y: number): void {
    const scroll = list.closest<HTMLElement>('.scroll');
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect();
    if (y < bounds.top + 28) scroll.scrollTop -= 18;
    else if (y > bounds.bottom - 28) scroll.scrollTop += 18;
  }

  function markTarget(y: number): void {
    if (!drag) return;
    const candidates = visibleRows(drag.scope).filter(row => itemId(row) !== drag!.itemId);
    clearDropTargets();
    const before = candidates.find(row => {
      const bounds = row.getBoundingClientRect();
      return y < bounds.top + bounds.height / 2;
    });
    const target = before ?? candidates.at(-1);
    drag.targetId = target && itemId(target);
    drag.afterTarget = !before;
    target?.classList.add(before ? 'sort-before' : 'sort-after');
  }

  function moveWithKeyboard(event: KeyboardEvent): void {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const target = event.target as Element;
    const row = target.closest<HTMLElement>('[data-sort-scope]');
    const id = row && itemId(row);
    if (!row || !id || target !== handleOf(row)) return;

    const scope = scopeOf(row);
    const siblings = visibleRows(scope);
    const nextRow = siblings[siblings.indexOf(row) + (event.key === 'ArrowUp' ? -1 : 1)];
    event.preventDefault();
    const targetId = nextRow && itemId(nextRow);
    if (!targetId || !preferences.move(id, targetId, event.key === 'ArrowDown', scope, entries())) return;

    repaint();
    const replacement = [...list.querySelectorAll<HTMLElement>('[data-sort-scope]')]
      .find(candidate => itemId(candidate) === id && scopeOf(candidate) === scope);
    replacement && handleOf(replacement).focus({ preventScroll: true });
  }

  return { get interacting() { return drag !== null; } };
}
