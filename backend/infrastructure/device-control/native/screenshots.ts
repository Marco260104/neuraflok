import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exclusive } from './operation-lock.js';
import { allocateFrameId, currentFrame, qualifiedFrame, rememberFrame } from './frame-store.js';
import type { Frame } from './frame-store.js';
import { logInfo } from '../../settings/logger.js';
import { ComputerError } from './errors.js';
import { generationOfReply, runHelper } from './transport.js';
import type { ExpectedHelper } from './transport.js';
import type { Rect, Screenshot } from './types.js';

/** Width the screenshot is scaled down to, matching computer-use convention. */
export const DEFAULT_SCREENSHOT_WIDTH = 1280;
export const MAX_SCREENSHOT_WIDTH = 2560;
/** Per-image ceiling; the final Desktop tool layer separately measures text + image together. */
export const MAX_SCREENSHOT_PNG_BYTES = Math.floor((((8 * 1024 * 1024) - (64 * 1024)) * 3) / 4);
/** Captures the primary monitor, every monitor, or one window. The helper does the downscaling while the bitmap is still in its hands, because a 4K screenshot is slow to encode, slow to base64 and harder for a model to point at accurately than a 1280-wide one. Nothing downstream ever wants the full-size image, so it is never produced. */
export async function screenshot(opts: {
  window?: number;
  full?: boolean;
  maxWidth?: number;
  /** Crop in pixels of the most recent returned screenshot. */
  crop?: Rect;
}): Promise<Screenshot> {
  return exclusive(() => screenshotLocked(opts));
}

export async function screenshotFromReply(
  reply: Record<string, any>,
  file: string,
  requestedWindow: number | null
): Promise<Screenshot> {
  const region = reply['region'] as Rect;
  const size = reply['image'] as { width: number; height: number };
  if (
    !region ||
    !size ||
    !Number.isFinite(region.x) ||
    !Number.isFinite(region.y) ||
    !Number.isFinite(region.width) ||
    !Number.isFinite(region.height) ||
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    region.width <= 0 ||
    region.height <= 0 ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new ComputerError('The desktop helper returned invalid screenshot geometry.');
  }
  const readStartedAt = Date.now();
  const fileInfo = await fs.stat(file).catch(() => {
    throw new ComputerError('The screen capture produced no image.');
  });
  if (fileInfo.size > MAX_SCREENSHOT_PNG_BYTES) {
    throw new ComputerError(
      `SCREENSHOT_TOO_LARGE: encoded PNG is ${fileInfo.size} bytes; limit ${MAX_SCREENSHOT_PNG_BYTES} bytes`
    );
  }
  const png = await fs.readFile(file).catch(() => {
    throw new ComputerError('The screen capture produced no image.');
  });
  if (png.length === 0) throw new ComputerError('The screen capture came back empty.');
  const readMs = Date.now() - readStartedAt;

  const rawMode = String(reply['captureMode'] ?? (requestedWindow === null ? 'screen' : 'screen_fallback'));
  const captureMode: Screenshot['captureMode'] =
    rawMode === 'window' || rawMode === 'screen_fallback' ? rawMode : 'screen';
  // Only a true window capture can authorize input against that window; fallback pixels stay screen-bound.
  const frameWindow = captureMode === 'window' ? requestedWindow : null;
  const scale = size.width / region.width;
  const replyWindowGeometry = reply['windowGeometry'] as Rect | undefined;
  const rawDisplays = reply['displays'];
  const displayTopology = Array.isArray(rawDisplays) && rawDisplays.length > 0 && rawDisplays.every((value) =>
    value &&
    typeof value === 'object' &&
    Number.isFinite((value as Rect).x) &&
    Number.isFinite((value as Rect).y) &&
    Number.isFinite((value as Rect).width) &&
    Number.isFinite((value as Rect).height) &&
    (value as Rect).width > 0 &&
    (value as Rect).height > 0
  )
    ? (rawDisplays as Rect[]).map((value) => ({ ...value }))
    : null;
  if (process.platform === 'darwin' && frameWindow === null && !displayTopology) {
    throw new ComputerError('The macOS desktop helper returned a screen frame without exact display topology.');
  }
  const frame: Frame = {
    id: allocateFrameId(),
    helperGeneration: generationOfReply(reply),
    region,
    scale,
    width: size.width,
    height: size.height,
    windowId: frameWindow,
    windowGeometry: frameWindow === null ? null : replyWindowGeometry ?? { ...region },
    displayTopology: frameWindow === null ? displayTopology : null,
    captureMode
  };
  rememberFrame(frame);
  const encodeStartedAt = Date.now();
  const data = png.toString('base64');
  logInfo(
    `desktop timing screenshot_read_ms=${readMs} screenshot_base64_ms=${Date.now() - encodeStartedAt} screenshot_bytes=${png.length}`
  );
  return {
    data,
    frameId: frame.id,
    width: frame.width,
    height: frame.height,
    region: frame.region,
    scale: frame.scale,
    focused: requestedWindow === null ? null : reply['focused'] === true,
    captureMode,
    windowId: frame.windowId
  };
}

