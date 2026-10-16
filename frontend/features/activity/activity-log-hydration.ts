import type { AppApi } from '../../../backend/preload/index.js';
import type { LogEntry } from '../../../contracts/types.js';
import { run } from '../../shared/dom.js';

type ActivityLogHydrationOptions = {
  api: AppApi;
  addLogLine: (entry: LogEntry) => void;
};

export function initActivityLogHydration({ api, addLogLine }: ActivityLogHydrationOptions) {
  let heldLogLines: LogEntry[] | null = [];

  api.onLogEntry(entry => {
    if (heldLogLines) heldLogLines.push(entry);
    else addLogLine(entry);
  });

  async function loadStartupSnapshot(): Promise<void> {
    const entries = await run(api.getLog());
    const key = (entry: LogEntry): string => `${entry.time}\0${entry.level}\0${entry.agent ?? ''}\0${entry.message}`;
    const shown = new Map<string, number>();
    for (const entry of entries ?? []) {
      addLogLine(entry);
      shown.set(key(entry), (shown.get(key(entry)) ?? 0) + 1);
    }
    const held = heldLogLines ?? [];
    heldLogLines = null;
    for (const entry of held) {
      const left = shown.get(key(entry)) ?? 0;
      if (left > 0) shown.set(key(entry), left - 1);
      else addLogLine(entry);
    }
  }

  return { loadStartupSnapshot };
}
