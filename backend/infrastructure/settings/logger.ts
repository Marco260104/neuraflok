import type { LogEntry } from '../../../contracts/types.js';
import { currentAgent } from '../tool-gateway/protocol/call-context.js';
import { formatLogAsJson as formatJson, formatLogForClipboard as formatClipboard } from './logger-format.js';
import { LogFileMirror } from './logger-file-mirror.js';
import { boundedLogText, redact } from './logger-redaction.js';

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
const fileMirror = new LogFileMirror(() => entries);
const ECHO_TO_CONSOLE = process.env['NEURAFLOK_DEBUG'] === '1';

export function initLogFile(file: string): void {
  fileMirror.initialize(file);
}

export function logFilePath(): string | null {
  return fileMirror.filePath;
}

export function flushLogFile(): Promise<void> {
  return fileMirror.flush();
}

export function snapshotLogOnCrash(reason: string): void {
  fileMirror.snapshot(reason);
}

export function flushLogBeforeExit(timeoutMs = 2_000): Promise<void> {
  return fileMirror.flushBeforeExit(timeoutMs);
}

export function resetLoggerForTests(): void {
  fileMirror.reset();
  entries.length = 0;
  listeners.clear();
}

export { redact };

export function log(level: LogEntry['level'], message: string): void {
  const agent = currentAgent();
  const entry: LogEntry = {
    time: Date.now(),
    level,
    message: boundedLogText(redact(message)),
    ...(agent ? { agent: boundedLogText(redact(agent)).slice(0, 200) } : {})
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  fileMirror.enqueue(entry);
  if (ECHO_TO_CONSOLE) process.stderr.write(`[${level}] ${entry.message}\n`);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Log listeners cannot interrupt application work or shutdown.
    }
  }
}

export const logInfo = (message: string): void => log('info', message);
export const logWarn = (message: string): void => log('warn', message);
export const logError = (message: string): void => log('error', message);

export function getLog(): LogEntry[] {
  return [...entries];
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLogForClipboard(): string {
  return formatClipboard(entries);
}

export function formatLogAsJson(): string {
  return formatJson(entries);
}
