import { boundsForWorkArea } from './geometry.js';
import type { BrowserWorkArea, BrowserWindowBounds, WorkAreaSource } from './types.js';

let workAreaSource: WorkAreaSource | null = null;

export function setWorkAreaSource(source: WorkAreaSource | null): void {
  workAreaSource = source;
}

export function readWorkArea(): BrowserWorkArea | undefined {
  return workAreaSource?.();
}

export function computeBrowserWindowBounds(area = readWorkArea()): BrowserWindowBounds {
  return boundsForWorkArea(area);
}

export type { BrowserWorkArea, BrowserWindowBounds, WorkAreaSource } from './types.js';
