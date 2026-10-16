/** Computer use: seeing the screen and driving the mouse and keyboard. This is deliberately the smallest surface that still lets a model actually operate the machine. The action vocabulary mirrors OpenAI's computer-use tool — click, double_click, scroll, type, keypress, drag, move, wait, screenshot — so a model that already knows how to drive a computer does not have to learn a private dialect, plus the two things a native desktop needs and a browser viewport does not: listing windows and bringing one to the front. Coordinates are always in *screenshot pixels*. Each helper keeps capture and input in one native screen coordinate space; the scale between that space and the returned image is applied here, and every screenshot states the size it was returned at. */

import { clearFrameStore } from './frame-store.js';
import { stopNativeTransport } from './transport.js';

export { DEFAULT_SCREENSHOT_WIDTH, MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_PNG_BYTES, findUi, getWindowState, screenshot } from './observations.js';
export { act, actAndCapture } from './actions.js';
export type { Action, ActionResult, ActionRoute, AccessibilityContext, DesktopApp, PointerResult, Rect, Screenshot, UiActionName, UiElementInfo, VerificationResult, VerificationSpec, WindowInfo } from './types.js';
export { activeWindow, focusWindow, listDesktopApps, listWindows, waitForWindow } from './window-queries.js';
export { getMacOSDesktopAccess, onMacOSDesktopAccessChange, prewarmComputerHelper, refreshMacOSDesktopAccess } from './macos-access.js';
export { ComputerError } from './errors.js';
export { helperTimeoutMs } from './transport.js';

export async function stopComputerHelper(): Promise<void> {
  clearFrameStore();
  await stopNativeTransport();
}