/** @param cropFrame Frame a crop is expressed in. Callers that ran something between the frame the model saw and this capture pass it explicitly; everyone else means the current one. */
export async function screenshotLocked(
  opts: {
    window?: number;
    /** Native capture rechecks the exact ownership of a related menu/popup. */
    ownerWindow?: number;
    full?: boolean;
    maxWidth?: number;
    crop?: Rect;
  },
  cropFrame?: Frame | null,
  expected?: ExpectedHelper
): Promise<Screenshot> {
  if (opts.crop && (opts.window !== undefined || opts.full === true)) {
    throw new ComputerError('crop cannot be combined with window or full capture');
  }

  let cropRegion: Rect | undefined;
  if (opts.crop) {
    const source = cropFrame === undefined ? currentFrame() : cropFrame;
    const frame = qualifiedFrame(source);
    if (source && !frame) throw new ComputerError('STALE_FRAME: take a new screenshot before cropping.');
    if (!frame) throw new ComputerError('Take a screenshot first — crop coordinates refer to the most recent frame.');
    expected = { generation: frame.helperGeneration, code: 'STALE_FRAME' };
    const crop = {
      x: Math.floor(opts.crop.x),
      y: Math.floor(opts.crop.y),
      width: Math.floor(opts.crop.width),
      height: Math.floor(opts.crop.height)
    };
    if (crop.width <= 0 || crop.height <= 0) throw new ComputerError('crop width and height must be positive');
    if (
      crop.x < 0 ||
      crop.y < 0 ||
      crop.x + crop.width > frame.width ||
      crop.y + crop.height > frame.height
    ) {
      throw new ComputerError(
        `crop must fit inside frame ${frame.id} (${frame.width}x${frame.height})`
      );
    }
    const left = Math.round(frame.region.x + crop.x / frame.scale);
    const top = Math.round(frame.region.y + crop.y / frame.scale);
    const right = Math.round(frame.region.x + (crop.x + crop.width) / frame.scale);
    const bottom = Math.round(frame.region.y + (crop.y + crop.height) / frame.scale);
    cropRegion = {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top)
    };
  }

  // Crops preserve the source frame pixel density unless an explicit width is requested.
  const requestedWidth =
    opts.maxWidth ?? (opts.crop ? Math.max(1, Math.floor(opts.crop.width)) : DEFAULT_SCREENSHOT_WIDTH);
  const limit = Math.min(
    MAX_SCREENSHOT_WIDTH,
    opts.crop && opts.maxWidth === undefined
      ? Math.max(1, requestedWidth)
      : Math.max(320, Math.floor(requestedWidth))
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-shot-'));
  const file = path.join(dir, 'screen.png');
  try {
    const reply = await runHelper({
      op: 'capture',
      file,
      maxWidth: limit,
      ...(cropRegion === undefined ? {} : { region: cropRegion }),
      ...(opts.window === undefined ? {} : { id: opts.window }),
      ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
      ...(opts.full === true ? { full: true } : {})
    }, expected);
    // Crops use visible screen pixels and stay screen-bound so occluders cannot authorize window input.
    return await screenshotFromReply(reply, file, opts.crop ? null : opts.window ?? null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

