import type { BrowserWindowBounds, BrowserWorkArea } from './types.js';

const DEFAULT_BOUNDS: BrowserWindowBounds = Object.freeze({ width: 800, height: 600 });
const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;
const WIDTH_RATIO = 0.6;
const HEIGHT_RATIO = 0.75;

function hasUsableDimensions(area: BrowserWorkArea | undefined): area is BrowserWorkArea {
  if (!area) return false;
  return Number.isFinite(area.x) && Number.isFinite(area.y) &&
    Number.isFinite(area.width) && Number.isFinite(area.height) &&
    area.width > 0 && area.height > 0;
}

function fittedDimension(available: number, ratio: number, limit: number): number {
  return Math.max(1, Math.min(limit, Math.floor(available * ratio)));
}

export function boundsForWorkArea(area: BrowserWorkArea | undefined): BrowserWindowBounds {
  if (!hasUsableDimensions(area)) return { ...DEFAULT_BOUNDS };

  const width = fittedDimension(area.width, WIDTH_RATIO, MAX_WIDTH);
  const height = fittedDimension(area.height, HEIGHT_RATIO, MAX_HEIGHT);
  return {
    width,
    height,
    left: Math.floor(area.x + (area.width - width) / 2),
    top: Math.floor(area.y + (area.height - height) / 2)
  };
}
