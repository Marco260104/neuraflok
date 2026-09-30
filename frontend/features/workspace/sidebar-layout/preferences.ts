const WIDTH_KEY = 'neuraflok.sidebar-width';
const COLLAPSED_KEY = `${WIDTH_KEY}.collapsed`;

export interface SidebarLayoutPreferences {
  width: number | null;
  collapsed: boolean;
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function getStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSidebarLayoutPreferences(): SidebarLayoutPreferences {
  const storage = getStorage();
  if (!storage) return { width: null, collapsed: false };
  try {
    const savedWidth = Number(storage.getItem(WIDTH_KEY));
    return {
      width: Number.isFinite(savedWidth) && savedWidth >= 180 ? Math.min(480, savedWidth) : null,
      collapsed: storage.getItem(COLLAPSED_KEY) === 'true'
    };
  } catch {
    return { width: null, collapsed: false };
  }
}

export function saveSidebarWidth(width: number | null): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (width === null) storage.removeItem(WIDTH_KEY);
    else storage.setItem(WIDTH_KEY, String(width));
  } catch {
    return;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(COLLAPSED_KEY, String(collapsed));
  } catch {
    return;
  }
}
