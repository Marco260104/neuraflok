import { ComputerError } from './errors.js';
import { currentHelperGeneration, isHelperGenerationActive } from './transport.js';
import type { Rect, Screenshot } from './types.js';

const MAX_FRAMES = 16;

/** Binds each screenshot's coordinate space to the helper generation that produced it. */
export interface Frame {
  id: number;
  helperGeneration: number;
  region: Rect;
  scale: number;
  width: number;
  height: number;
  windowId: number | null;
  windowGeometry: Rect | null;
  displayTopology: Rect[] | null;
  captureMode: Screenshot['captureMode'];
}

let nextId = 1;
let latest: Frame | null = null;
const frames = new Map<number, Frame>();
const uiRefs = new Map<string, { window: number; runtimeKey: string; generation: number; snapshotId: number }>();

export function allocateFrameId(): number {
  return nextId++;
}

export function clearFrameStore(): void {
  uiRefs.clear();
  frames.clear();
  latest = null;
}

export function currentFrame(): Frame | null {
  return latest;
}

export function frameCount(): number {
  return frames.size;
}

export function rememberUiRef(window: number, runtimeKey: string, index: number, snapshotId: number, generation: number): string {
  const ref = `g${generation}_s${snapshotId}_e${index + 1}`;
  uiRefs.set(ref, { window, runtimeKey, generation, snapshotId });
  while (uiRefs.size > 1000) {
    const oldest = uiRefs.keys().next().value as string | undefined;
    if (!oldest) break;
    uiRefs.delete(oldest);
  }
  return ref;
}

export function uiTarget(ref: string): { window: number; runtimeKey: string; snapshotId: number } {
  const target = uiRefs.get(ref);
  if (!target) {
    throw new ComputerError(
      `UNKNOWN_UI_REF: ${ref}. Call get_window_state or find_ui again and use a ref from that reply.`
    );
  }
  if (!isHelperGenerationActive(target.generation)) {
    throw new ComputerError(
      `STALE_REF: ${ref} was issued by a desktop helper that is no longer active, so it no longer identifies anything. Call get_window_state again and use a ref from that reply.`
    );
  }
  return target;
}

export function rememberFrame(frame: Frame): void {
  frames.set(frame.id, frame);
  latest = frame;
  while (frames.size > MAX_FRAMES) {
    const oldest = frames.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    frames.delete(oldest);
  }
}

export function qualifiedFrame(frame: Frame | null, generation = currentHelperGeneration()): Frame | null {
  return frame && frame.helperGeneration === generation && isHelperGenerationActive(generation) ? frame : null;
}

export function frameById(id: number | undefined): Frame | null {
  return qualifiedFrame(id === undefined ? null : (frames.get(id) ?? null));
}
