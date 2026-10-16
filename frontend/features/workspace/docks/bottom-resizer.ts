import { el } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';

const HEIGHT_KEY = 'neuraflok.bottom-panel-height';

export function createBottomDockResizer(app: HTMLElement, bottom: HTMLElement): HTMLElement {
  const resize = el('div', 'terminal-resize');
  resize.tabIndex = 0;
  resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-orientation', 'horizontal');
  ui(resize, 'aria-label', () => t('Terminal height'));

  const setHeight = (height: number, save = false): void => {
    const next = Math.round(Math.max(130, Math.min(window.innerHeight * .65, height)));
    app.style.setProperty('--terminal-height', `${next}px`);
    resize.setAttribute('aria-valuenow', String(next));
    if (save) try { localStorage.setItem(HEIGHT_KEY, String(next)); } catch { /* optional */ }
  };

  let saved = 250;
  try { saved = Number(localStorage.getItem(HEIGHT_KEY)) || 250; } catch { /* optional */ }
  setHeight(saved);

  let drag: { id: number; y: number; height: number } | null = null;
  resize.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, y: event.clientY, height: bottom.offsetHeight };
    app.classList.add('is-resizing-bottom-dock');
    resize.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  resize.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) setHeight(drag.height + drag.y - event.clientY);
  });
  resize.addEventListener('pointerup', event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    app.classList.remove('is-resizing-bottom-dock');
    setHeight(bottom.offsetHeight, true);
    if (resize.hasPointerCapture(event.pointerId)) resize.releasePointerCapture(event.pointerId);
  });
  resize.addEventListener('lostpointercapture', () => {
    drag = null;
    app.classList.remove('is-resizing-bottom-dock');
  });
  resize.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    setHeight(bottom.offsetHeight + (event.key === 'ArrowUp' ? 24 : -24), true);
  });
  window.addEventListener('resize', () => setHeight(bottom.offsetHeight || saved));
  return resize;
}
