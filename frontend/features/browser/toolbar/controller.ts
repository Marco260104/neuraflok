import type {
  IntegratedBrowserToolbarApi,
  IntegratedBrowserToolbarState
} from '../../../../contracts/browser/integrated-browser-toolbar.js';
import { createBrowserTabStrip } from './tab-strip.js';

function required<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing integrated browser toolbar element: ${id}`);
  return element as T;
}

export function mountIntegratedBrowserToolbar(document: Document, api: IntegratedBrowserToolbarApi): void {
  const tabs = createBrowserTabStrip(required(document, 'tabs'), api);
  const back = required<HTMLButtonElement>(document, 'back');
  const forward = required<HTMLButtonElement>(document, 'forward');
  const reload = required<HTMLButtonElement>(document, 'reload');
  const reloadGlyph = required<HTMLElement>(document, 'reloadGlyph');
  const extensionControl = required<HTMLButtonElement>(document, 'extensionControl');
  const extensionMark = required<HTMLElement>(document, 'extensionMark');
  const extensionFallback = required<HTMLElement>(document, 'extensionFallback');
  const extensionStatus = required<HTMLElement>(document, 'extensionStatus');
  const extensionAnnouncement = required<HTMLElement>(document, 'extensionAnnouncement');
  let activeTab: number | null = null;
  let pageLoading = false;

  const render = (state: IntegratedBrowserToolbarState): void => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(state.tokens)) root.style.setProperty(name, value);
    root.style.setProperty('--frame-inset-left', `${state.insets.left}px`);
    root.style.setProperty('--frame-inset-right', `${state.insets.right}px`);

    activeTab = tabs(state.tabs);
    pageLoading = state.navigation.loading;
    back.disabled = activeTab === null || !state.navigation.back;
    forward.disabled = activeTab === null || !state.navigation.forward;
    reload.disabled = activeTab === null;
    reloadGlyph.className = `ph ${pageLoading ? 'ph-x' : 'ph-arrow-clockwise'}`;
    reload.title = pageLoading ? 'Stop' : 'Reload';
    reload.setAttribute('aria-label', reload.title);

    const icon = state.companionIcon ? `url("${state.companionIcon}")` : '';
    if (extensionMark.style.maskImage !== icon) {
      extensionMark.style.maskImage = icon;
      extensionMark.style.webkitMaskImage = icon;
    }
    extensionMark.hidden = !state.companionIcon;
    extensionFallback.hidden = Boolean(state.companionIcon);
    const status = state.connected === null ? 'unknown' : state.connected ? 'connected' : 'disconnected';
    extensionStatus.dataset.state = status;
    extensionControl.title = `NEURAFLOK extension, ${status}`;
    extensionControl.setAttribute('aria-label', extensionControl.title);
    extensionAnnouncement.textContent = `Browser extension status ${status}`;
  };

  back.addEventListener('click', () => { if (activeTab !== null) api.act('back', activeTab); });
  forward.addEventListener('click', () => { if (activeTab !== null) api.act('forward', activeTab); });
  reload.addEventListener('click', () => {
    if (activeTab !== null) api.act(pageLoading ? 'stop' : 'reload', activeTab);
  });
  extensionControl.addEventListener('click', () => api.act('extension'));
  api.onState(render);
}
