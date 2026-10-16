import type { Chronological } from './types.js';
import { authoredTimeOf } from './projection.js';
import { positionOf } from './position.js';

/** Events observed in one page read are simultaneous within this tolerance. */
const SAME_READ_MS = 50;
/** Maximum local-bridge transit allowance for browser-provider tool calls. */
const CALL_TRANSIT_MS = 1_000;

/** Places the final assistant message at the end of its turn even when its opening timestamp precedes later tool observations. */
function closing<T extends Chronological>(group: readonly T[]): T | null {
  let found: T | null = null;
  for (const entry of group) {
    if (entry.kind !== 'assistant_message') continue;
    if (entry.final !== true && entry.state !== 'final') continue;
    if (!found || positionOf(entry) > positionOf(found)) found = entry;
  }
  return found;
}

/** Deterministically orders one event window without mutating it. */
export function chronological<T extends Chronological>(entries: readonly T[]): T[] {
  const position = (entry: T): number => positionOf(entry);
  const bySeq = [...entries].sort((a, b) => position(a) - position(b) || a.seq - b.seq);
  // Retain durable turn anchors across page windows; older projections use only observed boundaries.
  const anchors = new Map<string, number>();
  // Record each turn end so untagged events can be assigned to the correct window.
  const ends = new Map<number, number>();
  for (const entry of bySeq) {
    // Later exact turn proofs may move the durable anchor earlier.
    if (entry.turnId && Number.isFinite(entry.turnOrigin))
      anchors.set(entry.turnId, Math.min(anchors.get(entry.turnId) ?? Infinity, entry.turnOrigin!));
    if (entry.kind === 'turn_start' && entry.turnId && !anchors.has(entry.turnId)) {
      anchors.set(entry.turnId, position(entry));
    }
  }
  for (const entry of bySeq) {
    if (entry.kind === 'turn_end' && entry.turnId) {
      const anchor = anchors.get(entry.turnId);
      if (anchor !== undefined) ends.set(anchor, Math.max(ends.get(anchor) ?? 0, entry.time));
    }
  }

  // Turn boundaries outrank observation times when ordering starts, ends, and final messages.
  const rank = (entry: T, ends: T | null): number =>
    entry.kind === 'turn_start' ? -1 : entry.kind === 'turn_end' ? 1 : entry === ends ? 0.5 : 0;

  // Page-native activity precedes its authored paragraph when observation and provider transit times overlap.
  const readBefore = new Map<T, number>();
  const placeBefore = (group: readonly T[]): void => {
    const paragraphs = group.filter(entry => entry.kind === 'assistant_message' && authoredTimeOf(entry) !== undefined)
      .sort((a, b) => position(a) - position(b) || a.seq - b.seq);
    // Only activity observed during a live turn can move before its authored prose.
    const live = paragraphs.filter(entry => group.some(later => later.kind !== 'turn_end' && later.time > entry.time))
      .sort((a, b) => authoredTimeOf(a)! - authoredTimeOf(b)!);
    for (const work of group) {
      if ((work.kind !== 'page_tool' && work.kind !== 'tool_call') || authoredTimeOf(work) !== undefined) continue;
      // Keep each page-native step with the paragraph whose reading exposed it.
      const prose = work.kind === 'page_tool'
        ? paragraphs.find(entry => position(entry) > position(work) && authoredTimeOf(entry)! < work.time && work.time <= entry.time + SAME_READ_MS)
        : live.find(entry => authoredTimeOf(entry)! < work.time && work.time <= authoredTimeOf(entry)! + CALL_TRANSIT_MS);
      if (!prose) continue;
      // A shared scale preserves order among events moved before the same paragraph.
      const opened = authoredTimeOf(prose)!, span = Math.max(prose.time + SAME_READ_MS, opened + CALL_TRANSIT_MS) - opened;
      // Place the event strictly between preceding work and the paragraph.
      readBefore.set(work, opened - 1 + 0.9 * (work.time - opened) / span);
    }
  };

  // Missing timestamps fall back to stable position because they provide no chronological evidence.
  const byTime = (a: T, b: T): number => {
    const apart = (readBefore.get(a) ?? authoredTimeOf(a) ?? a.time) - (readBefore.get(b) ?? authoredTimeOf(b) ?? b.time);
    return Number.isFinite(apart) && apart !== 0
      ? apart
      : position(a) - position(b) || a.seq - b.seq;
  };

  const groups = new Map<number, T[]>();
  // Carry open-turn anchors forward in one pass to keep untagged-event inference linear.
  let activeAnchor: number | undefined;
  let pendingAnchor: number | undefined;
  let currentPosition: number | undefined;
  for (const entry of bySeq) {
    const entryPosition = position(entry);
    if (currentPosition === undefined || entryPosition !== currentPosition) {
      if (pendingAnchor !== undefined) activeAnchor = pendingAnchor;
      pendingAnchor = undefined;
      currentPosition = entryPosition;
    }
    let inferredAnchor: number | undefined;
    if (entry.turnOrigin !== null && !entry.turnId && entry.kind !== 'user_message' && activeAnchor !== undefined) {
      const end = ends.get(activeAnchor);
      if (end === undefined || entry.time <= end) inferredAnchor = activeAnchor;
    }
    const anchor = (entry.turnId ? anchors.get(entry.turnId) : undefined) ?? entry.turnOrigin ?? inferredAnchor ?? entryPosition;
    const held = groups.get(anchor);
    if (held) held.push(entry);
    else groups.set(anchor, [entry]);
    if (entry.kind === 'turn_start' && entry.turnId) pendingAnchor = anchors.get(entry.turnId);
  }

  const out: T[] = [];
  for (const anchor of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(anchor)!;
    const ends = closing(group);
    placeBefore(group);
    group.sort((a, b) => rank(a, ends) - rank(b, ends) || byTime(a, b));
    out.push(...group);
  }
  return out;
}
