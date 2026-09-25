import { frameById, frameCount, qualifiedFrame, currentFrame, uiTarget } from './frame-store.js';
import { ComputerError } from './errors.js';
import type { Frame } from './frame-store.js';
import type { Action } from './types.js';

export interface ActionOptions {
  frameId?: number;
  window?: number;
  ownerWindow?: number;
  app?: string;
  ownerApp?: string;
}

export type UiActionTarget = { window: number; runtimeKey: string; snapshotId: number };

export interface ValidatedActionBatch {
  frame: Frame;
  requestedFrame: Frame | null;
  needsFrame: boolean;
  uiTargets: Map<string, UiActionTarget>;
}

export function validateActionBatch(actions: Action[], opts: ActionOptions): ValidatedActionBatch {
  if (process.platform !== 'win32' && actions.some(action => action.type === 'paste' || action.type === 'launch_app' || action.type === 'ui_action')) {
    throw new ComputerError('ACTION_UNSUPPORTED: paste, launch_app and ui_action are currently Windows only.');
  }
  if (actions.some(action => action.type === 'paste') && opts.window === undefined) {
    throw new ComputerError('WINDOW_REQUIRED: paste needs an explicit target window.');
  }
  const firstPaste = actions.findIndex(action => action.type === 'paste');
  if (firstPaste >= 0 && actions.slice(firstPaste + 1).some(action => action.type === 'paste' || action.type === 'write_clipboard')) {
    throw new ComputerError('PASTE_SEQUENCE: observe the first paste result before replacing clipboard text again; queued Ctrl+V does not prove the app consumed it.');
  }
  if (opts.window !== undefined) {
    if (process.platform !== 'win32') throw new ComputerError('WINDOW_TARGET_UNSUPPORTED: window-scoped input is currently Windows only.');
    if (!Number.isSafeInteger(opts.window) || opts.window <= 0) throw new ComputerError('INVALID_WINDOW: expected a window id from observe.');
    if (actions.some(action => action.type === 'focus' && action.window !== opts.window)) {
      throw new ComputerError('WINDOW_MISMATCH: focus must name the same window as the input target.');
    }
  }
  if (opts.ownerWindow !== undefined && (process.platform !== 'win32' || opts.window === undefined ||
      !Number.isSafeInteger(opts.ownerWindow) || opts.ownerWindow <= 0 || opts.ownerWindow === opts.window)) {
    throw new ComputerError('INVALID_WINDOW: popup input requires distinct exact popup and owner windows.');
  }

  const pointing = new Set(['move', 'click', 'double_click', 'scroll', 'drag']);
  const needsFrame = actions.some(action => pointing.has(action.type));
  if (needsFrame && frameCount() === 0) {
    throw new ComputerError('Take a screenshot first — pointing needs a picture to point at.');
  }
  if (needsFrame && opts.frameId === undefined) {
    throw new ComputerError(
      'FRAME_REQUIRED: coordinate actions must include the frameId returned with the screenshot they came from.'
    );
  }

  const requestedFrame = frameById(opts.frameId);
  if (needsFrame && !requestedFrame) {
    throw new ComputerError(
      `STALE_FRAME: frame ${opts.frameId} is no longer retained. Take a screenshot or call get_window_state again and point at the new frame.`
    );
  }
  if (needsFrame && opts.window !== undefined && requestedFrame?.windowId !== opts.window) {
    throw new ComputerError('WINDOW_MISMATCH: coordinates must come from a screenshot of the input target window. Observe that window again.');
  }

  const frame = requestedFrame ?? qualifiedFrame(currentFrame()) ?? {
    id: 0,
    helperGeneration: 0,
    region: { x: 0, y: 0, width: 1, height: 1 },
    scale: 1,
    width: 1,
    height: 1,
    windowId: null,
    windowGeometry: null,
    displayTopology: null,
    captureMode: 'screen' as const
  };

  if (needsFrame) {
    const assertPointInFrame = (x: number, y: number, label: string): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
        throw new ComputerError(
          `OUT_OF_FRAME: ${label} (${x},${y}) is outside frame ${frame.id} (${frame.width}x${frame.height}). Take a screenshot that includes the target and use coordinates inside that image.`
        );
      }
    };
    for (const action of actions) {
      switch (action.type) {
        case 'move':
        case 'click':
        case 'double_click':
        case 'scroll':
          assertPointInFrame(action.x, action.y, action.type);
          break;
        case 'drag':
          action.path.forEach((point, index) => assertPointInFrame(point.x, point.y, `drag point ${index + 1}`));
          break;
        default:
          break;
      }
    }
  }

  const uiTargets = new Map<string, UiActionTarget>();
  for (const action of actions) {
    if (action.type !== 'click_ref' && action.type !== 'set_value' && action.type !== 'ui_action') continue;
    if (!uiTargets.has(action.ref)) uiTargets.set(action.ref, uiTarget(action.ref));
    if (opts.window !== undefined && uiTargets.get(action.ref)!.window !== opts.window) {
      throw new ComputerError('WINDOW_MISMATCH: the accessibility ref belongs to a different input target window.');
    }
  }

  return { frame, requestedFrame, needsFrame, uiTargets };
}
