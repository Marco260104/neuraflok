const STORAGE_KEY = 'neuraflok.sidebar-order';
const MAX_IDS = 5000;
const MAX_STORAGE_CHARS = 600_000;
const MAX_KEY_CHARS = 160;

export const SIDEBAR_PROJECT_SCOPE = ':projects';

export interface SidebarOrderEntry {
  id: string;
  scope: string;
}

export interface SidebarOrderPreferences {
  ordered<T extends { id: string }>(scope: string, rows: T[]): T[];
  move(id: string, targetId: string, after: boolean, scope: string, members: readonly SidebarOrderEntry[]): boolean;
}

type SavedOrder = [string, string[]];

function validIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= MAX_KEY_CHARS
  );
  return [...new Set(ids)];
}

function readOrders(): Map<string, string[]> {
  const orders = new Map<string, string[]>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw && raw.length <= MAX_STORAGE_CHARS ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return orders;

    let total = 0;
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [scope, rawIds] = item;
      const ids = validIds(rawIds);
      if (typeof scope !== 'string' || scope.length > MAX_KEY_CHARS || !ids) continue;
      if (total + ids.length > MAX_IDS) break;
      orders.set(scope, ids);
      total += ids.length;
    }
  } catch {
    return new Map();
  }
  return orders;
}

export function createSidebarOrderPreferences(): SidebarOrderPreferences {
  const orders = readOrders();

  function ordered<T extends { id: string }>(scope: string, rows: T[]): T[] {
    const rank = new Map((orders.get(scope) ?? []).map((id, index) => [id, index]));
    return rows
      .map((row, index) => ({ row, index, rank: rank.get(row.id) ?? -1 }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map(item => item.row);
  }

  function boundedSnapshot(): SavedOrder[] {
    let remaining = MAX_IDS;
    return [...orders].reverse().map(([scope, ids]) => {
      const bounded = ids.slice(0, remaining);
      remaining -= bounded.length;
      return [scope, bounded] as SavedOrder;
    }).filter(([, ids]) => ids.length).reverse();
  }

  function save(): void {
    const snapshot = boundedSnapshot();
    orders.clear();
    for (const [scope, ids] of snapshot) orders.set(scope, ids);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); }
    catch { /* In-memory ordering remains available when storage is unavailable. */ }
  }

  function move(
    id: string,
    targetId: string,
    after: boolean,
    scope: string,
    members: readonly SidebarOrderEntry[]
  ): boolean {
    if (id === targetId) return false;
    const scopedMembers = members.filter(entry => entry.scope === scope);
    if (!scopedMembers.some(entry => entry.id === id) || !scopedMembers.some(entry => entry.id === targetId)) return false;

    const before = ordered(scope, [...scopedMembers]).map(entry => entry.id);
    const next = before.filter(currentId => currentId !== id);
    const targetIndex = next.indexOf(targetId);
    if (targetIndex < 0) return false;
    next.splice(targetIndex + Number(after), 0, id);
    if (next.every((currentId, index) => currentId === before[index])) return false;

    const present = new Set(before);
    const previous = orders.get(scope) ?? [];
    let cursor = 0;
    const merged = previous.map(currentId => present.has(currentId) ? next[cursor++]! : currentId);
    merged.push(...next.slice(cursor));
    orders.delete(scope);
    orders.set(scope, merged);
    save();
    return true;
  }

  return { ordered, move };
}
