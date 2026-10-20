import { expect, it } from 'vitest';
import { paintedTabBounds } from '../backend/domains/browser/embedded/tab-paint.js';

it('keeps a real painted size when the window reports 0×0', () => {
  expect(paintedTabBounds(0, 0)).toEqual({ x: 0, y: 40, width: 1180, height: 780 });
});

it('uses the window content size when it is already large enough', () => {
  expect(paintedTabBounds(1440, 900)).toEqual({ x: 0, y: 40, width: 1440, height: 860 });
});
