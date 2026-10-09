import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { initSidebarLayout } from '../frontend/features/workspace/sidebar-layout/controller.js';

let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); });
it('bounds dragging, releases capture, preserves width through collapse and smaller windows, and resets', () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const doc = dom.window.document;
  const app = doc.querySelector<HTMLElement>('.app')!;
  const sidebar = doc.getElementById('sidebar')!;
  const handle = doc.getElementById('sidebarResize')!;
  sidebar.getBoundingClientRect = () => ({ width: parseFloat(app.style.getPropertyValue('--sidebar-width')) || 248 }) as DOMRect;
  let captured = false;
  handle.setPointerCapture = () => { captured = true; };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => { captured = false; };
  initSidebarLayout();
  const pointer = (type: string, x: number, pointerId = 7, button = 0) => {
    const event = new dom.window.MouseEvent(type, { clientX: x, button });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    handle.dispatchEvent(event);
  };
  pointer('pointerdown', 248, 6, 2);
  expect(captured).toBe(false);
  pointer('pointerdown', 248);
  pointer('pointermove', 1000, 8);
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('');
  pointer('pointermove', 1000); pointer('pointerup', 1000);
  expect(captured).toBe(false);
  expect(app.classList.contains('is-resizing-sidebar')).toBe(false);
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  doc.getElementById('sidebarToggle')!.click();
  expect(sidebar.inert).toBe(true);
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
  expect(sidebar.inert).toBe(false);
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  Object.defineProperty(dom.window, 'innerWidth', { value: 600, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('300px');
  Object.defineProperty(dom.window, 'innerWidth', { value: 1200 });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home' }));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('180px');
  handle.dispatchEvent(new dom.window.MouseEvent('dblclick'));
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('');
  // The View menu's button lives in the title bar beside this toggle, not in the sidebar it hides.
  expect(sidebar.querySelector('#viewMenu')).toBeNull();
  expect(doc.getElementById('sidebarToggle')!.nextElementSibling!.id).toBe('viewMenu');
});

it('restores a saved width and collapsed state within the current window bounds', () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  const app = dom.window.document.querySelector<HTMLElement>('.app')!;
  const sidebar = dom.window.document.getElementById('sidebar')!;
  sidebar.getBoundingClientRect = () => ({ width: parseFloat(app.style.getPropertyValue('--sidebar-width')) || 248 }) as DOMRect;
  dom.window.localStorage.setItem('neuraflok.sidebar-width', '520');
  dom.window.localStorage.setItem('neuraflok.sidebar-width.collapsed', 'true');

  initSidebarLayout();

  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
  expect(app.classList.contains('is-sidebar-collapsed')).toBe(true);
  expect(dom.window.document.getElementById('sidebar')!.inert).toBe(true);
  expect(dom.window.document.getElementById('sidebarToggle')!.getAttribute('aria-expanded')).toBe('false');
});

it('keeps the layout usable when browser preference storage throws', () => {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.spyOn(dom.window.localStorage, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
  vi.spyOn(dom.window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
  const app = dom.window.document.querySelector<HTMLElement>('.app')!;
  const sidebar = dom.window.document.getElementById('sidebar')!;
  const divider = dom.window.document.getElementById('sidebarResize')!;
  sidebar.getBoundingClientRect = () => ({ width: parseFloat(app.style.getPropertyValue('--sidebar-width')) || 248 }) as DOMRect;

  expect(() => initSidebarLayout()).not.toThrow();
  expect(() => dom.window.document.getElementById('sidebarToggle')!.click()).not.toThrow();
  expect(() => divider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End' }))).not.toThrow();
  expect(app.style.getPropertyValue('--sidebar-width')).toBe('480px');
});
