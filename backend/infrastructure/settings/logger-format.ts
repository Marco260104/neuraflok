import type { LogEntry } from '../../../contracts/types.js';

export function formatLogForClipboard(entries: readonly LogEntry[]): string {
  return entries
    .map((entry) => `${new Date(entry.time).toISOString()}  ${entry.level.padEnd(5)}  ${entry.message}`)
    .join('\n');
}

export function formatLogAsJson(entries: readonly LogEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      time: new Date(entry.time).toISOString(),
      level: entry.level,
      message: entry.message
    })),
    null,
    2
  );
}
