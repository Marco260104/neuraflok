import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type {
  IntegratedBrowserToolbarApi,
  IntegratedBrowserToolbarState
} from '../contracts/browser/integrated-browser-toolbar.js';
import { mountIntegratedBrowserToolbar } from '../frontend/features/browser/toolbar/controller.js';

const markup = `<!doctype html><html><body>
  <header class="browser-toolbar"><nav class="browser-navigation" aria-label="Browser navigation">
    <button id="back"></button><button id="forward"></button>
    <button id="reload"><i id="reloadGlyph"></i></button>
  </nav><div id="tabs" class="browser-tabs" role="tablist" aria-label="Browser tabs"></div>
  <button id="extensionControl"><span id="extensionMark"></span><i id="extensionFallback"></i>
    <span id="extensionStatus"></span><span id="extensionAnnouncement"></span>
  </button></header>
</body></html>`;

const toolbarState = (patch: Partial<IntegratedBrowserToolbarState> = {}): IntegratedBrowserToolbarState => ({
  tabs: [
    { id: 4, title: 'DeepSeek', url: 'https://chat.deepseek.com/', favicon: 'data:image/png;base64,AA==', active: true, loading: false, working: true },
    { id: 9, title: 'Qwen', url: 'https://chat.qwen.ai/', favicon: null, active: false, loading: true, working: false }
  ],
  navigation: { back: true, forward: false, loading: true },
  connected: true,
  companionIcon: 'data:image/svg+xml;base64,AA==',
  tokens: { '--page': '#102030', '--accent': '#abcdef' },
  insets: { left: 20, right: 40 },
  ...patch
});

describe('integrated browser toolbar', () => {
  it('renders provider tabs and routes navigation, tab, and extension actions to the active browser API', () => {
    const dom = new JSDOM(markup);
    let publish: ((state: IntegratedBrowserToolbarState) => void) | undefined;
    const api: IntegratedBrowserToolbarApi = {
      act: vi.fn(),
      onState: listener => { publish = listener; }
    };
    mountIntegratedBrowserToolbar(dom.window.document, api);
    publish!(toolbarState({ navigation: { back: true, forward: true, loading: true } }));

    const { document } = dom.window;
    const back = document.getElementById('back') as HTMLButtonElement;
    const forward = document.getElementById('forward') as HTMLButtonElement;
    const reload = document.getElementById('reload') as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(false);
    expect(reload.disabled).toBe(false);
    expect(reload.title).toBe('Stop');
    expect(document.getElementById('reloadGlyph')!.className).toBe('ph ph-x');
    expect(document.documentElement.style.getPropertyValue('--page')).toBe('#102030');
    expect(document.documentElement.style.getPropertyValue('--frame-inset-left')).toBe('20px');
    expect(document.documentElement.style.getPropertyValue('--frame-inset-right')).toBe('40px');

    const tabs = [...document.querySelectorAll<HTMLElement>('.browser-tab')];
    expect(tabs.map(tab => tab.title)).toEqual(['DeepSeek', 'Qwen']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]!.tabIndex).toBe(0);
    expect(tabs[1]!.tabIndex).toBe(-1);
    expect(tabs[0]!.dataset.working).toBe('true');
    expect(tabs[0]!.querySelector('img.browser-tab-favicon')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(tabs[1]!.querySelector('.browser-tab-loading')).not.toBeNull();
    expect(document.getElementById('extensionMark')!.hidden).toBe(false);
    expect(document.getElementById('extensionFallback')!.hidden).toBe(true);
    expect(document.getElementById('extensionStatus')!.dataset.state).toBe('connected');
    expect(document.getElementById('extensionAnnouncement')!.textContent).toBe('Browser extension status connected');
    expect(document.getElementById('extensionControl')!.getAttribute('aria-label')).toBe('NEURAFLOK extension, connected');

    back.click();
    forward.click();
    reload.click();
    document.getElementById('extensionControl')!.click();
    tabs[0]!.click();
    tabs[0]!.querySelector<HTMLButtonElement>('.browser-tab-close')!.click();
    tabs[1]!.dispatchEvent(new dom.window.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    expect(api.act).toHaveBeenNthCalledWith(1, 'back', 4);
    expect(api.act).toHaveBeenNthCalledWith(2, 'forward', 4);
    expect(api.act).toHaveBeenNthCalledWith(3, 'stop', 4);
    expect(api.act).toHaveBeenNthCalledWith(4, 'extension');
    expect(api.act).toHaveBeenNthCalledWith(5, 'activate', 4);
    expect(api.act).toHaveBeenNthCalledWith(6, 'close', 4);
    expect(api.act).toHaveBeenNthCalledWith(7, 'close', 9);
  });

  it('reuses retained tabs, removes stale tabs, and disables navigation when no tab is active', () => {
    const dom = new JSDOM(markup);
    let publish: ((state: IntegratedBrowserToolbarState) => void) | undefined;
    const api: IntegratedBrowserToolbarApi = {
      act: vi.fn(),
      onState: listener => { publish = listener; }
    };
    mountIntegratedBrowserToolbar(dom.window.document, api);
    publish!(toolbarState());
    const retained = dom.window.document.querySelector('.browser-tab[title="Qwen"]');

    publish!(toolbarState({
      tabs: [{ id: 9, title: 'Qwen updated', url: 'https://chat.qwen.ai/', favicon: null, active: true, loading: false, working: true }],
      navigation: { back: false, forward: true, loading: false },
      connected: null,
      companionIcon: null
    }));
    const { document } = dom.window;
    expect(document.querySelectorAll('.browser-tab')).toHaveLength(1);
    expect(document.querySelector('.browser-tab')).toBe(retained);
    expect(document.querySelector('.browser-tab')!.getAttribute('aria-selected')).toBe('true');
    expect((document.querySelector('.browser-tab') as HTMLElement).dataset.working).toBe('true');
    expect((document.getElementById('back') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('forward') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('reload') as HTMLButtonElement).title).toBe('Reload');
    expect(document.getElementById('extensionMark')!.hidden).toBe(true);
    expect(document.getElementById('extensionFallback')!.hidden).toBe(false);
    expect(document.getElementById('extensionStatus')!.dataset.state).toBe('unknown');
    expect(document.getElementById('extensionControl')!.getAttribute('aria-label')).toBe('NEURAFLOK extension, unknown');

    publish!(toolbarState({ tabs: [], navigation: { back: true, forward: true, loading: false } }));
    expect(document.querySelectorAll('.browser-tab')).toHaveLength(0);
    expect((document.getElementById('back') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('forward') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('reload') as HTMLButtonElement).disabled).toBe(true);
    (document.getElementById('back') as HTMLButtonElement).click();
    expect(api.act).not.toHaveBeenCalled();
  });

  it('moves keyboard focus through tabs and activates the focused provider', () => {
    const dom = new JSDOM(markup);
    const api: IntegratedBrowserToolbarApi = {
      act: vi.fn(),
      onState: listener => listener(toolbarState())
    };
    mountIntegratedBrowserToolbar(dom.window.document, api);
    const { document } = dom.window;
    const tabs = [...document.querySelectorAll<HTMLElement>('.browser-tab')];

    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabs[1]);
    expect(api.act).toHaveBeenNthCalledWith(1, 'activate', 9);

    tabs[1]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(api.act).toHaveBeenNthCalledWith(2, 'activate', 9);
    tabs[1]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabs[0]);
    expect(api.act).toHaveBeenNthCalledWith(3, 'activate', 4);

    tabs[0]!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(api.act).toHaveBeenNthCalledWith(4, 'activate', 4);
  });
});
