import { exclusive } from './operation-lock.js';
import { activeWindow } from './window-queries.js';
import { currentFrame, frameById, qualifiedFrame } from './frame-store.js';
import { ComputerError } from './errors.js';
import { assertHelperGeneration, currentHelperGeneration, generationOfReply, runHelper } from './transport.js';
import type { ExpectedHelper } from './transport.js';
import type { Action, ActionResult, Rect, Screenshot, VerificationResult, VerificationSpec } from './types.js';
import { screenshotLocked } from './observations.js';
import { createActionMapper } from './action-mapping.js';
import { electronClipboard, localActionFailure } from './action-local-operations.js';
import { verifyDesktopLocked } from './action-verification.js';
import { validateActionBatch, type ActionOptions } from './action-validation.js';
/** Performs a batch of actions. Image coordinates are converted to screen coordinates against the region the last screenshot showed, so the model can point at what it saw without knowing anything about monitor layout or scaling. */


export async function act(
  actions: Action[],
  opts: { frameId?: number; window?: number; ownerWindow?: number; app?: string; ownerApp?: string } = {}
): Promise<ActionResult> {
  return exclusive(() => actLocked(actions, opts));
}

/** Acts and then verifies, as one indivisible operation. Doing this as act() followed by screenshot() takes the lock twice, and another chat or agent can focus a window, click, or capture in the gap — so the "after" picture could show someone else's result. That would defeat the only reason to ask for a capture in the same call. The crop is resolved against the frame that was current before the actions ran, which is the one whose coordinates the caller was looking at. */
export async function actAndCapture(
  actions: Action[],
  opts: {
    frameId?: number;
    /** Windows physical input is activated and checked against this exact window. */
    window?: number;
    ownerWindow?: number;
    app?: string;
    ownerApp?: string;
    capture?: {
      window?: number;
      full?: boolean;
      maxWidth?: number;
      crop?: Rect;
      /** Privacy mode: capture whatever window is in front once the actions have run. */
      preferActiveWindow?: boolean;
    };
    verify?: VerificationSpec;
  } = {}
): Promise<ActionResult & { screenshot: Screenshot | null; verification: VerificationResult | null }> {
  return exclusive(async () => {
    const before = opts.frameId === undefined ? qualifiedFrame(currentFrame()) : frameById(opts.frameId);
    // Bind capture crops to the supplied frame because another chat may replace the current frame.
    if (opts.capture?.crop) {
      if (opts.frameId === undefined) {
        throw new ComputerError(
          'FRAME_REQUIRED: captureCrop must include the frameId returned with the screenshot its coordinates came from.'
        );
      }
      if (!before) {
        throw new ComputerError(
          `STALE_FRAME: captureCrop is for frame ${opts.frameId}, but that frame is no longer retained. Take a new screenshot and crop that frame.`
        );
      }
    }
    const result = await actLocked(actions, opts);
    let verification: VerificationResult | null = null;
    if (opts.verify) {
      try {
        verification = await verifyDesktopLocked(opts.verify);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ComputerError(
          `POSTCONDITION_FAILED: completed_count=${result.completedCount}. ${message}`,
          { completedCount: result.completedCount, failedIndex: result.completedCount, completedRoutes: result.routes }
        );
      }
    }
    if (!opts.capture) return { ...result, screenshot: null, verification };

    try {
      const { preferActiveWindow, ...capture } = opts.capture;
      // Resolve the output capture under the action lock and preserve an explicit target window.
      if (capture.window === undefined && capture.full !== true && capture.crop === undefined) {
        capture.window = opts.window ?? (preferActiveWindow ? (await activeWindow()).window?.id : undefined);
      }
      return { ...result, screenshot: await screenshotLocked(capture, before), verification };
    } catch (err) {
      throw new ComputerError(
        `CAPTURE_AFTER_FAILED: completed_count=${result.completedCount}. ${err instanceof Error ? err.message : String(err)}. Observe again; do not repeat completed actions.`,
        { completedCount: result.completedCount, failedIndex: result.completedCount, completedRoutes: result.routes }
      );
    }
  });
}

