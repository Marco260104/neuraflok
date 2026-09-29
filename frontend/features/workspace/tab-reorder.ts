const DRAG_DISTANCE = 5;
const NEIGHBOR_TRANSITION = '160ms cubic-bezier(.22, 1, .36, 1)';
const DROP_ANIMATION = { duration: 160, easing: 'cubic-bezier(.22, 1, .36, 1)' };

export type TabReorder = {
  item: string;
  key: (node: HTMLElement) => string | undefined;
  move: (key: string, index: number) => void;
};

type PointerIntent = { pointerId: number; startX: number; tab: HTMLElement };
type TabLayout = { tab: HTMLElement; left: number; right: number; center: number; width: number };
type DragSession = {
  tab: HTMLElement;
  key: string;
  startIndex: number;
  targetIndex: number;
  layout: TabLayout[];
  minOffset: number;
  maxOffset: number;
  step: number;
  offset: number;
};

function tabsIn(strip: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(strip.children).filter(child => child.matches(selector)) as HTMLElement[];
}

function observesReducedMotion(node: HTMLElement): boolean {
  return node.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function pointerIntent(event: PointerEvent, strip: HTMLElement, selector: string): PointerIntent | null {
  if (event.button !== 0) return null;
  const target = event.target as Element | null;
  const tab = target?.closest<HTMLElement>(selector);
  if (!tab || tab.parentElement !== strip || target?.closest('.btn-icon')) return null;
  return { pointerId: event.pointerId, startX: event.clientX, tab };
}

function createDragSession(strip: HTMLElement, intent: PointerIntent, options: TabReorder): DragSession | null {
  const tabs = tabsIn(strip, options.item);
  const startIndex = tabs.indexOf(intent.tab);
  const key = options.key(intent.tab);
  if (tabs.length < 2 || startIndex < 0 || key === undefined) return null;

  const layout = tabs.map(tab => {
    const rect = tab.getBoundingClientRect();
    return { tab, left: rect.left, right: rect.right, center: rect.left + rect.width / 2, width: rect.width };
  });
  const active = layout[startIndex]!;
  const adjacentGap = startIndex + 1 < layout.length
    ? layout[startIndex + 1]!.left - active.right
    : active.left - layout[startIndex - 1]!.right;
  const spacing = Number.isFinite(adjacentGap) ? adjacentGap : 0;

  return {
    tab: intent.tab,
    key,
    startIndex,
    targetIndex: startIndex,
    layout,
    minOffset: layout[0]!.left - active.left,
    maxOffset: layout.at(-1)!.right - active.right,
    step: active.width + spacing,
    offset: 0
  };
}

function clampedOffset(session: DragSession, pointerDelta: number): number {
  return Math.max(session.minOffset, Math.min(session.maxOffset, pointerDelta));
}

function indexAtOffset(session: DragSession): number {
  const active = session.layout[session.startIndex]!;
  const center = active.center + session.offset;
  let index = session.startIndex;
  while (index + 1 < session.layout.length && center >= session.layout[index + 1]!.center) index++;
  while (index > 0 && center <= session.layout[index - 1]!.center) index--;
  return index;
}

function paintDrag(session: DragSession): void {
  session.tab.style.transform = `translateX(${session.offset}px)`;
  session.layout.forEach(({ tab }, index) => {
    if (tab === session.tab) return;
    const movesLeft = session.startIndex < index && index <= session.targetIndex;
    const movesRight = session.targetIndex <= index && index < session.startIndex;
    const offset = movesLeft ? -session.step : movesRight ? session.step : 0;
    tab.style.transform = offset === 0 ? '' : `translateX(${offset}px)`;
  });
}

function clearDrag(strip: HTMLElement, session: DragSession): void {
  for (const { tab } of session.layout) {
    tab.style.transition = '';
    tab.style.transform = '';
  }
  strip.classList.remove('is-reordering');
  session.tab.classList.remove('is-dragging');
}

function suppressDropClick(strip: HTMLElement): void {
  const ignoreClick = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
  };
  strip.addEventListener('click', ignoreClick, { capture: true, once: true });
  setTimeout(() => strip.removeEventListener('click', ignoreClick, true), 0);
}

function settleDroppedTab(strip: HTMLElement, session: DragSession, options: TabReorder): void {
  const node = tabsIn(strip, options.item).find(tab => options.key(tab) === session.key);
  if (!node || typeof node.animate !== 'function' || observesReducedMotion(node)) return;
  const originalLeft = session.layout[session.startIndex]!.left;
  const droppedLeft = originalLeft + session.offset;
  const correction = droppedLeft - node.getBoundingClientRect().left;
  if (Math.abs(correction) <= 0.5) return;
  node.animate([{ transform: `translateX(${correction}px)` }, { transform: 'none' }], DROP_ANIMATION);
}

export function enableTabReorder(strip: HTMLElement, options: TabReorder): void {
  let intent: PointerIntent | null = null;
  let session: DragSession | null = null;

  strip.addEventListener('pointerdown', event => {
    if (intent || session || tabsIn(strip, options.item).length < 2) return;
    intent = pointerIntent(event, strip, options.item);
  });

  strip.addEventListener('pointermove', event => {
    if (!intent || intent.pointerId !== event.pointerId) return;
    const movement = event.clientX - intent.startX;
    if (!session) {
      if (Math.abs(movement) < DRAG_DISTANCE) return;
      session = createDragSession(strip, intent, options);
      if (!session) { intent = null; return; }
      if (typeof strip.setPointerCapture === 'function') strip.setPointerCapture(event.pointerId);
      strip.classList.add('is-reordering');
      session.tab.classList.add('is-dragging');
      if (!observesReducedMotion(strip)) {
        for (const { tab } of session.layout) if (tab !== session.tab) tab.style.transition = `transform ${NEIGHBOR_TRANSITION}`;
      }
    }

    session.offset = clampedOffset(session, movement);
    const nextIndex = indexAtOffset(session);
    if (nextIndex !== session.targetIndex) session.targetIndex = nextIndex;
    paintDrag(session);
  });

  const finish = (event: PointerEvent): void => {
    if (!intent || intent.pointerId !== event.pointerId) return;
    intent = null;
    const completed = session;
    session = null;
    if (!completed) return;

    if (typeof strip.hasPointerCapture === 'function' && strip.hasPointerCapture(event.pointerId)) {
      strip.releasePointerCapture(event.pointerId);
    }
    suppressDropClick(strip);
    clearDrag(strip, completed);
    if (completed.targetIndex !== completed.startIndex) options.move(completed.key, completed.targetIndex);
    settleDroppedTab(strip, completed, options);
  };

  strip.addEventListener('pointerup', finish);
  strip.addEventListener('pointercancel', finish);
}

export function reorderKey(event: KeyboardEvent): -1 | 1 | 0 {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return 0;
  if (event.key === 'ArrowLeft') return -1;
  if (event.key === 'ArrowRight') return 1;
  return 0;
}
