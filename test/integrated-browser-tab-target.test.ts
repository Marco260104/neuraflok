import { expect, it } from 'vitest';
import { targetWindow } from '../backend/domains/browser/embedded/chrome-api/tab-operations.js';
import { TabModel } from '../backend/domains/browser/embedded/tabs/model.js';

it('adds background tabs to the existing normal window when the browser is hidden', () => {
  const model = new TabModel(() => undefined);
  const first = model.createWindow({ type: 'normal', state: 'minimized' });
  model.focusWindow(-1);
  expect(targetWindow({ model } as never, undefined)).toBe(first);
});

it('prefers an existing normal window over a focused popup for provider tabs', () => {
  const model = new TabModel(() => undefined);
  const normal = model.createWindow({ type: 'normal', state: 'minimized' });
  const popup = model.createWindow({ type: 'popup' });
  model.focusWindow(popup);
  expect(targetWindow({ model } as never, undefined)).toBe(normal);
});
