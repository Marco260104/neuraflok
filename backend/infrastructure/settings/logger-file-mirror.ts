import { promises as fs, statSync, writeFileSync } from 'node:fs';
import type { LogEntry } from '../../../contracts/types.js';
import { boundedLogText, redact } from './logger-redaction.js';

const MAX_LOG_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 64 * 1024;

interface FileMirrorState {
  file: string;
  bytes: number;
  pending: string[];
  pendingBytes: number;
  dropped: number;
  work: Promise<void> | null;
  error: unknown;
}

function formatEntry(entry: LogEntry): string {
  return `${new Date(entry.time).toISOString()}  ${entry.level.padEnd(5)}  ${entry.agent ? `[${entry.agent}] ` : ''}${entry.message}\n`;
}

export class LogFileMirror {
  private state: FileMirrorState | null = null;

  constructor(private readonly getEntries: () => readonly LogEntry[]) {}

  initialize(file: string): void {
    let bytes = 0;
    try {
      bytes = statSync(file).size;
    } catch {
      // A first run has no log yet.
    }
    this.state = { file, bytes, pending: [], pendingBytes: 0, dropped: 0, work: null, error: null };
  }

  get filePath(): string | null {
    return this.state?.file ?? null;
  }

  enqueue(entry: LogEntry): void {
    const state = this.state;
    if (!state || state.error) return;
    const line = formatEntry(entry);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (state.pendingBytes + bytes > MAX_PENDING_BYTES) {
      state.dropped = Math.min(Number.MAX_SAFE_INTEGER, state.dropped + 1);
    } else {
      state.pending.push(line);
      state.pendingBytes += bytes;
    }
    this.startWriter(state);
  }

  async flush(): Promise<void> {
    const state = this.state;
    if (!state) return;
    this.startWriter(state);
    while (state.work) await state.work;
    if (state.error) throw state.error;
  }

  snapshot(reason: string): void {
    if (this.state) this.writeCrashSnapshot(this.state, reason);
  }

  async flushBeforeExit(timeoutMs = 2_000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('log flush deadline exceeded')), timeoutMs);
          timer.unref?.();
        })
      ]);
    } catch (error) {
      this.snapshot(`final log flush failed: ${String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  reset(): void {
    this.state = null;
  }

  private startWriter(state: FileMirrorState): void {
    if (state.work || state.error || (!state.pending.length && !state.dropped)) return;
    state.work = Promise.resolve().then(async () => {
      try {
        while (state.pending.length || state.dropped) {
          const lines: string[] = [];
          let bytes = 0;
          while (state.pending.length) {
            const line = state.pending[0]!;
            const size = Buffer.byteLength(line, 'utf8');
            if (bytes && bytes + size > MAX_BATCH_BYTES) break;
            state.pending.shift();
            state.pendingBytes -= size;
            lines.push(line);
            bytes += size;
          }
          if (!lines.length && state.dropped) {
            lines.push(`${new Date().toISOString()}  warn   ${state.dropped} log line(s) omitted: file writer backlog exceeded its byte limit.\n`);
            state.dropped = 0;
            bytes = Buffer.byteLength(lines[0]!, 'utf8');
          }
          if (state.bytes && state.bytes + bytes > MAX_LOG_FILE_BYTES) {
            await fs.rename(state.file, `${state.file}.1`);
            state.bytes = 0;
          }
          await fs.appendFile(state.file, lines.join(''), 'utf8');
          state.bytes += bytes;
        }
      } catch (error) {
        state.error = error;
        state.pending = [];
        state.pendingBytes = 0;
        state.dropped = 0;
        this.writeCrashSnapshot(state, `log file writer failed: ${String(error)}`);
      }
    }).finally(() => {
      state.work = null;
      this.startWriter(state);
    });
  }

  private writeCrashSnapshot(state: FileMirrorState, reason: string): void {
    const recent: string[] = [];
    const lines = [formatEntry({ time: Date.now(), level: 'error', message: boundedLogText(redact(reason)) })];
    let bytes = Buffer.byteLength(lines[0]!, 'utf8');
    const entries = this.getEntries();
    for (let index = entries.length - 1; index >= 0; index--) {
      const line = formatEntry(entries[index]!);
      const size = Buffer.byteLength(line, 'utf8');
      if (bytes + size > MAX_PENDING_BYTES) break;
      recent.unshift(line);
      bytes += size;
    }
    try {
      writeFileSync(`${state.file}.crash`, lines.concat(recent).join(''), 'utf8');
    } catch {
      // The reporting channel cannot report its own storage failure.
    }
  }
}
