export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_BYTES = 100_000;
export const MAX_SCRIPT_CHARS = 8_000;
export const MAX_SHELL_COMMAND_CHARS = 32_000;
export const MAX_ENV_VARS = 64;
export const MAX_ENV_KEY_CHARS = 128;
export const MAX_ENV_VALUE_CHARS = 8_192;

export class ExecError extends Error {}

export type CommandEnvironment = Record<string, string>;

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}
