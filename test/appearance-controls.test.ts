import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { defaultAppearance } from '../contracts/appearance-settings.js';
import type { UiPrefs } from '../contracts/types.js';
import { initAppearance, applyAppearance, onAppearanceChanged } from '../frontend/features/settings/appearance.js';

let dom: JSDOM;

beforeEach(async () => {
  const html = readRendererMarkup(process.cwd());
  dom = new JSDOM(html, { url: 'https://local.test/', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
  vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
});

afterEach(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

it('applies saved colors and typography without creating a settings write', () => {
  const save = vi.fn();
  const form = initAppearance(save);
  const appearance = defaultAppearance();
  appearance.dark.background = '#202124';
  appearance.dark.sidebar = '#303238';
  appearance.dark.accent = '#aabbcc';
  appearance.font = 'mono';
  appearance.fontSize = 16;
  form.apply({ theme: 'dark', appearance } as UiPrefs);

  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.getPropertyValue('--ui-font')).toBe('"Cascadia Mono", Consolas, monospace');
  expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe(String(16 / 14));
  expect(document.querySelector<HTMLInputElement>('[data-color="accent"]')?.value).toBe('#aabbcc');
  expect(document.querySelector<HTMLInputElement>('[data-hex="accent"]')?.value).toBe('#AABBCC');
  expect(save).not.toHaveBeenCalled();
});

it('persists valid picker and hex changes while rejecting incomplete values', () => {
  const save = vi.fn();
  const form = initAppearance(save);
  form.apply({ theme: 'dark', appearance: defaultAppearance() } as UiPrefs);
  const hex = document.querySelector<HTMLInputElement>('[data-hex="accent"]')!;
  const picker = document.querySelector<HTMLInputElement>('[data-color="accent"]')!;
  hex.focus();
  hex.value = '#abcdef';
  hex.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(picker.value).toBe('#abcdef');
  expect(save).not.toHaveBeenCalled();
  hex.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ dark: expect.objectContaining({ accent: '#abcdef' }) }) });

  hex.value = '#12';
  hex.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(hex.getAttribute('aria-invalid')).toBe('true');
  hex.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(hex.value).toBe('#ABCDEF');
  expect(hex.hasAttribute('aria-invalid')).toBe(false);
  expect(save).toHaveBeenCalledTimes(1);
});

it('keeps theme persistence separate from appearance edits and resets only the appearance', () => {
  const save = vi.fn();
  const form = initAppearance(save);
  const appearance = defaultAppearance();
  form.apply({ theme: 'dark', appearance } as UiPrefs);
  const theme = document.getElementById('appearanceTheme') as HTMLSelectElement;
  theme.value = 'light';
  theme.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(save).toHaveBeenNthCalledWith(1, { theme: 'light' });

  const size = document.getElementById('appearanceSize') as HTMLInputElement;
  size.value = '18';
  size.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  form.apply({ theme: 'dark', appearance } as UiPrefs);
  expect(theme.value).toBe('light');
  size.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  expect(save).toHaveBeenNthCalledWith(2, { appearance: expect.objectContaining({ fontSize: 18 }) });

  (document.getElementById('appearanceReset') as HTMLButtonElement).click();
  expect(save).toHaveBeenNthCalledWith(3, { appearance: defaultAppearance() });
  expect(theme.value).toBe('light');
});

it('notifies appearance consumers after applying tokens and supports unsubscribe', () => {
  const listener = vi.fn();
  const stop = onAppearanceChanged(listener);
  applyAppearance('light', defaultAppearance());
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  applyAppearance('dark', defaultAppearance());
  expect(listener).toHaveBeenCalledTimes(1);
});
