import { afterEach, expect, it, vi } from 'vitest';
import { computeBrowserWindowBounds, setWorkAreaSource } from '../backend/domains/browser/window-placement/index.js';
import { openInPreferredBrowser } from '../backend/domains/browser/browser.js';

afterEach(() => setWorkAreaSource(null));
it.each([{ x: 0, y: 0, width: 1280, height: 720 }, { x: -1920, y: 40, width: 1920, height: 1040 }, { x: 20, y: 30, width: 800, height: 600 }])('bounds new browser windows to less than half the work area: %j', area => {
  const bounds = computeBrowserWindowBounds(area);
  expect(bounds.width * bounds.height).toBeLessThanOrEqual(area.width * area.height * 0.45);
  expect(bounds.left).toBeGreaterThanOrEqual(area.x); expect(bounds.top).toBeGreaterThanOrEqual(area.y);
  expect(bounds.left! + bounds.width).toBeLessThanOrEqual(area.x + area.width);
  expect(bounds.top! + bounds.height).toBeLessThanOrEqual(area.y + area.height);
});
it('uses the same smaller display bounds for cold minimized browser startup', async () => {
  setWorkAreaSource(() => ({ x: 0, y: 0, width: 1280, height: 720 }));
  const powershell = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: '', stderr: '', truncated: false, durationMs: 1 }));
  await openInPreferredBrowser('https://chat.deepseek.com/?neuraflok-model-catalog=owned', { browser: 'chrome', platform: 'win32', backgroundStartup: true,
    env: { ProgramFiles: 'C:\\Apps' }, usable: () => true, powershell });
  expect(powershell).toHaveBeenCalledWith(expect.stringContaining('--window-size=768,540'), expect.any(String), 10000);
  expect(powershell).toHaveBeenCalledWith(expect.stringContaining('-WindowStyle Minimized'), expect.any(String), 10000);
});

it.each([undefined, { x: 0, y: 0, width: 0, height: 600 }, { x: Number.NaN, y: 0, width: 1280, height: 720 }])('uses default bounds when the display area is unavailable: %j', area => {
  expect(computeBrowserWindowBounds(area)).toEqual({ width: 800, height: 600 });
});
