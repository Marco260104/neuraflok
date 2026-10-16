// Shared limits and formatting helpers for managed process execution.

export const MIN_YIELD_TIME_MS = 250;
// Keep empty polls long enough to avoid a busy loop.
export const MIN_EMPTY_YIELD_TIME_MS = 5_000;
export const MAX_YIELD_TIME_MS = 30_000;
export const DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
export const UNIFIED_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024; // 1 MiB
export const UNIFIED_EXEC_OUTPUT_MAX_TOKENS = UNIFIED_EXEC_OUTPUT_MAX_BYTES / 4;
export const MAX_UNIFIED_EXEC_PROCESSES = 64;

export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
export const DEFAULT_TTY = false;

// Use the standard interrupt character for a pipe session.
export const INTERRUPT = String.fromCharCode(3);

// Set child-process defaults for stable, non-interactive command output.
export function unifiedExecEnvForPlatform(
  platform: NodeJS.Platform = process.platform
): ReadonlyArray<readonly [string, string]> {
  // Use a UTF-8 locale that the selected host platform provides.
  const utf8Locale = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return [
    ['NO_COLOR', '1'],
    ['TERM', 'dumb'],
    ['LANG', utf8Locale],
    ['LC_CTYPE', utf8Locale],
    ['LC_ALL', utf8Locale],
    ['COLORTERM', ''],
    ['PAGER', 'cat'],
    ['GIT_PAGER', 'cat'],
    ['GH_PAGER', 'cat']
  ];
}

export const UNIFIED_EXEC_ENV = unifiedExecEnvForPlatform();

// Default terminal size for newly opened pseudo-terminals.
export const DEFAULT_TERMINAL_ROWS = 24;
export const DEFAULT_TERMINAL_COLS = 80;

export function clampYieldTime(yieldTimeMs: number): number {
  // Keep explicit yields responsive while enforcing the supported execution limits.
  return Math.min(Math.max(yieldTimeMs, MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS);
}

export function resolveMaxTokens(maxTokens: number | undefined): number {
  return maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

export function formatOutputOmissionMarker(omittedBytes: number): string {
  return `... ${omittedBytes} bytes omitted ...`;
}

// Generate the compact id used to pair process output with its session.
export function generateChunkId(): string {
  let out = '';
  for (let index = 0; index < 6; index++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
