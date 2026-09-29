import { t, ui } from '../../../shared/i18n.js';
import { primaryShortcut } from '../../settings/shortcuts.js';
import { readSidebarLayoutPreferences, saveSidebarCollapsed, saveSidebarWidth } from './preferences.js';

const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const KEYBOARD_STEP = 10;

interface DragSession {
  pointerId: number;
  originX: number;
  originWidth: number;
}

export function initSidebarLayout(): void {
  const app = document.querySelector<HTMLElement>('.app')!;
  const sidebar = document.getElementById('sidebar')!;
  const divider = document.getElementById('sidebarResize')!;
  const toggle = document.getElementById('sidebarToggle')!;
  const preferences = readSidebarLayoutPreferences();
  let width = preferences.width;
  let collapsed = preferences.collapsed;
  let drag: DragSession | null = null;

  const maximumWidth = (): number => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth / 2));

  function render(): void {
    app.classList.toggle('is-sidebar-collapsed', collapsed);
    sidebar.inert = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (width === null) app.style.removeProperty('--sidebar-width');
    else app.style.setProperty('--sidebar-width', `${Math.min(maximumWidth(), width)}px`);
    divider.setAttribute('aria-valuemin', String(MIN_WIDTH));
    divider.setAttribute('aria-valuemax', String(maximumWidth()));
    divider.setAttribute('aria-valuenow', String(Math.round(sidebar.getBoundingClientRect().width)));
  }

  function setWidth(nextWidth: number): void {
    const finiteWidth = Number.isFinite(nextWidth) ? nextWidth : MIN_WIDTH;
    width = Math.round(Math.max(MIN_WIDTH, Math.min(maximumWidth(), finiteWidth)));
    render();
  }

  function toggleSidebar(): void {
    collapsed = !collapsed;
    if (collapsed && sidebar.contains(document.activeElement)) toggle.focus();
    render();
    saveSidebarCollapsed(collapsed);
  }

  function finishDrag(event: PointerEvent): void {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    app.classList.remove('is-resizing-sidebar');
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    saveSidebarWidth(width);
  }

  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    divider.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originWidth: sidebar.getBoundingClientRect().width
    };
    app.classList.add('is-resizing-sidebar');
    event.preventDefault();
  });

  divider.addEventListener('pointermove', (event) => {
    if (drag?.pointerId === event.pointerId) setWidth(drag.originWidth + event.clientX - drag.originX);
  });
  divider.addEventListener('pointerup', finishDrag);
  divider.addEventListener('pointercancel', finishDrag);
  divider.addEventListener('lostpointercapture', finishDrag);
  divider.addEventListener('dblclick', () => {
    width = null;
    render();
    saveSidebarWidth(null);
  });
  divider.addEventListener('keydown', (event) => {
    const currentWidth = sidebar.getBoundingClientRect().width;
    if (event.key === 'ArrowLeft') setWidth(currentWidth - KEYBOARD_STEP);
    else if (event.key === 'ArrowRight') setWidth(currentWidth + KEYBOARD_STEP);
    else if (event.key === 'Home') setWidth(MIN_WIDTH);
    else if (event.key === 'End') setWidth(maximumWidth());
    else return;
    event.preventDefault();
    saveSidebarWidth(width);
  });

  ui(toggle, 'title', () => `${t('Toggle sidebar')} (${primaryShortcut('B')})`);
  toggle.addEventListener('click', toggleSidebar);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    }
  });
  window.addEventListener('resize', render);
  render();
}
