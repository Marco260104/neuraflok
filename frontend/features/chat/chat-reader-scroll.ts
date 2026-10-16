import { $, el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { ROUNDING_PX } from './timeline-scroll.js';

interface Runtime {
  readonly selectionGeneration: number;
  readonly hasSendAnchor: boolean;
  readonly historyBefore: number | null;
  readonly hasHistoryDemand: boolean;
  readerAtEnd: boolean;
  readingAfterSend: boolean;
  timelineShown(): boolean;
  followOutput(): boolean;
  distanceFromTail(): number;
  paintJumpLatest(): void;
  jumpToLatest(): void;
  releaseSendHold(): void;
  holdSentMessage(): boolean;
  requestHistory(direction: number, opening?: boolean): void;
  fillTimelineHistory(): Promise<void>;
}

export function installChatReaderScroll(runtime: Runtime): void {
  const pane = $('chatBody');
  const timeline = $('timeline');
  const content = $('timelineContent');
  const INTENT_SETTLE_MS = 100;
  let intent: { generation: number; scrolled: boolean } | null = null;
  let heldPointer: { id: number; generation: number; middle: boolean; released: boolean } | null = null;
  let intentFrame: number | null = null;

  const clearIntent = (): void => {
    intent = null;
    heldPointer = null;
    if (intentFrame !== null) window.cancelAnimationFrame(intentFrame);
    intentFrame = null;
  };

  const noteIntent = (): void => {
    if (heldPointer && heldPointer.generation !== runtime.selectionGeneration) heldPointer = null;
    const owner = intent?.generation === runtime.selectionGeneration
      ? intent
      : { generation: runtime.selectionGeneration, scrolled: false };
    intent = owner;
    if (intentFrame !== null) window.cancelAnimationFrame(intentFrame);
    const armedAt = performance.now();
    let frames = 0;
    const expire = (): void => {
      frames++;
      if (frames < 2 || performance.now() - armedAt < INTENT_SETTLE_MS) {
        intentFrame = window.requestAnimationFrame(expire);
        return;
      }
      intentFrame = null;
      if (intent === owner && !owner.scrolled && heldPointer?.generation !== owner.generation) intent = null;
    };
    intentFrame = window.requestAnimationFrame(expire);
  };

  const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  pane.addEventListener('wheel', noteIntent, { passive: true });
  pane.addEventListener('touchmove', noteIntent, { passive: true });
  pane.addEventListener('keydown', event => {
    if (scrollKeys.has(event.key) && !(event.target as Element).closest('summary, button, a, input, textarea, select, [contenteditable]')) noteIntent();
  });
  pane.addEventListener('pointerdown', event => {
    if (heldPointer?.released && heldPointer.generation === runtime.selectionGeneration) {
      clearIntent();
      if (event.button === 1) return;
    }
    if (event.target !== pane && event.button !== 1) return;
    const middle = event.button === 1 && pane.scrollHeight > pane.clientHeight &&
      !(event.target as Element).closest('a, button, input, textarea, select, [contenteditable]');
    heldPointer = { id: event.pointerId, generation: runtime.selectionGeneration, middle, released: false };
    noteIntent();
  }, { passive: true, capture: true });

  const releasePointer = (event: PointerEvent): void => {
    if (!heldPointer || heldPointer.id !== event.pointerId) return;
    const generation = heldPointer.generation;
    if (heldPointer.middle && !intent?.scrolled && event.type === 'pointerup') {
      heldPointer.released = true;
      return;
    }
    heldPointer = null;
    if (intent?.generation === generation && (!intent.scrolled || event.type === 'pointercancel')) clearIntent();
  };
  window.addEventListener('pointerup', releasePointer, { passive: true });
  window.addEventListener('pointercancel', releasePointer, { passive: true });
  window.addEventListener('blur', () => { if (heldPointer) clearIntent(); });
  window.addEventListener('pointerdown', event => {
    if (heldPointer?.released && !pane.contains(event.target as Node)) clearIntent();
  }, { passive: true, capture: true });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && heldPointer?.released) clearIntent();
  }, { capture: true });

  pane.addEventListener('scroll', () => {
    if (intent?.generation === runtime.selectionGeneration && runtime.timelineShown()) {
      intent.scrolled = true;
      if (heldPointer?.released) heldPointer = null;
      runtime.readerAtEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
      if (runtime.hasSendAnchor) runtime.releaseSendHold();
      if (runtime.readingAfterSend && runtime.distanceFromTail() <= 1) runtime.readingAfterSend = false;
    }
    runtime.paintJumpLatest();
  }, { passive: true });
  pane.addEventListener('scrollend', () => {
    if (intent && heldPointer?.generation === intent.generation) intent.scrolled = false;
    else clearIntent();
  }, { passive: true });

  const dock = el('div', 'jump-latest-dock');
  const jump = el('button', 'jump-latest') as HTMLButtonElement;
  jump.id = 'jumpLatest';
  jump.type = 'button';
  jump.append(icon('i-arrow-down'));
  ui(jump, 'title', () => t('Jump to latest'));
  ui(jump, 'aria-label', () => t('Jump to latest'));
  jump.addEventListener('click', runtime.jumpToLatest);
  dock.append(jump);
  pane.append(dock);

  let pendingScrollDirection = 0;
  pane.addEventListener('wheel', event => {
    pendingScrollDirection = Math.sign(event.deltaY);
    runtime.requestHistory(pendingScrollDirection);
  }, { passive: true });
  let pointerScrollTop: number | null = null;
  pane.addEventListener('pointerdown', () => { pointerScrollTop = pane.scrollTop; });
  window.addEventListener('pointerup', () => { pointerScrollTop = null; });
  pane.addEventListener('keydown', event => {
    pendingScrollDirection = ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
      ? -1
      : ['ArrowDown', 'PageDown', 'End'].includes(event.key) ? 1 : 0;
    runtime.requestHistory(pendingScrollDirection);
  });
  pane.addEventListener('scroll', () => {
    if (pointerScrollTop !== null) {
      const direction = Math.sign(pane.scrollTop - pointerScrollTop);
      pointerScrollTop = pane.scrollTop;
      runtime.requestHistory(direction);
    } else if (pendingScrollDirection) {
      const direction = pendingScrollDirection;
      pendingScrollDirection = 0;
      runtime.requestHistory(direction);
    }
    if (runtime.hasHistoryDemand) void runtime.fillTimelineHistory();
  }, { passive: true });

  if (typeof ResizeObserver === 'function') {
    let lastHeight = pane.clientHeight;
    new ResizeObserver(() => {
      const height = pane.clientHeight;
      if (height !== lastHeight && runtime.timelineShown() && runtime.readerAtEnd && !runtime.hasSendAnchor && !runtime.readingAfterSend) {
        pane.scrollTop = pane.scrollHeight;
      }
      lastHeight = height;
    }).observe(pane);
  }
  timeline.addEventListener('click', event => {
    if (!runtime.hasSendAnchor && (event.target as Element).closest('summary')) {
      content.style.removeProperty('--timeline-scroll-reserve');
    }
  });

  if (typeof ResizeObserver === 'function') {
    let observedHeight = pane.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (!runtime.timelineShown()) return;
      runtime.holdSentMessage();
      const grew = pane.scrollHeight - observedHeight >= ROUNDING_PX;
      observedHeight = pane.scrollHeight;
      if (grew && runtime.followOutput() && runtime.readerAtEnd && !runtime.hasSendAnchor && !runtime.readingAfterSend &&
          runtime.historyBefore === null && runtime.distanceFromTail() >= ROUNDING_PX) {
        pane.scrollTop = pane.scrollHeight;
        runtime.paintJumpLatest();
      }
    });
    observer.observe(content);
    observer.observe(pane);
  } else {
    timeline.addEventListener('toggle', () => { runtime.holdSentMessage(); }, true);
  }
}
