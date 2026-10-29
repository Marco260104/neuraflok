import { el, icon, setIcon } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';
import { attachWorkPanelResize } from '../work-panel-resize.js';
import { moveWorkDock } from '../../../shared/panel-motion.js';
import { enableTabReorder, reorderKey } from '../tab-reorder.js';
import { createBottomDockResizer } from './bottom-resizer.js';
import { createDockIconButton } from './elements.js';
import { createDockTabStrip } from './tab-strip.js';
import type { AdoptableView, BottomTerminalView, DockTab, DockView, DockViewRegistration, DockTerminalView } from './types.js';

export type { DockView } from './types.js';

/** The right dock owns tool selection; the bottom dock owns its own terminal view. */
export function createWorkspaceDocks(host: HTMLElement) {
  const app = document.querySelector<HTMLElement>('.app')!;
  const views = new Map<AdoptableView, DockViewRegistration>();
  let rightTerminal: DockTerminalView | null = null, bottomTerminal: BottomTerminalView | null = null;
  let rightOpen = false, bottomOpen = false, expanded = false;
  let opened: DockTab[] = [], active: DockTab | null = null;
  const terminalId = (key: DockTab): string | null => key.startsWith('terminal:') ? key.slice('terminal:'.length) : null;
  const terminalKey = (id: string): DockTab => `terminal:${id}`;

  const bottomToggle = createDockIconButton('i-panel-bottom', 'Toggle bottom panel (Ctrl+`)'); bottomToggle.id = 'terminalToggle';
  const rightToggle = createDockIconButton('i-panel-right', 'Toggle right panel'); rightToggle.id = 'rightDockToggle';
  const expandToggle = el('button', 'btn btn-icon') as HTMLButtonElement;
  expandToggle.id = 'rightDockExpand'; expandToggle.type = 'button';
  const expandGlyph = icon('i-dock-expand'); expandToggle.append(expandGlyph);
  ui(expandToggle, 'title', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
  ui(expandToggle, 'aria-label', () => t(expanded ? 'Restore right panel' : 'Expand right panel'));
  expandToggle.hidden = true;
  const controls = el('div', 'header-dock-controls'); controls.append(expandToggle, bottomToggle, rightToggle);
  // The layout toggles live at the right end of the title bar. Where the system's own caption buttons share that end (Windows), the bar's right padding reserves their width (env(titlebar-area-*)); a divider then keeps the two groups apart. Electron's windowControlsOverlay reports no geometry, so the padding the CSS resolved is the source.
    const topbar = document.querySelector<HTMLElement>('.app-topbar')!;
    topbar.querySelector<HTMLElement>('.app-topbar-trailing')!.append(controls);
  const markCaption = (): void => {
    controls.classList.toggle('is-beside-caption', parseFloat(window.getComputedStyle(topbar).paddingRight) > 24);
  };
  window.addEventListener('resize', markCaption);
  markCaption();

  const right = el('aside', 'work-dock work-dock-right'); right.id = 'workDockRight'; right.hidden = true;
  ui(right, 'aria-label', () => t('Right panel'));
  rightToggle.setAttribute('aria-controls', right.id);
  const bar = el('div', 'work-dock-bar');
  const tabs = el('div', 'work-dock-tabs'); tabs.setAttribute('role', 'tablist');
  const add = document.createElement('details'); add.className = 'work-dock-add';
  const plus = el('summary'); plus.append(icon('i-plus'));
  ui(plus, 'title', () => t('New tab')); ui(plus, 'aria-label', () => t('New tab'));
  const menu = el('div', 'work-dock-menu'); add.append(plus, menu);
  const launch = el('div', 'work-dock-launch');
  const tabStrip = createDockTabStrip({ tabs, bar, plus, launch, rightToggle });
  const empty = el('div', 'work-dock-empty'); empty.append(launch);
  const body = el('div', 'work-dock-body'); body.append(empty);
  bar.append(tabs, add); right.append(bar, body);
  attachWorkPanelResize(host, right); host.append(right);

  const bottom = el('section', 'work-dock work-dock-bottom'); bottom.id = 'workDockBottom'; bottom.hidden = true;
  ui(bottom, 'aria-label', () => t('Bottom panel'));
  bottomToggle.setAttribute('aria-controls', bottom.id);
  const resize = createBottomDockResizer(app, bottom);
  const bottomBody = el('div', 'work-dock-body'); bottom.append(resize, bottomBody); app.append(bottom);

  const available = (key: DockTab): boolean => {
    const id = terminalId(key);
    return id ? rightTerminal?.tabs().some(tab => tab.id === id) ?? false : views.get(key as AdoptableView)?.available() ?? false;
  };
  const hideView = (key: DockTab): void => {
    if (terminalId(key)) rightTerminal?.hide(); else views.get(key as AdoptableView)?.hide();
  };
  const showView = (key: DockTab): void => {
    const id = terminalId(key);
    if (id) { rightTerminal?.selectTab(id); rightTerminal?.show(body, false); }
    else views.get(key as AdoptableView)?.show(body);
  };
  const refreshControls = (): void => {
    for (const kind of ['review', 'terminal', 'files', 'agents'] as DockView[]) {
      const enabled = kind === 'terminal' ? rightTerminal?.canCreate() ?? false : views.get(kind)?.available() ?? false;
      // A greyed-out entry says why, instead of leaving the user to guess.
      const reason = enabled ? '' : kind === 'agents' ? t('Open a chat to see its sub-agents') : t('Open a project to use Files and Review');
      for (const button of [menu, launch].map(root => root.querySelector<HTMLButtonElement>(`[data-view="${kind}"]`))) {
        if (!button) continue;
        button.toggleAttribute('disabled', !enabled);
        if (reason) button.title = reason; else button.removeAttribute('title');
      }
    }
  };
  const paint = (): void => {
    if (active && !available(active)) { hideView(active); active = null; }
    rightToggle.setAttribute('aria-expanded', String(rightOpen)); rightToggle.classList.toggle('is-active', rightOpen);
    expandToggle.hidden = !rightOpen;
    expandToggle.setAttribute('aria-pressed', String(expanded));
    expandToggle.title = t(expanded ? 'Restore right panel' : 'Expand right panel');
    expandToggle.setAttribute('aria-label', expandToggle.title);
    setIcon(expandGlyph, expanded ? 'i-dock-restore' : 'i-dock-expand');
    bottomToggle.setAttribute('aria-expanded', String(bottomOpen)); bottomToggle.classList.toggle('is-active', bottomOpen);
    host.querySelector('#toggleTerminal')?.setAttribute('aria-expanded', String(bottomOpen));
    empty.hidden = active !== null;
    bar.hidden = opened.length === 0;
    if (bar.hidden) add.open = false;
    tabStrip.render(opened, active, rightTerminal?.tabs() ?? [], views, activateKey, closeKey);
    refreshControls();
  };
  // Every change of the dock's track goes through one move, so open, close, expand and restore share the drawer motion and interruptions continue from the current frame.
  const layout = (change: () => void, settled?: () => void): void =>
    moveWorkDock(host, right, () => { change(); right.hidden = !rightOpen; }, settled);
  const setRightOpen = (value: boolean): void => {
    if (rightOpen === value) { paint(); return; }
    // The outgoing tool stays mounted while the drawer leaves, then retires as before.
    const leaving = value ? null : active;
    layout(() => {
      rightOpen = value; host.classList.toggle('has-work-dock', value);
      if (!value) { expanded = false; host.classList.remove('is-work-dock-expanded'); add.open = false; }
    }, () => { if (leaving && !rightOpen && active === leaving) hideView(leaving); });
    paint();
    if (value && active) showView(active);
  };
  const setBottomOpen = (value: boolean, createIfEmpty = true): void => {
    if (bottomOpen === value) return;
    // The bottom dock rises as a drawer; its terminal is hidden once the drawer has left.
    moveWorkDock(app, bottom, () => {
      bottomOpen = value; app.classList.toggle('has-bottom-dock', value); bottom.hidden = !value;
    }, () => { if (!value && !bottomOpen) bottomTerminal?.hide(); }, 'y');
    paint();
    if (value) bottomTerminal?.show(bottomBody, createIfEmpty);
  };
  const activateKey = (key: DockTab): void => {
    if (!available(key)) return;
    if (active && active !== key) hideView(active);
    if (!opened.includes(key)) opened.push(key);
    active = key;
    if (!rightOpen) layout(() => { rightOpen = true; host.classList.add('has-work-dock'); });
    paint();
    showView(key);
  };
  const closeKey = (key: DockTab): void => {
    const id = terminalId(key);
    if (id) { rightTerminal?.closeTab(id); if (active === key) rightTerminal?.hide(); }
    else views.get(key as AdoptableView)?.hide();
    opened = opened.filter(entry => entry !== key);
    if (active === key) {
      active = null;
      const previous = [...opened].reverse().find(available);
      if (previous) activateKey(previous);
    }
    paint();
  };
  const newRightTerminal = (): void => {
    if (!rightTerminal?.canCreate()) return;
    const id = rightTerminal.newTab(); if (!id) return;
    activateKey(terminalKey(id));
  };
  const activate = (kind: DockView): void => {
    if (kind === 'terminal') {
      const previous = [...opened].reverse().find(key => terminalId(key) !== null);
      if (previous) activateKey(previous); else newRightTerminal();
    } else activateKey(kind);
  };
  const adopt = (kind: AdoptableView): void => {
    if (active && active !== kind) hideView(active);
    if (!opened.includes(kind)) opened.push(kind);
    active = kind;
    if (!rightOpen) layout(() => { rightOpen = true; host.classList.add('has-work-dock'); });
    paint();
  };
  const addAction = (kind: DockView, label: string, glyph: string): void => {
    const item = el('button', 'btn work-dock-menu-item', () => t(label)) as HTMLButtonElement;
    item.type = 'button'; item.dataset.view = kind; item.prepend(icon(glyph));
    item.addEventListener('click', () => {
      add.open = false;
      if (kind === 'terminal') newRightTerminal(); else activate(kind);
    }); menu.append(item);
    const quick = el('button', 'btn work-dock-quick') as HTMLButtonElement;
    quick.type = 'button'; quick.dataset.view = kind;
    quick.append(icon(glyph), el('span', '', () => t(label)));
    quick.append(el('kbd', '', `Ctrl+Shift+${['review', 'terminal', 'files', 'agents'].indexOf(kind) + 1}`));
    quick.addEventListener('click', () => activate(kind)); launch.append(quick);
    refreshControls();
  };
  const register = (kind: AdoptableView, label: string, glyph: string,
    show: (mount: HTMLElement) => void, hide: () => void, available: () => boolean): void => {
    views.set(kind, { label, glyph, show, hide, available }); addAction(kind, label, glyph); paint();
  };
  const registerTerminal = (right: DockTerminalView, bottom: BottomTerminalView): void => {
    rightTerminal = right; bottomTerminal = bottom;
    addAction('terminal', 'Terminal', 'i-terminal'); paint();
  };

  rightToggle.addEventListener('click', () => setRightOpen(!rightOpen));
  bottomToggle.addEventListener('click', () => setBottomOpen(!bottomOpen));
  expandToggle.addEventListener('click', () => {
    if (!rightOpen) return;
    layout(() => { expanded = !expanded; host.classList.toggle('is-work-dock-expanded', expanded); });
    paint();
  });
  add.addEventListener('keydown', event => {
    if (event.key === 'Escape') { add.open = false; plus.focus(); return; }
    if (!add.open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus();
  });
  document.addEventListener('click', event => { if (add.open && !add.contains(event.target as Node)) add.open = false; });
  const moveTab = (key: DockTab, index: number): void => {
    const from = opened.indexOf(key); if (from < 0) return;
    opened.splice(from, 1); opened.splice(Math.max(0, Math.min(opened.length, index)), 0, key); paint();
  };
  enableTabReorder(tabs, { item: '.work-dock-tab', key: node => node.dataset.key, move: (key, index) => moveTab(key as DockTab, index) });
  tabs.addEventListener('keydown', event => {
    const step = reorderKey(event);
    if (step && active && opened.length > 1) {
      event.preventDefault(); event.stopPropagation();
      moveTab(active, opened.indexOf(active) + step);
      tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !opened.length) return;
    event.preventDefault();
    const index = active ? opened.indexOf(active) : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? opened.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : opened.length - 1)) % opened.length;
    activateKey(opened[next]!); tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    if (!event.shiftKey && event.key === '`') { event.preventDefault(); setBottomOpen(!bottomOpen); return; }
    // With Shift held, `key` is the shifted character (!, ", § … by layout), never the digit; `code` names the physical key.
    const digit = /^Digit([1-4])$/.exec(event.code)?.[1];
    if (!event.shiftKey || !digit) return;
    event.preventDefault(); activate((['review', 'terminal', 'files', 'agents'] as DockView[])[Number(digit) - 1]!);
  });
  paint();
  return { body, bottomBody, rightToggle, bottomToggle, register, registerTerminal, activate, adopt,
    setOpen: setRightOpen, setBottomOpen, toggleBottomTerminal: () => setBottomOpen(!bottomOpen), sync: paint };
}