async function actLocked(
  actions: Action[],
  opts: ActionOptions
): Promise<ActionResult> {
  const { frame, requestedFrame, needsFrame, uiTargets } = validateActionBatch(actions, opts);
  const clampMappedCoordinate = (mapped: number, origin: number, extent: number): number => {
    const lower = Math.ceil(origin);
    const upper = Math.max(lower, Math.ceil(origin + extent) - 1);
    return Math.min(upper, Math.max(lower, mapped));
  };
  const toScreenX = (x: number): number =>
    clampMappedCoordinate(Math.round(frame.region.x + x / frame.scale), frame.region.x, frame.region.width);
  const toScreenY = (y: number): number =>
    clampMappedCoordinate(Math.round(frame.region.y + y / frame.scale), frame.region.y, frame.region.height);

  const mapOne = createActionMapper(uiTargets, toScreenX, toScreenY);

  // Flush native batches at each local clipboard step to preserve order under one lock.
  const clipboard: string[] = [];
  const routes: ActionResult['routes'] = [];
  let completedCount = 0;
  // Pin the validated helper generation across native segments, including those after local waits.
  const expected: ExpectedHelper | undefined = needsFrame || uiTargets.size > 0
    ? { generation: currentHelperGeneration(), code: uiTargets.size > 0 ? 'STALE_REF' : 'STALE_FRAME' }
    : undefined;
  let batch: ReturnType<typeof mapOne>[] = [];
  let batchIndices: number[] = [];
  let reply: Record<string, any> | null = null;
  let helperUsed = false;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const sending = batch;
    const sendingIndices = batchIndices;
    batch = [];
    batchIndices = [];
    try {
      reply = await runHelper({
        op: 'act',
        actions: sending,
        ...(opts.window === undefined ? {} : { targetWindow: opts.window }),
        ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
        ...(opts.app === undefined ? {} : { targetApp: opts.app }),
        ...(opts.ownerApp === undefined ? {} : { ownerApp: opts.ownerApp }),
        ...(needsFrame
          ? {
              frame: {
                id: frame.id,
                window: frame.windowId,
                ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
                ...(opts.app === undefined ? {} : { targetApp: opts.app }),
                ...(opts.ownerApp === undefined ? {} : { ownerApp: opts.ownerApp }),
                region: frame.region,
                windowGeometry: frame.windowGeometry,
                displays: frame.displayTopology,
                captureMode: frame.captureMode
              }
            }
          : {})
      }, expected);
      helperUsed = true;
      const helperRoutes = Array.isArray(reply['routes']) ? reply['routes'].map(String) : [];
      for (let index = 0; index < sending.length; index++) {
        const route = helperRoutes[index];
        routes.push(route === 'uia' || route === 'focus' || route === 'shell' ? route : 'sendinput');
      }
      completedCount += sending.length;
    } catch (err) {
      const partial = err instanceof ComputerError ? (err.completedCount ?? 0) : 0;
      const failedBatchIndex = err instanceof ComputerError ? (err.failedIndex ?? partial) : partial;
      const helperRoutes = err instanceof ComputerError ? err.completedRoutes : null;
      const hasExactPartialRoutes = helperRoutes !== null && helperRoutes.length === partial;
      if (hasExactPartialRoutes) routes.push(...helperRoutes);
      const totalCompleted = completedCount + partial;
      const originalFailed = sendingIndices[failedBatchIndex] ?? sendingIndices[partial] ?? totalCompleted;
      const message = err instanceof Error ? err.message : String(err);
      const exactRoutes = hasExactPartialRoutes ? [...routes] : null;
      const routeEvidence = exactRoutes
        ? exactRoutes.length > 0
          ? exactRoutes.join('+')
          : 'none'
        : 'unavailable';
      throw new ComputerError(
        `PARTIAL_BATCH: completed_count=${totalCompleted} failed_index=${originalFailed} routes=${routeEvidence}. ${message}`,
        {
          completedCount: totalCompleted,
          failedIndex: originalFailed,
          ...(exactRoutes ? { completedRoutes: exactRoutes } : {})
        }
      );
    }
  };
  for (const [index, action] of actions.entries()) {
    if (action.type === 'paste') {
      await flush();
      try {
        // Require the selected target to be active before publishing clipboard contents.
        await runHelper({ op: 'act', actions: [{ type: 'focus', window: opts.window }],
          targetWindow: opts.window,
          ...(opts.app === undefined ? {} : { targetApp: opts.app }),
          ...(opts.ownerWindow === undefined ? {} : { ownerWindow: opts.ownerWindow }),
          ...(opts.ownerApp === undefined ? {} : { ownerApp: opts.ownerApp }) }, expected);
        // Electron publishes clipboard data, then one native paste targets the selected window.
        const nativeClipboard = await electronClipboard();
        assertHelperGeneration(currentHelperGeneration(), expected);
        await nativeClipboard.writeText(action.text);
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      batch.push({ type: 'keypress', keys: ['ctrl', 'v'] });
      batchIndices.push(index);
      try {
        await flush();
      } catch (err) {
        const partial = err instanceof ComputerError ? err : null;
        throw new ComputerError(
          `${err instanceof Error ? err.message : String(err)}. Clipboard text was replaced; paste delivery is not confirmed.`,
          { completedCount: partial?.completedCount ?? completedCount, failedIndex: partial?.failedIndex ?? index,
            ...(partial?.completedRoutes ? { completedRoutes: partial.completedRoutes } : {}) }
        );
      }
      continue;
    }
    if (action.type === 'wait') {
      await flush();
      const ms = Math.min(10_000, Math.max(0, action.ms ?? 2000));
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      routes.push('local');
      completedCount += 1;
      continue;
    }
    if (action.type === 'read_clipboard') {
      await flush();
      try {
        const nativeClipboard = await electronClipboard();
        assertHelperGeneration(currentHelperGeneration(), expected);
        clipboard.push(await nativeClipboard.readText());
        assertHelperGeneration(currentHelperGeneration(), expected);
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      routes.push('local');
      completedCount += 1;
      continue;
    }
    if (action.type === 'write_clipboard') {
      await flush();
      try {
        const nativeClipboard = await electronClipboard();
        assertHelperGeneration(currentHelperGeneration(), expected);
        await nativeClipboard.writeText(action.text);
      } catch (err) {
        throw localActionFailure(err, completedCount, index);
      }
      routes.push('local');
      completedCount += 1;
      continue;
    }
    batch.push(mapOne(action));
    batchIndices.push(index);
  }
  // Keep clipboard-only batches usable without the native helper; mixed batches report the final cursor.
  if (batch.length > 0) {
    await flush();
  } else if (helperUsed) {
    reply = await runHelper({ op: 'cursor' });
  }

  if (reply === null) return { cursor: null, clipboard, completedCount, routes };

  const raw = reply['cursor'] as { x?: unknown; y?: unknown } | undefined;
  const sx = Number(raw?.x);
  const sy = Number(raw?.y);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
    throw new ComputerError('The desktop helper returned an invalid pointer position.');
  }
  const current = qualifiedFrame(requestedFrame ?? currentFrame(), generationOfReply(reply));
  const image = current
    ? {
        x: Math.round((sx - current.region.x) * current.scale),
        y: Math.round((sy - current.region.y) * current.scale)
      }
    : null;
  return {
    cursor: {
      screen: { x: sx, y: sy },
      image,
      frameId: current?.id ?? null,
      imageSize: current ? { width: current.width, height: current.height } : null
    },
    clipboard,
    completedCount,
    routes
  };
}

