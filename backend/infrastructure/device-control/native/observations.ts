import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exclusive } from './operation-lock.js';
import { currentFrame, frameById, qualifiedFrame, rememberUiRef } from './frame-store.js';
import type { Frame } from './frame-store.js';
import { logInfo } from '../../settings/logger.js';
import { ComputerError } from './errors.js';
import { generationOfReply, runHelper } from './transport.js';
import type { AccessibilityContext, Rect, Screenshot, UiActionName, UiElementInfo, WindowInfo } from './types.js';
import { DEFAULT_SCREENSHOT_WIDTH, MAX_SCREENSHOT_WIDTH, screenshotFromReply, screenshotLocked } from './screenshots.js';
export { DEFAULT_SCREENSHOT_WIDTH, MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_PNG_BYTES, screenshot } from './screenshots.js';
export { screenshotLocked } from './screenshots.js';
export async function findUi(opts: {
  window?: number;
  query?: string;
  role?: string;
  maxResults?: number;
}): Promise<{ window: number; snapshotId: number; elements: UiElementInfo[]; accessibility?: AccessibilityContext }> {
  return exclusive(() => findUiLocked(opts, currentFrame()));
}

/** Maps elements into the caller's frame rather than whichever frame is current when the helper answers. */
export async function findUiLocked(
  opts: {
    window?: number;
    query?: string;
    role?: string;
    maxResults?: number;
  },
  frame: Frame | null,
  suppliedReply?: Record<string, any>
): Promise<{ window: number; snapshotId: number; elements: UiElementInfo[]; accessibility?: AccessibilityContext }> {
  const request = {
    op: 'find_ui',
    ...(opts.window === undefined ? {} : { id: opts.window }),
    query: opts.query ?? '',
    role: opts.role ?? '',
    maxResults: Math.min(100, Math.max(1, Math.floor(opts.maxResults ?? 30)))
  };
  const reply = suppliedReply ?? (await runHelper(request));
  const replyGeneration = generationOfReply(reply);
  frame = qualifiedFrame(frame, replyGeneration);
  const raw = Array.isArray(reply['elements']) ? (reply['elements'] as Array<Record<string, any>>) : [];
  const snapshotId = Number(reply['snapshotId']);
  if (!Number.isInteger(snapshotId) || snapshotId < 1) {
    throw new ComputerError('The desktop helper returned UI elements without a valid snapshot identity.');
  }
  const replyWindow = reply['window'];
  const windowId = Number(
    replyWindow && typeof replyWindow === 'object'
      ? (replyWindow as Record<string, unknown>)['id']
      : replyWindow
  );
  if (!Number.isInteger(windowId) || windowId < 1) {
    throw new ComputerError('The desktop helper returned UI elements without a valid window identity.');
  }
  logInfo(
    `desktop uia window_snapshot=${snapshotId} visited=${Number(reply['visited']) || 0} returned=${raw.length} truncated=${reply['truncated'] === true}`
  );
  const elements = raw.map((item, index): UiElementInfo => {
    const bounds = item['bounds'] as Rect;
    let imageBounds: Rect | null = null;
    let imageCenter: { x: number; y: number } | null = null;
    if (
      frame && bounds.width > 0 && bounds.height > 0 &&
      // Screen fallback pixels may belong to an occluding app, so they cannot authorize target-window input.
      frame.captureMode !== 'screen_fallback' &&
      bounds.x >= frame.region.x &&
      bounds.y >= frame.region.y &&
      bounds.x + bounds.width <= frame.region.x + frame.region.width &&
      bounds.y + bounds.height <= frame.region.y + frame.region.height
    ) {
      // Map both bounds edges to avoid rounding controls beyond the returned image.
      const left = Math.round((bounds.x - frame.region.x) * frame.width / frame.region.width);
      const top = Math.round((bounds.y - frame.region.y) * frame.height / frame.region.height);
      const right = Math.round((bounds.x + bounds.width - frame.region.x) * frame.width / frame.region.width);
      const bottom = Math.round((bounds.y + bounds.height - frame.region.y) * frame.height / frame.region.height);
      imageBounds = { x: left, y: top, width: right - left, height: bottom - top };
      if (right > left && bottom > top) imageCenter = {
        x: Math.min(right - 1, Math.round((left + right) / 2)),
        y: Math.min(bottom - 1, Math.round((top + bottom) / 2))
      };
    }
    const runtimeKey = String(item['runtimeKey'] ?? '');
    return {
      ref: runtimeKey
        ? rememberUiRef(windowId, runtimeKey, index, snapshotId, replyGeneration)
        : `unavailable-${snapshotId}-${index + 1}`,
      name: String(item['name'] ?? ''),
      role: String(item['role'] ?? ''),
      automationId: String(item['automationId'] ?? ''),
      enabled: item['enabled'] === true,
      offscreen: item['offscreen'] === true,
      bounds,
      imageBounds,
      imageCenter,
      ...(Array.isArray(item['actions']) ? { actions: item['actions'] as UiActionName[] } : {}),
      ...(Number.isInteger(item['depth']) ? { depth: Math.min(50, Math.max(0, item['depth'])) } : {}),
      ...(typeof item['focused'] === 'boolean' ? { focused: item['focused'] } : {}),
      ...(typeof item['selected'] === 'boolean' ? { selected: item['selected'] } : {})
    };
  });
  const context: AccessibilityContext = {};
  let textBudget = 8000;
  for (const [source, target] of [['document_text', 'documentText'], ['selected_text', 'selectedText']] as const) {
    if (typeof reply[source] !== 'string' || !reply[source]) continue;
    context[target] = reply[source].slice(0, textBudget);
    textBudget -= context[target]!.length;
  }
  const focused = raw.findIndex(item => item['runtimeKey'] === reply['focused_element']);
  if (focused >= 0) context.focusedElement = elements[focused]!.ref;
  return { window: windowId, snapshotId, elements, ...(Object.keys(context).length > 0 ? { accessibility: context } : {}) };
}

