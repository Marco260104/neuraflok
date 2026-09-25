import type { WindowState } from '../tabs/model-contracts.js';

export const CURRENT_WINDOW_ID = -2;
export const EMPTY_PAGE_URL = 'about:blank';

const WINDOW_STATES = new Set<WindowState>(['normal', 'minimized', 'maximized', 'fullscreen']);

export function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Error in invocation: ${name} must be an object.`);
  return value as Record<string, unknown>;
}

export function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`Error in invocation: ${name} must be an integer.`);
  return value as number;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Error in invocation: ${name} must be a boolean.`);
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Error in invocation: ${name} must be a string.`);
  return value;
}

export function populate(options: unknown): boolean {
  return record(options, 'queryOptions').populate === true;
}

export function windowState(value: unknown): WindowState | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !WINDOW_STATES.has(value as WindowState)) throw new Error(`Invalid value for state: ${String(value)}`);
  return value as WindowState;
}
