export type DockAxis = 'x' | 'y';

type TrackProperty = 'gridTemplateColumns' | 'gridTemplateRows';
type TransitionTiming = { duration: number; easing: string };
type ActiveMotion = { animation: Animation; axis: DockAxis; heldSize: number; cleanup: () => void };

const GRID_PROPERTY: Record<DockAxis, TrackProperty> = { x: 'gridTemplateColumns', y: 'gridTemplateRows' };
const APPEAR_TIMING: TransitionTiming = { duration: 320, easing: 'cubic-bezier(.22, 1, .36, 1)' };
const DISAPPEAR_TIMING: TransitionTiming = { duration: 240, easing: 'cubic-bezier(.4, 0, .2, 1)' };
const activeMotions = new WeakMap<HTMLElement, ActiveMotion>();

function gridTrackSizes(host: HTMLElement, axis: DockAxis): number[] {
  const view = host.ownerDocument.defaultView;
  const serialized = view?.getComputedStyle(host)[GRID_PROPERTY[axis]] ?? '';
  return serialized.split(/\s+/).map(value => Number.parseFloat(value)).filter(Number.isFinite);
}

function shouldAnimate(host: HTMLElement, axis: DockAxis): boolean {
  const view = host.ownerDocument.defaultView;
  const reduced = view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const compact = view?.matchMedia?.('(max-width: 850px)').matches ?? false;
  return typeof host.animate === 'function' && host.getClientRects().length > 0 && !reduced && !(axis === 'x' && compact);
}

function pairTracks(start: number[], end: number[]): [number[], number[]] | null {
  if (start.length + 1 === end.length) start = [...start, 0];
  if (end.length + 1 === start.length) end = [...end, 0];
  return start.length === end.length ? [start, end] : null;
}

function tracksChanged(start: number[], end: number[], dockIndex: number, bodyIndex: number): boolean {
  return Math.abs(start[dockIndex]! - end[dockIndex]!) > 0.5 ||
    Math.abs(start[bodyIndex]! - end[bodyIndex]!) > 0.5;
}

function motionFrame(property: TrackProperty, sizes: number[]): Keyframe {
  return { [property]: sizes.map(size => `${size}px`).join(' ') };
}

function finishMotion(host: HTMLElement, pane: HTMLElement, fade: Animation | null, settled?: () => void): () => void {
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    fade?.cancel();
    pane.classList.remove('is-moving', 'is-sliding');
    pane.style.removeProperty('--work-dock-motion-size');
    host.classList.remove('is-dock-handover');
    host.style.removeProperty('--chat-motion-width');
    if (pane.hidden) pane.classList.remove('is-closing');
    settled?.();
  };
}

function prepareHandover(host: HTMLElement, bodyIndex: number, start: number[], end: number[]): HTMLElement | null {
  const chat = host.querySelector<HTMLElement>(':scope > .is-session');
  const transfer = !!chat && Math.min(start[bodyIndex]!, end[bodyIndex]!) < 1 && Math.min(start.at(-1)!, end.at(-1)!) >= 1;
  if (!transfer || !chat) return null;
  host.classList.add('is-dock-handover');
  host.style.setProperty('--chat-motion-width', `${Math.max(start[bodyIndex]!, end[bodyIndex]!)}px`);
  return chat;
}

function animateDock(host: HTMLElement, pane: HTMLElement, axis: DockAxis, start: number[], end: number[], heldSize: number, shownBefore: boolean, shownAfter: boolean, settled?: () => void): void {
  const property = GRID_PROPERTY[axis];
  const dockIndex = end.length - 1;
  const bodyIndex = dockIndex - 1;
  const sliding = shownBefore !== shownAfter || heldSize > 0;
  const travelSize = sliding ? Math.max(heldSize, start[dockIndex]!, end[dockIndex]!) : 0;
  const closing = shownBefore && !shownAfter;
  const timing = closing ? DISAPPEAR_TIMING : APPEAR_TIMING;

  if (closing) pane.classList.add('is-closing');
  pane.classList.add('is-moving');
  if (sliding) {
    pane.classList.add('is-sliding');
    pane.style.setProperty('--work-dock-motion-size', `${travelSize}px`);
  }

  const chat = axis === 'x' ? prepareHandover(host, bodyIndex, start, end) : null;
  const fade = chat?.animate ? chat.animate([
    { opacity: start[bodyIndex]! < 1 ? 0 : 1 },
    { opacity: end[bodyIndex]! < 1 ? 0 : 1 }
  ], { duration: timing.duration * (end[bodyIndex]! < 1 ? 0.6 : 1), easing: timing.easing, fill: 'forwards' }) : null;
  const animation = host.animate([motionFrame(property, start), motionFrame(property, end)], timing);
  const cleanup = finishMotion(host, pane, fade, settled);
  const active: ActiveMotion = { animation, axis, heldSize: travelSize, cleanup };
  activeMotions.set(host, active);
  void animation.finished.catch(() => undefined).then(() => {
    if (activeMotions.get(host) !== active) return;
    activeMotions.delete(host);
    animation.cancel();
    cleanup();
  });
}

export function moveWorkDock(host: HTMLElement, pane: HTMLElement, change: () => void, settled?: () => void, axis: DockAxis = 'x'): void {
  const previous = activeMotions.get(host);
  const start = gridTrackSizes(host, axis);
  previous?.animation.cancel();
  previous?.cleanup();
  activeMotions.delete(host);

  const heldSize = previous?.axis === axis ? previous.heldSize : 0;
  const shownBefore = !pane.hidden;
  change();
  const shownAfter = !pane.hidden;
  pane.inert = !shownAfter;
  const paired = pairTracks(start, gridTrackSizes(host, axis));
  if (!paired || !shouldAnimate(host, axis)) {
    pane.classList.remove('is-closing');
    settled?.();
    return;
  }

  const [from, to] = paired;
  const dockIndex = to.length - 1;
  const bodyIndex = dockIndex - 1;
  if (bodyIndex < 0 || !tracksChanged(from, to, dockIndex, bodyIndex)) {
    pane.classList.remove('is-closing');
    settled?.();
    return;
  }

  animateDock(host, pane, axis, from, to, heldSize, shownBefore, shownAfter, settled);
}
