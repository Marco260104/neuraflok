const STORAGE_KEY = 'neuraflok.sidebar-pins';
const MAX_PINS = 500;
const PINNED_SCOPE = 'pinned:';

export function pinnedSortScope(scope: string, pinned: boolean): string {
  return pinned ? `${PINNED_SCOPE}${scope}` : scope;
}

function readPins(): Set<string> {
  const pins = new Set<string>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw && raw.length <= 100_000 ? JSON.parse(raw) : [];
    if (!Array.isArray(saved)) return pins;
    for (const id of saved) {
      if (pins.size === MAX_PINS) break;
      if (typeof id === 'string' && id.length > 0 && id.length <= 160) pins.add(id);
    }
  } catch {
    return pins;
  }
  return pins;
}

function writePins(pins: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...pins]));
  } catch {
    return;
  }
}

export function createSidebarPins() {
  const pins = readPins();
  return {
    has: (id: string): boolean => pins.has(id),
    toggle(id: string): boolean {
      if (pins.has(id)) pins.delete(id);
      else {
        if (pins.size >= MAX_PINS) pins.delete(pins.values().next().value!);
        pins.add(id);
      }
      writePins(pins);
      return pins.has(id);
    },
    first<T extends { id: string }>(rows: T[]): T[] {
      const pinned: T[] = [];
      const unpinned: T[] = [];
      for (const row of rows) (pins.has(row.id) ? pinned : unpinned).push(row);
      return [...pinned, ...unpinned];
    }
  };
}
