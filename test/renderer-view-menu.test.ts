import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';

let dom: JSDOM;
afterEach(async () => {
  (await import('../frontend/features/chat/row-menu.js')).closeRowMenu();
  dom?.window.close();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(options: { integrated: boolean }) {
  dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', { platform: 'Win32' });
  const doc = dom.window.document;
  let zoom = 100;
  const calls: string[] = [];
  const { initViewMenu } = await import('../frontend/features/settings/view-menu.js');
  const menu = initViewMenu({
    search: () => calls.push('search'),
    integratedBrowser: () => options.integrated,
    showIntegratedBrowser: () => calls.push('integrated-browser'),
    // As in the app: the zoom applies later (an IPC round trip), and then refreshes the menu.
    zoom: {
      step: async delta => { await Promise.resolve(); zoom += Math.round(delta * 100); menu.refresh(); },
      reset: async () => { await Promise.resolve(); zoom = 100; menu.refresh(); },
      percent: () => zoom
    }
  });
  const button = doc.getElementById('viewMenu') as HTMLButtonElement;
  const open = () => doc.querySelector<HTMLElement>('.row-menu');
  const items = () => [...open()?.querySelectorAll<HTMLButtonElement>('.row-menu-item') ?? []].map(item => [
    item.dataset.rowAction,
    item.querySelector('.row-menu-label')!.textContent,
    item.querySelector('.row-menu-shortcut')?.textContent ?? null
  ]);
  const item = (action: string) => doc.querySelector<HTMLButtonElement>(`.row-menu [data-row-action="${action}"]`)!;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { doc, menu, button, open, items, item, calls, settle, zoom: () => zoom };
}

it('opens one menu with each action, its icon and its shortcut, the NEURAFLOK browser only when it is selected', async () => {
  const view = await mount({ integrated: false });
  expect(view.button.getAttribute('aria-haspopup')).toBe('menu');
  view.button.click();
  expect(view.button.getAttribute('aria-expanded')).toBe('true');
  // Not the sidebar: its own toggle sits right beside the menu's button.
  expect(view.items()).toEqual([
    ['search', 'Search chats', 'Ctrl+K'],
    ['zoom-in', 'Zoom in', 'Ctrl++'],
    ['zoom-out', 'Zoom out', 'Ctrl+−'],
    ['zoom-reset', 'Actual size', 'Ctrl+0']
  ]);
  // Every item draws its icon, and the groups are separated.
  expect(view.open()!.querySelectorAll('.row-menu-item > .ico').length).toBe(4);
  expect(view.open()!.querySelectorAll('.row-menu-separator').length).toBe(1);
  // The same button closes it.
  view.button.click();
  expect(view.open()).toBeNull();
  expect(view.button.getAttribute('aria-expanded')).toBe('false');

  const integrated = await mount({ integrated: true });
  integrated.button.click();
  expect(integrated.items().map(([action]) => action)).toEqual(['search', 'integrated-browser', 'zoom-in', 'zoom-out', 'zoom-reset']);
  expect(integrated.item('integrated-browser').querySelector('.row-menu-label')!.textContent).toBe('Show browser');
  integrated.item('integrated-browser').click();
  expect(integrated.calls).toEqual(['integrated-browser']);
  expect(integrated.open()).toBeNull();
});

it('runs actions and keeps zoom steps open with the value updating', async () => {
  const view = await mount({ integrated: false });
  view.button.click();
  view.item('search').click();
  expect(view.open()).toBeNull();
  view.button.click();
  expect(view.item('zoom-reset').querySelector('.row-menu-hint')!.textContent).toBe('100%');
  view.item('zoom-in').click(); await view.settle();
  view.item('zoom-in').click(); await view.settle();
  expect(view.open()).not.toBeNull();
  expect(view.item('zoom-reset').querySelector('.row-menu-hint')!.textContent).toBe('120%');
  view.item('zoom-reset').click(); await view.settle();
  expect([view.zoom(), view.item('zoom-reset').querySelector('.row-menu-hint')!.textContent]).toEqual([100, '100%']);
  // A zoom made elsewhere (the keyboard) shows in the open menu too.
  await view.menu.refresh();
  expect(view.open()).not.toBeNull();
});

it('opens from the keyboard and gives focus back to its button on Escape', async () => {
  const view = await mount({ integrated: false });
  view.button.focus();
  view.button.dispatchEvent(new view.doc.defaultView!.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(view.open()).not.toBeNull();
  expect((view.doc.activeElement as HTMLElement).dataset.rowAction).toBe('search');
  view.open()!.dispatchEvent(new view.doc.defaultView!.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect((view.doc.activeElement as HTMLElement).dataset.rowAction).toBe('zoom-in');
  view.open()!.dispatchEvent(new view.doc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(view.open()).toBeNull();
  expect(view.doc.activeElement).toBe(view.button);
});