export async function getWindowState(opts: {
  window?: number;
  query?: string;
  role?: string;
  maxWidth?: number;
  maxElements?: number;
  includeScreenshot?: boolean;
  includeUi?: boolean;
  includeRelated?: boolean;
}): Promise<{
  window: WindowInfo;
  snapshotId: number | null;
  screenshot: Screenshot | null;
  elements: UiElementInfo[];
  uiUnavailable: { code: string; message: string } | null;
  screenshotUnavailable?: { code: string; message: string };
  uiTruncated?: boolean;
  accessibility?: AccessibilityContext;
  related?: Array<{ window: WindowInfo; screenshot: Screenshot | null; error?: string }>;
}> {
  return exclusive(async () => {
    const includeScreenshot = opts.includeScreenshot !== false;
    const includeUi = opts.includeUi !== false;
    const limit = Math.min(MAX_SCREENSHOT_WIDTH, Math.max(320, Math.floor(opts.maxWidth ?? DEFAULT_SCREENSHOT_WIDTH)));
    const dir = includeScreenshot ? await fs.mkdtemp(path.join(os.tmpdir(), 'clf-shot-')) : null;
    const file = dir ? path.join(dir, 'screen.png') : null;
    try {
      // Capture targets, pixels, and UIA under one helper transaction to preserve a shared snapshot identity.
      const reply = await runHelper({
        op: 'snapshot',
        ...(opts.window === undefined ? {} : { id: opts.window }),
        includeScreenshot,
        includeUi,
        ...(opts.query === undefined ? {} : { query: opts.query }),
        ...(opts.role === undefined ? {} : { role: opts.role }),
        includeRelated: process.platform === 'win32' && opts.includeRelated === true,
        maxWidth: limit,
        maxResults: Math.min(100, Math.max(1, Math.floor(opts.maxElements ?? 60))),
        ...(file ? { file } : {})
      });
      const value = reply['window'];
      const window = value && typeof value === 'object' ? (value as WindowInfo) : null;
      if (!window) throw new ComputerError('WINDOW_NOT_FOUND: no matching visible window is available');
      const pixelFailure = reply['screenshotUnavailable'] as Record<string, unknown> | undefined;
      const screenshotUnavailable = includeScreenshot && includeUi && pixelFailure?.code === 'CAPTURE_FAILED' && typeof pixelFailure.message === 'string'
        ? { code: 'CAPTURE_FAILED', message: pixelFailure.message.slice(0, 500) } : undefined;
      const shot = file && !screenshotUnavailable ? await screenshotFromReply(reply, file, window.id) : null;
      const frame = shot ? frameById(shot.frameId) : null;
      const unavailableValue = reply['uiUnavailable'];
      const uiUnavailable =
        unavailableValue && typeof unavailableValue === 'object'
          ? {
              code: String((unavailableValue as Record<string, unknown>)['code'] ?? 'UI_UNAVAILABLE'),
              message: String((unavailableValue as Record<string, unknown>)['message'] ?? 'UI controls are unavailable')
            }
          : null;
      const found = includeUi && uiUnavailable === null
        ? await findUiLocked({ window: window.id, maxResults: opts.maxElements ?? 60 }, frame, reply)
        : { window: window.id, snapshotId: null, elements: [] as UiElementInfo[], accessibility: undefined };
      const related: Array<{ window: WindowInfo; screenshot: Screenshot | null; error?: string }> = [];
      if (process.platform === 'win32' && opts.includeRelated && !screenshotUnavailable && Array.isArray(reply['relatedWindows'])) {
        for (const relatedWindow of (reply['relatedWindows'] as WindowInfo[]).slice(0, 3)) {
          if (!Number.isSafeInteger(relatedWindow.id) || relatedWindow.id <= 0 || relatedWindow.id === window.id) continue;
          try {
            const relatedShot = includeScreenshot
              ? await screenshotLocked({ window: relatedWindow.id, ownerWindow: window.id, maxWidth: limit }, undefined,
                  { generation: generationOfReply(reply), code: 'STALE_FRAME' })
              : null;
            related.push({ window: relatedWindow, screenshot: relatedShot });
          } catch (err) {
            // Keep the main-window observation when a popup closes, and reject unrelated screen pixels.
            related.push({ window: relatedWindow, screenshot: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
          }
        }
      }
      return {
        window,
        snapshotId: found.snapshotId,
        screenshot: shot,
        elements: found.elements,
        uiUnavailable,
        ...(screenshotUnavailable ? { screenshotUnavailable } : {}),
        ...(includeUi && uiUnavailable === null && typeof reply['truncated'] === 'boolean' ? { uiTruncated: reply['truncated'] } : {}),
        ...(found.accessibility ? { accessibility: found.accessibility } : {}),
        ...(related.length > 0 ? { related } : {})
      };
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

