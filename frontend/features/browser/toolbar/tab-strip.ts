import type {
  IntegratedBrowserToolbarApi,
  IntegratedBrowserToolbarTab
} from '../../../../contracts/browser/integrated-browser-toolbar.js';

type TabElements = {
  root: HTMLElement;
  glyph: HTMLElement;
  title: HTMLElement;
  close: HTMLButtonElement;
  glyphKey: string;
};

function createTab(document: Document, id: number, api: IntegratedBrowserToolbarApi): TabElements {
  const root = document.createElement('div');
  root.className = 'browser-tab';
  root.setAttribute('role', 'tab');
  root.tabIndex = -1;
  root.dataset.tabId = String(id);
  root.addEventListener('click', event => {
    if (event.target === close || close.contains(event.target as Node)) return;
    api.act('activate', id);
  });
  root.addEventListener('auxclick', event => {
    if (event.button !== 1) return;
    event.preventDefault();
    api.act('close', id);
  });

  const glyph = document.createElement('span');
  glyph.className = 'browser-tab-icon';
  const title = document.createElement('span');
  title.className = 'browser-tab-title';
  const close = document.createElement('button');
  close.className = 'browser-tab-close';
  close.type = 'button';
  close.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  close.addEventListener('mousedown', event => event.stopPropagation());
  close.addEventListener('click', event => {
    event.stopPropagation();
    api.act('close', id);
  });
  root.addEventListener('keydown', event => {
    if (event.target === close || close.contains(event.target as Node)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      api.act('activate', id);
      return;
    }
    const currentTabs = Array.from(root.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const currentIndex = currentTabs.indexOf(root);
    if (currentIndex < 0) return;
    const nextIndex = event.key === 'ArrowRight' ? (currentIndex + 1) % currentTabs.length
      : event.key === 'ArrowLeft' ? (currentIndex - 1 + currentTabs.length) % currentTabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? currentTabs.length - 1
            : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextTab = currentTabs[nextIndex]!;
    const nextId = Number(nextTab.dataset.tabId);
    nextTab.focus();
    if (Number.isSafeInteger(nextId)) api.act('activate', nextId);
  });
  root.append(glyph, title, close);
  return { root, glyph, title, close, glyphKey: '' };
}

function renderGlyph(document: Document, target: HTMLElement, tab: IntegratedBrowserToolbarTab): void {
  let symbol: HTMLElement;
  if (tab.loading) {
    symbol = document.createElement('span');
    symbol.className = 'browser-tab-loading';
  } else if (tab.favicon) {
    const image = document.createElement('img');
    image.src = tab.favicon;
    image.alt = '';
    image.className = 'browser-tab-favicon';
    image.draggable = false;
    symbol = image;
  } else {
    symbol = document.createElement('i');
    symbol.className = 'ph ph-chat-circle';
    symbol.setAttribute('aria-hidden', 'true');
  }
  const activity = document.createElement('span');
  activity.className = 'browser-tab-activity';
  target.replaceChildren(symbol, activity);
}

export function createBrowserTabStrip(strip: HTMLElement, api: IntegratedBrowserToolbarApi): (tabs: IntegratedBrowserToolbarTab[]) => number | null {
  const document = strip.ownerDocument;
  const elements = new Map<number, TabElements>();

  return nextTabs => {
    const visibleIds = new Set<number>();
    nextTabs.forEach((tab, index) => {
      visibleIds.add(tab.id);
      let item = elements.get(tab.id);
      if (!item) {
        item = createTab(document, tab.id, api);
        elements.set(tab.id, item);
      }
      if (strip.children[index] !== item.root) strip.insertBefore(item.root, strip.children[index] ?? null);
      item.root.dataset.tabId = String(tab.id);
      item.root.setAttribute('aria-selected', String(tab.active));
      item.root.tabIndex = tab.active ? 0 : -1;
      item.root.dataset.working = String(tab.working);
      item.root.title = tab.title;
      item.title.textContent = tab.title;
      item.close.setAttribute('aria-label', `Close ${tab.title}`);
      item.close.title = 'Close tab';
      const glyphKey = `${tab.loading}|${tab.favicon}`;
      if (item.glyphKey !== glyphKey) {
        item.glyphKey = glyphKey;
        renderGlyph(document, item.glyph, tab);
      }
    });

    for (const [id, item] of elements) {
      if (visibleIds.has(id)) continue;
      item.root.remove();
      elements.delete(id);
    }
    return nextTabs.find(tab => tab.active)?.id ?? null;
  };
}
