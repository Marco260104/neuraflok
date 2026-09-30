/** Keyboard shortcut labels as this computer's keyboard prints them. The app's primary shortcuts (sidebar, zoom, search) accept Ctrl or ⌘, so macOS shows ⌘ and other systems show the keyboard's Ctrl key in the UI language ("Strg" in German). The workspace panels' Ctrl+Shift+1–4 really are Ctrl everywhere and keep their own label. */
import { t } from '../../shared/i18n.js';

export function isMac(): boolean {
  const platform = typeof navigator !== 'undefined'
    ? navigator.platform
    : typeof window !== 'undefined' ? window.navigator.platform : '';
  return /^Mac/.test(platform);
}

/** "⌘K" on macOS, "Ctrl+K" (or "Strg+K") elsewhere. */
export function primaryShortcut(key: string): string {
  return isMac() ? `⌘${key}` : `${t('Ctrl')}+${key}`;
}
