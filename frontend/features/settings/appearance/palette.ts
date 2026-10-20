import { mixColor } from '../../../../contracts/appearance-color.js';
import { paletteTokens } from '../../../../contracts/appearance-tokens.js';
import { defaultAppearance, type AppearanceSettings, type AppearanceTheme } from '../../../../contracts/appearance-settings.js';

const FONT_FAMILIES: Readonly<Record<AppearanceSettings['font'], string>> = {
  system: '"Segoe UI Variable Text", "Segoe UI", "SF Pro Text", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif',
  sans: '"Segoe UI Variable Text", "Segoe UI", Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Cascadia Mono", Consolas, monospace'
};
const paletteListeners = new Set<() => void>();

function applyTokens(element: HTMLElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  }
}

export function onAppearanceChanged(listener: () => void): () => void {
  paletteListeners.add(listener);
  return () => {
    paletteListeners.delete(listener);
  };
}

export function applyAppearance(theme: AppearanceTheme, settings: AppearanceSettings = defaultAppearance()): void {
  const palette = settings[theme];
  const root = document.documentElement;
  root.classList.add('theme-switching');
  void root.offsetHeight;
  root.dataset.theme = theme;
  root.dataset.translucentSidebar = String(settings.translucentSidebar);
  applyTokens(root, paletteTokens(palette.background, palette.accent, palette.contrast));
  root.style.setProperty('--text-scale', String(settings.fontSize / 14));
  root.style.setProperty('--ui-font', FONT_FAMILIES[settings.font]);
  root.style.setProperty('--sidebar-color', palette.sidebar);
  const afterPaint = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (callback: FrameRequestCallback) => { callback(0); return 0; };
  afterPaint(() => {
    afterPaint(() => root.classList.remove('theme-switching'));
  });

  const sidebar = settings.translucentSidebar ? mixColor(palette.sidebar, palette.background, 0.13) : palette.sidebar;
  const selectors = '.sidebar, .app-topbar, .appearance-preview-sidebar, .connection-popover';
  for (const element of document.querySelectorAll<HTMLElement>(selectors)) {
    applyTokens(element, paletteTokens(sidebar, palette.accent, palette.contrast));
  }
  for (const listener of paletteListeners) listener();
}
