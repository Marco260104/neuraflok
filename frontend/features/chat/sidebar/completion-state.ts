const STORAGE_KEY = 'neuraflok.sidebar-completion-seen';
const MAX_ENTRIES = 5000;
const MAX_STORAGE_CHARS = 600_000;
const MAX_ID_CHARS = 160;

interface CompletionEntry {
  id: string;
  activeTurnId?: string | null;
  lastAssistantFinalAt?: number | null;
  lastTurnEndAt?: number | null;
  lastTurnOutcome: string | null;
}

interface PersistedCompletionState {
  baselineAt: number;
  seen: Array<[string, number]>;
}

function finiteTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function completionTime(entry: CompletionEntry): number | null {
  if (entry.lastTurnOutcome !== 'completed' || entry.activeTurnId) return null;
  const time = Math.max(finiteTime(entry.lastTurnEndAt), finiteTime(entry.lastAssistantFinalAt));
  return time > 0 ? time : null;
}

function restore(): PersistedCompletionState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_STORAGE_CHARS) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const saved = value as Partial<PersistedCompletionState>;
    if (!Number.isFinite(saved.baselineAt) || !Array.isArray(saved.seen)) return null;

    const seen: Array<[string, number]> = [];
    for (const entry of saved.seen.slice(-MAX_ENTRIES)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, time] = entry;
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_CHARS || !Number.isFinite(time)) continue;
      seen.push([id, time]);
    }
    return { baselineAt: saved.baselineAt!, seen };
  } catch {
    return null;
  }
}

export function createSidebarCompletionState(now = () => Date.now()) {
  const saved = restore();
  const baselineAt = saved?.baselineAt ?? now();
  const seen = new Map(saved?.seen ?? []);

  function persist(): void {
    const baseLength = JSON.stringify({ baselineAt, seen: [] }).length;
    let usedChars = baseLength;
    const retained: Array<[string, number]> = [];
    for (const receipt of [...seen].reverse()) {
      const addition = JSON.stringify(receipt).length + (retained.length ? 1 : 0);
      if (retained.length >= MAX_ENTRIES || usedChars + addition > MAX_STORAGE_CHARS) break;
      retained.push(receipt);
      usedChars += addition;
    }
    retained.reverse();
    if (retained.length !== seen.size) {
      seen.clear();
      for (const [id, time] of retained) seen.set(id, time);
    }
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ baselineAt, seen: retained } satisfies PersistedCompletionState)); }
    catch { /* Keep read receipts in memory when storage is unavailable. */ }
  }

  function isUnseen(entry: CompletionEntry): boolean {
    const time = completionTime(entry);
    return time !== null && time > (seen.get(entry.id) ?? baselineAt);
  }

  function markSeen(entry: CompletionEntry | undefined): void {
    if (!entry) return;
    const time = completionTime(entry);
    if (time === null || time <= (seen.get(entry.id) ?? baselineAt)) return;
    seen.delete(entry.id);
    seen.set(entry.id, time);
    persist();
  }

  if (!saved) persist();
  return { isUnseen, markSeen };
}
